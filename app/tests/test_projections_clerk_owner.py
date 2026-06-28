"""Phase 2/3 integration — the projections router honors a Clerk owner identity.

Gated on ``CLERK_ENABLED`` (ship dark): with the flag OFF a Clerk JWT is just an
unrecognized bearer and the capability flow is byte-for-byte unchanged. With it ON,
a verified Clerk owner can create/list/own their projections; cross-owner isolation
holds across BOTH key types; and the API stays COOKIE-BLIND (a cookie never auths).
"""
import pytest
from fastapi.testclient import TestClient

import app.clerk.verify as clerkverify
from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore
from app.tests.clerk_testkit import TEST_AZP, TEST_ISSUER, make_keypair, mint, stub_for

VALID_BODY = {
    "name": "House of Hope",
    "inputs": {
        "org_name": "House of Hope",
        "city": "Longview, Texas",
        "opening_status": "pre_launch",
        "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
        "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
        "source_of_funds": "300000", "occupancy_annual": "120000",
        "lease_type": "nnn", "nnn_opex_annual": "0",
    },
    "trade_area": {"basis": "city", "households": "31798"},
    "assumptions": {"labor_pct": "0.60"},
}


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


@pytest.fixture()
def client(store):
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


@pytest.fixture()
def priv(monkeypatch):
    """Generate a keypair, stub the JWKS (no network), and turn Clerk ON in env."""
    p, pub = make_keypair()
    monkeypatch.setattr(clerkverify, "_get_jwks_client", lambda issuer: stub_for(pub))
    monkeypatch.setenv("CLERK_ENABLED", "1")
    monkeypatch.setenv("CLERK_JWT_ISSUER", TEST_ISSUER)
    monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", TEST_AZP)
    return p


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


# ---- create + list as a Clerk owner ----------------------------------------
def test_clerk_owner_create_and_list(client, store, priv):
    jwt_a = mint(priv, sub="user_a")
    r = client.post("/api/projections", json=VALID_BODY, headers=_auth(jwt_a))
    assert r.status_code == 201, r.text
    slug = r.json()["view_slug"]
    # The row is stamped with the Clerk owner.
    assert store.get_projection_by_slug(slug)["owner_clerk_user_id"] == "user_a"
    # The owner list (keyed on the Clerk identity) returns it.
    lst = client.get("/api/projections", headers=_auth(jwt_a))
    assert lst.status_code == 200
    assert [p["view_slug"] for p in lst.json()["projections"]] == [slug]


def test_clerk_cross_owner_list_isolation(client, store, priv):
    slug_a = client.post(
        "/api/projections", json=VALID_BODY, headers=_auth(mint(priv, sub="user_a"))
    ).json()["view_slug"]
    # A different Clerk user sees NONE of user_a's projections.
    lst_b = client.get("/api/projections", headers=_auth(mint(priv, sub="user_b")))
    assert lst_b.json()["projections"] == []
    assert slug_a  # sanity


def test_clerk_owner_can_access_owner_only_route(client, priv):
    jwt_a = mint(priv, sub="user_a")
    slug = client.post(
        "/api/projections", json=VALID_BODY, headers=_auth(jwt_a)
    ).json()["view_slug"]
    # Owner-only route (revisions) succeeds for the Clerk owner...
    assert client.get(f"/api/projections/{slug}/revisions", headers=_auth(jwt_a)).status_code == 200
    # ...and is forbidden for a different Clerk user.
    other = client.get(
        f"/api/projections/{slug}/revisions", headers=_auth(mint(priv, sub="user_b"))
    )
    assert other.status_code == 403


# ---- cookie-blind: a cookie never authenticates ----------------------------
def test_cookie_only_request_is_anonymous(client, priv):
    client.post("/api/projections", json=VALID_BODY, headers=_auth(mint(priv, sub="user_a")))
    # A request carrying a Clerk-looking cookie but NO Authorization header is
    # anonymous → empty owner list (Regression #11, no-CSRF invariant).
    cookie = {"Cookie": "__session=" + mint(priv, sub="user_a")}
    lst = client.get("/api/projections", headers=cookie)
    assert lst.status_code == 200
    assert lst.json()["projections"] == []


# ---- ship dark: flag OFF => JWT is an unrecognized bearer -------------------
def test_clerk_off_jwt_is_opaque_bearer(client, store, monkeypatch):
    # Clerk disabled (no CLERK_ENABLED). A JWT presented on create is treated as an
    # opaque owner token (today's behavior), NOT verified, NOT stamped as clerk owner.
    monkeypatch.delenv("CLERK_ENABLED", raising=False)
    p, _pub = make_keypair()
    token = mint(p, sub="user_a")
    r = client.post("/api/projections", json=VALID_BODY, headers=_auth(token))
    assert r.status_code == 201
    row = store.get_projection_by_slug(r.json()["view_slug"])
    assert row.get("owner_clerk_user_id") is None
    # No new owner token is minted because a bearer was presented (joins that token
    # workspace exactly as today).
    assert "owner_token" not in r.json()
    # And the owner list keyed on that opaque token returns the row (unchanged path).
    assert len(client.get("/api/projections", headers=_auth(token)).json()["projections"]) == 1

"""Phase 0 — POST /api/projections/claim (the Clerk claim/bridge path).

A signed-in Clerk owner links their EXISTING token-owned projections (created before
they signed in) onto their verified Clerk identity, so the owner-scoped list (now
keyed on the Clerk `sub`) does not silently lose them. The endpoint is the prereq
for the later forced sign-in gate.

Mutation Safety Quad (each its own test):
  (a) auth          — no/invalid Clerk JWT (capability-token-only caller) → 401.
  (b) tenant         — owner A's token claims ONLY A's rows; an already-claimed row
                       is NOT re-linked/stolen (the `owner_clerk_user_id IS NULL`
                       anti-takeover guard).
  (c) idempotency    — claiming twice links the rows once; the 2nd call → linked: 0.
  (d) rate-limit     — the per-IP negative path returns 429 before any work.
Plus: ship-dark feature gate (Clerk OFF → 404) and a positive end-to-end (a
token-owned row becomes visible via the Clerk-owner list after the claim).
"""
import pytest
from fastapi.testclient import TestClient

import app.clerk.verify as clerkverify
import app.routers.projections as projmod
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


def _create_anon(client) -> tuple[str, str]:
    """Create a token-owned projection with NO bearer → server mints + returns its
    one-time owner_token (owner_clerk_user_id is NULL). Returns (owner_token, slug)."""
    r = client.post("/api/projections", json=VALID_BODY)
    assert r.status_code == 201, r.text
    body = r.json()
    return body["owner_token"], body["view_slug"]


def _claim(client, owner_token, token=None):
    """POST the claim with an optional Bearer (a Clerk JWT, or an opaque token)."""
    headers = _auth(token) if token is not None else None
    return client.post(
        "/api/projections/claim", json={"owner_token": owner_token}, headers=headers)


# ---- positive: a token-owned row becomes Clerk-owner-visible after the claim ----
def test_claim_links_token_owned_row_and_makes_it_clerk_visible(client, store, priv):
    owner_token, slug = _create_anon(client)
    # Before the claim, the Clerk owner's list does not see the token-owned row.
    before = client.get("/api/projections", headers=_auth(mint(priv, sub="user_a")))
    assert before.json()["projections"] == []

    r = _claim(client, owner_token, mint(priv, sub="user_a"))
    assert r.status_code == 200, r.text
    assert r.json() == {"linked": 1}

    # The row is now stamped + visible via the Clerk-owner list and store method.
    row = store.get_projection_by_slug(slug)
    assert row["owner_clerk_user_id"] == "user_a"
    cards = store.list_card_summaries_by_clerk_owner("user_a")
    assert {x["view_slug"] for x in cards} == {slug}
    listed = client.get("/api/projections", headers=_auth(mint(priv, sub="user_a")))
    assert [p["view_slug"] for p in listed.json()["projections"]] == [slug]


def test_claim_carries_org_id_when_present(client, store, priv):
    owner_token, slug = _create_anon(client)
    r = _claim(client, owner_token, mint(priv, sub="user_a", org_id="org_x"))
    assert r.status_code == 200, r.text
    row = store.get_projection_by_slug(slug)
    assert row["owner_clerk_user_id"] == "user_a"
    assert row["owner_org_id"] == "org_x"


# ---- (a) auth: a capability-token-only / anonymous caller cannot claim ----------
def test_claim_requires_verified_clerk_identity(client, priv):
    owner_token, _slug = _create_anon(client)
    # No Authorization at all → 401.
    assert _claim(client, owner_token).status_code == 401
    # An opaque capability token (CapabilityBearer, not a Clerk JWT) cannot claim.
    assert _claim(client, owner_token, owner_token).status_code == 401


# ---- (b) tenant: claims only the caller's rows; never steals a claimed row -------
def test_claim_is_owner_scoped_and_anti_takeover(client, store, priv):
    token_a, slug_a = _create_anon(client)
    token_b, slug_b = _create_anon(client)
    assert token_b  # sanity: a second, distinct token-owned row exists

    # user_x possesses token_a → claims ONLY row A (never row B, a different token).
    assert _claim(client, token_a, mint(priv, sub="user_x")).json() == {"linked": 1}
    assert store.get_projection_by_slug(slug_a)["owner_clerk_user_id"] == "user_x"
    assert store.get_projection_by_slug(slug_b)["owner_clerk_user_id"] is None

    # A different Clerk user presenting the SAME token_a cannot steal the already-
    # claimed row A (the IS NULL guard excludes it) → linked: 0, owner unchanged.
    assert _claim(client, token_a, mint(priv, sub="user_y")).json() == {"linked": 0}
    assert store.get_projection_by_slug(slug_a)["owner_clerk_user_id"] == "user_x"


# ---- (c) idempotency: re-claim links 0 more --------------------------------------
def test_claim_is_idempotent(client, priv):
    owner_token, _slug = _create_anon(client)
    jwt = mint(priv, sub="user_a")
    assert _claim(client, owner_token, jwt).json() == {"linked": 1}
    assert _claim(client, owner_token, jwt).json() == {"linked": 0}


# ---- (d) rate-limit negative path ------------------------------------------------
def test_claim_rate_limited_per_ip(client, priv, monkeypatch):
    owner_token, _slug = _create_anon(client)
    monkeypatch.setattr(projmod, "_CLAIM_IP_LIMIT", 2)
    jwt = mint(priv, sub="user_a")
    assert _claim(client, owner_token, jwt).status_code == 200
    assert _claim(client, owner_token, jwt).status_code == 200
    over = _claim(client, owner_token, jwt)
    assert over.status_code == 429
    assert over.json()["error"] == "rate_limited"


# ---- ship-dark: Clerk OFF => the claim path does not exist (404) -----------------
def test_claim_disabled_when_clerk_off(client, monkeypatch):
    monkeypatch.delenv("CLERK_ENABLED", raising=False)
    owner_token, _slug = _create_anon(client)
    p, _pub = make_keypair()
    assert _claim(client, owner_token, mint(p, sub="user_a")).status_code == 404

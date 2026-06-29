"""Editable shares that FOLLOW a Clerk account (epic #323) — router integration.

Three surfaces, all gated on ``CLERK_ENABLED`` (ship dark):
  1. POST /api/projections/{slug}/claim-share — a signed-in Clerk user presents a
     VALID edit token for that slug → INSERTs a share_grant on their Clerk sub.
  2. GET  /api/projections — UNIONs the grantee's "Shared with me" rows, tagged
     {shared:true, editable:true, owner:false}; owner rows stay {owner:true}.
  3. PATCH /api/projections/{slug} — a Clerk user holding a grant may edit via their
     JWT (in addition to the capability edit-token path).

Mutation Safety Quad on claim-share (each its own test):
  (a) auth       — no/opaque bearer (not a verified Clerk JWT) → 401.
  (b) verified-  — a grant is created ONLY from a VALID edit token for THAT slug; a
      token-only  forged slug → 404, a wrong/foreign edit token → 403; NEVER a grant
                  (no cross-owner leak).
  (c) idempotent — double claim-share creates ONE grant (UNIQUE + insert-or-ignore).
  (d) rate-limit — per-IP cap returns 429 before the JWT verify + write.
The edit token rides the BODY (never the path/query/log — Regression #10).

PATCH-grant quad + the NEGATIVE cross-owner test live at the bottom.
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


def _create_owner_projection(client):
    """Create an anonymous (token-owned) projection. Returns (owner_token, edit_token,
    view_slug). The edit_token is the share secret a recipient receives in a link."""
    r = client.post("/api/projections", json=VALID_BODY)
    assert r.status_code == 201, r.text
    b = r.json()
    return b["owner_token"], b["edit_token"], b["view_slug"]


def _claim_share(client, slug, *, edit_token, token=None):
    headers = _auth(token) if token is not None else None
    return client.post(
        f"/api/projections/{slug}/claim-share",
        json={"edit_token": edit_token}, headers=headers)


# =========================================================================
# claim-share — positive: a valid edit token mints a grant on the Clerk sub
# =========================================================================
def test_claim_share_creates_grant_from_valid_edit_token(client, store, priv):
    _owner, edit, slug = _create_owner_projection(client)
    r = _claim_share(client, slug, edit_token=edit, token=mint(priv, sub="user_grantee"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["granted"] is True
    assert body["view_slug"] == slug
    assert body["role"] == "editor"
    # The grant exists, scoped to the recipient's Clerk sub.
    row = store.get_projection_by_slug(slug)
    assert store.has_share_grant(row["id"], "user_grantee") is True


def test_claim_share_edit_token_never_in_url(client, priv):
    """The edit token rides the BODY only — the path carries the slug, never the
    secret (Regression #10). The endpoint path has no token segment."""
    _owner, edit, slug = _create_owner_projection(client)
    r = _claim_share(client, slug, edit_token=edit, token=mint(priv, sub="user_grantee"))
    assert r.status_code == 200
    assert edit not in r.request.url.path  # secret is in the body, not the path


# ---- (a) auth: a non-Clerk / anonymous caller cannot mint a grant ----------------
def test_claim_share_requires_verified_clerk_identity(client, store, priv):
    _owner, edit, slug = _create_owner_projection(client)
    # No Authorization at all → 401.
    assert _claim_share(client, slug, edit_token=edit).status_code == 401
    # An opaque capability token (not a Clerk JWT) cannot claim a share → 401.
    assert _claim_share(client, slug, edit_token=edit, token=edit).status_code == 401
    # Nothing was granted on any of those rejected calls.
    row = store.get_projection_by_slug(slug)
    grants = store._read_conn().execute(
        "SELECT COUNT(*) FROM share_grants WHERE projection_id=?", (row["id"],)
    ).fetchone()[0]
    assert grants == 0


# ---- (b) verified-token-only: forged slug / wrong token never mint a grant -------
def test_claim_share_unknown_slug_is_404_no_grant(client, store, priv):
    _owner, edit, _slug = _create_owner_projection(client)
    r = _claim_share(client, "totally-bogus-slug", edit_token=edit,
                     token=mint(priv, sub="user_grantee"))
    assert r.status_code == 404
    assert store._read_conn().execute(
        "SELECT COUNT(*) FROM share_grants").fetchone()[0] == 0


def test_claim_share_wrong_edit_token_is_403_no_grant(client, store, priv):
    _owner, _edit, slug = _create_owner_projection(client)
    r = _claim_share(client, slug, edit_token="not-the-right-token",
                     token=mint(priv, sub="user_grantee"))
    assert r.status_code == 403
    row = store.get_projection_by_slug(slug)
    assert store.has_share_grant(row["id"], "user_grantee") is False


def test_claim_share_foreign_edit_token_is_403_no_cross_owner_leak(client, store, priv):
    """A VALID edit token for projection A presented against projection B's slug must
    NOT mint a grant on B — the token must match THIS slug's edit_token_hash."""
    _oa, edit_a, _slug_a = _create_owner_projection(client)
    _ob, _edit_b, slug_b = _create_owner_projection(client)
    r = _claim_share(client, slug_b, edit_token=edit_a,
                     token=mint(priv, sub="user_grantee"))
    assert r.status_code == 403
    row_b = store.get_projection_by_slug(slug_b)
    assert store.has_share_grant(row_b["id"], "user_grantee") is False


# ---- (c) idempotency: a double claim-share creates ONE grant ---------------------
def test_claim_share_is_idempotent(client, store, priv):
    _owner, edit, slug = _create_owner_projection(client)
    jwt = mint(priv, sub="user_grantee")
    first = _claim_share(client, slug, edit_token=edit, token=jwt)
    assert first.json()["granted"] is True
    second = _claim_share(client, slug, edit_token=edit, token=jwt)
    assert second.status_code == 200
    assert second.json()["granted"] is False  # already granted
    row = store.get_projection_by_slug(slug)
    assert store._read_conn().execute(
        "SELECT COUNT(*) FROM share_grants WHERE projection_id=?", (row["id"],)
    ).fetchone()[0] == 1


# ---- (d) rate-limit: per-IP cap returns 429 before the verify + write ------------
def test_claim_share_rate_limited_per_ip(client, priv, monkeypatch):
    _owner, edit, slug = _create_owner_projection(client)
    monkeypatch.setattr(projmod, "_CLAIM_SHARE_IP_LIMIT", 2)
    jwt = mint(priv, sub="user_grantee")
    assert _claim_share(client, slug, edit_token=edit, token=jwt).status_code == 200
    assert _claim_share(client, slug, edit_token=edit, token=jwt).status_code == 200
    over = _claim_share(client, slug, edit_token=edit, token=jwt)
    assert over.status_code == 429
    assert over.json()["error"] == "rate_limited"


# ---- ship-dark: Clerk OFF => claim-share does not exist (404) ---------------------
def test_claim_share_disabled_when_clerk_off(client, monkeypatch):
    _owner, edit, slug = _create_owner_projection(client)
    monkeypatch.delenv("CLERK_ENABLED", raising=False)
    p, _pub = make_keypair()
    r = _claim_share(client, slug, edit_token=edit, token=mint(p, sub="user_grantee"))
    assert r.status_code == 404


# =========================================================================
# GET /api/projections — "Shared with me" UNION + tags
# =========================================================================
def test_shared_with_me_appears_in_recipient_list(client, store, priv):
    # Owner (a Clerk owner) creates a projection; recipient claims the share.
    owner_jwt = mint(priv, sub="user_owner")
    created = client.post("/api/projections", json=VALID_BODY, headers=_auth(owner_jwt))
    slug = created.json()["view_slug"]
    edit = created.json()["edit_token"]
    grantee_jwt = mint(priv, sub="user_grantee")
    assert _claim_share(client, slug, edit_token=edit, token=grantee_jwt).status_code == 200

    # The recipient's list now carries the shared row, tagged + editable, NOT owner.
    lst = client.get("/api/projections", headers=_auth(grantee_jwt))
    assert lst.status_code == 200
    items = lst.json()["projections"]
    shared = [p for p in items if p["view_slug"] == slug]
    assert len(shared) == 1
    assert shared[0]["shared"] is True
    assert shared[0]["editable"] is True
    assert shared[0]["owner"] is False


def test_owner_rows_tagged_owner_true(client, store, priv):
    owner_jwt = mint(priv, sub="user_owner")
    created = client.post("/api/projections", json=VALID_BODY, headers=_auth(owner_jwt))
    slug = created.json()["view_slug"]
    lst = client.get("/api/projections", headers=_auth(owner_jwt))
    row = [p for p in lst.json()["projections"] if p["view_slug"] == slug][0]
    assert row["owner"] is True
    assert row["shared"] is False


def test_no_grant_means_no_shared_row_cross_owner_isolation(client, store, priv):
    """A Clerk user with NO grant sees NONE of another owner's rows (TENANT)."""
    owner_jwt = mint(priv, sub="user_owner")
    client.post("/api/projections", json=VALID_BODY, headers=_auth(owner_jwt))
    # A different Clerk user, never granted anything, sees an empty list.
    stranger = client.get("/api/projections", headers=_auth(mint(priv, sub="user_stranger")))
    assert stranger.json()["projections"] == []


# =========================================================================
# PATCH /api/projections/{slug} — grant-based edit + the quad + negative test
# =========================================================================
def _patch(client, slug, *, token, version, body=None):
    return client.patch(
        f"/api/projections/{slug}",
        json=body or {"assumptions": {"labor_pct": "0.55"}},
        headers={**_auth(token), "If-Match": str(version)},
    )


def test_grantee_can_patch_via_clerk_jwt(client, store, priv):
    """A Clerk user holding a grant edits via their JWT (no capability token)."""
    owner_jwt = mint(priv, sub="user_owner")
    created = client.post("/api/projections", json=VALID_BODY, headers=_auth(owner_jwt))
    slug, edit, ver = created.json()["view_slug"], created.json()["edit_token"], created.json()["version"]
    grantee_jwt = mint(priv, sub="user_grantee")
    assert _claim_share(client, slug, edit_token=edit, token=grantee_jwt).status_code == 200
    # (a) auth/positive: the grantee's JWT now authorizes the PATCH.
    r = _patch(client, slug, token=grantee_jwt, version=ver)
    assert r.status_code == 200, r.text
    assert r.json()["version"] == ver + 1


def test_clerk_user_without_grant_cannot_patch(client, store, priv):
    """(b) NEGATIVE cross-owner: a Clerk user with NO grant gets 403, not edit."""
    owner_jwt = mint(priv, sub="user_owner")
    created = client.post("/api/projections", json=VALID_BODY, headers=_auth(owner_jwt))
    slug, ver = created.json()["view_slug"], created.json()["version"]
    stranger = mint(priv, sub="user_stranger")
    r = _patch(client, slug, token=stranger, version=ver)
    assert r.status_code == 403
    # And the projection was NOT mutated (version unchanged).
    assert store.get_projection_by_slug(slug)["version"] == ver


def test_grant_patch_still_enforces_if_match_409(client, store, priv):
    """(c) If-Match/409 still enforced for the grant path — a stale version conflicts."""
    owner_jwt = mint(priv, sub="user_owner")
    created = client.post("/api/projections", json=VALID_BODY, headers=_auth(owner_jwt))
    slug, edit, ver = created.json()["view_slug"], created.json()["edit_token"], created.json()["version"]
    grantee_jwt = mint(priv, sub="user_grantee")
    _claim_share(client, slug, edit_token=edit, token=grantee_jwt)
    # First edit succeeds (ver → ver+1); a SECOND at the stale ver → 409.
    assert _patch(client, slug, token=grantee_jwt, version=ver).status_code == 200
    stale = _patch(client, slug, token=grantee_jwt, version=ver)
    assert stale.status_code == 409
    assert stale.json()["detail"]["error"] == "version_conflict"


def test_grant_patch_requires_bearer(client, store, priv):
    """(a) PATCH with no bearer → 401/403 (never a silent edit)."""
    owner_jwt = mint(priv, sub="user_owner")
    created = client.post("/api/projections", json=VALID_BODY, headers=_auth(owner_jwt))
    slug, ver = created.json()["view_slug"], created.json()["version"]
    r = client.patch(f"/api/projections/{slug}",
                     json={"assumptions": {"labor_pct": "0.55"}},
                     headers={"If-Match": str(ver)})
    assert r.status_code in (401, 403)


def test_patch_rate_limited_per_token(client, store, priv, monkeypatch):
    """(d) PATCH abuse path: the per-token cap returns 429."""
    owner_jwt = mint(priv, sub="user_owner")
    created = client.post("/api/projections", json=VALID_BODY, headers=_auth(owner_jwt))
    slug, edit, ver = created.json()["view_slug"], created.json()["edit_token"], created.json()["version"]
    grantee_jwt = mint(priv, sub="user_grantee")
    _claim_share(client, slug, edit_token=edit, token=grantee_jwt)
    monkeypatch.setattr(projmod, "_PATCH_TOKEN_LIMIT", 1)
    monkeypatch.setattr(projmod, "_PATCH_IP_LIMIT", 1000)
    assert _patch(client, slug, token=grantee_jwt, version=ver).status_code == 200
    over = _patch(client, slug, token=grantee_jwt, version=ver + 1)
    assert over.status_code == 429

"""Cross-owner capability isolation (SECURITY.md §2, PRD §20, regression #4).

The slug grants *read*. Mutations and owner-only routes are gated on the bearer
matching THIS projection's hashed owner/edit token — never any global index and
never another workspace's valid token. These tests prove a second, perfectly
valid owner token (a different workspace) cannot patch, rotate, restore, or read
the revisions of a projection it does not own, and that the auth check runs
BEFORE the optimistic-concurrency (If-Match) check so a wrong owner can never
learn the current version or mutate state.

RED-first against app/routers/projections.py.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore


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


def _create_fresh_workspace(client):
    """Create a projection with NO bearer -> mints a brand-new owner token."""
    r = client.post("/api/projections", json=VALID_BODY)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body.get("owner_token")  # one-time mint
    return body


def test_other_owner_cannot_patch_and_state_is_untouched(client, store):
    victim = _create_fresh_workspace(client)
    attacker = _create_fresh_workspace(client)  # a *valid* but different owner
    assert victim["owner_token"] != attacker["owner_token"]

    slug = victim["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.10"}},
        headers={
            "Authorization": f"Bearer {attacker['owner_token']}",
            "If-Match": "1",
        },
    )
    assert r.status_code == 403, r.text
    assert r.json().get("detail", r.json())["error"] == "forbidden"
    # victim state is byte-for-byte unchanged
    after = store.get_projection_by_slug(slug)
    assert after["version"] == 1
    assert len(store.list_revisions(after["id"])) == 0


def test_auth_precedes_if_match_no_version_leak(client):
    """A wrong owner must be 403 even with a *stale* If-Match — the 409 path,
    which would echo current_version, must never be reached for a non-owner.
    """
    victim = _create_fresh_workspace(client)
    attacker = _create_fresh_workspace(client)
    slug = victim["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"name": "pwn"},
        headers={
            "Authorization": f"Bearer {attacker['owner_token']}",
            "If-Match": "999",  # stale; would 409 for the real owner
        },
    )
    assert r.status_code == 403, r.text
    body = r.json().get("detail", r.json())
    assert body["error"] == "forbidden"
    # the 403 body must NOT disclose the current version
    assert "current_version" not in body
    assert "current_state" not in body


def test_other_owner_cannot_read_revisions(client):
    victim = _create_fresh_workspace(client)
    attacker = _create_fresh_workspace(client)
    slug = victim["view_slug"]
    r = client.get(
        f"/api/projections/{slug}/revisions",
        headers={"Authorization": f"Bearer {attacker['owner_token']}"},
    )
    assert r.status_code == 403, r.text


def test_other_owner_cannot_rotate_tokens(client, store):
    victim = _create_fresh_workspace(client)
    attacker = _create_fresh_workspace(client)
    slug = victim["view_slug"]
    before = store.get_projection_by_slug(slug)["owner_token_hash"]
    r = client.post(
        f"/api/projections/{slug}/rotate-tokens",
        json={"rotate": ["owner"]},
        headers={
            "Authorization": f"Bearer {attacker['owner_token']}",
            "If-Match": "1",
        },
    )
    assert r.status_code == 403, r.text
    # the victim's owner hash is unchanged -> no lock-out
    assert store.get_projection_by_slug(slug)["owner_token_hash"] == before


def test_other_owner_not_in_attacker_listing(client):
    victim = _create_fresh_workspace(client)
    attacker = _create_fresh_workspace(client)
    listing = client.get(
        "/api/projections",
        headers={"Authorization": f"Bearer {attacker['owner_token']}"},
    ).json()["projections"]
    slugs = {p["view_slug"] for p in listing}
    assert victim["view_slug"] not in slugs
    assert attacker["view_slug"] in slugs


def test_slug_still_grants_read_to_anyone(client):
    """Isolation guards *writes*; the view_slug is a read capability by design."""
    victim = _create_fresh_workspace(client)
    slug = victim["view_slug"]
    # no bearer at all
    r = client.get(f"/api/projections/{slug}")
    assert r.status_code == 200
    assert r.json()["view_slug"] == slug


# --- Lifecycle routes (trash / restore / purge) — Mutation Safety Quad (b) -------
# A second, perfectly valid owner token must NOT be able to trash, restore, or purge
# a projection it does not own (Override TENANT, regression #4). 403 forbidden, and
# the victim's state is byte-for-byte unchanged.

def test_other_owner_cannot_trash(client, store):
    victim = _create_fresh_workspace(client)
    attacker = _create_fresh_workspace(client)
    slug = victim["view_slug"]
    r = client.post(
        f"/api/projections/{slug}/trash",
        headers={"Authorization": f"Bearer {attacker['owner_token']}", "If-Match": "1"},
    )
    assert r.status_code == 403, r.text
    assert r.json().get("detail", r.json())["error"] == "forbidden"
    after = store.get_projection_by_slug(slug)
    assert after is not None and after["status"] == "active"  # not trashed
    assert after["version"] == 1                              # untouched


def test_other_owner_cannot_restore(client, store):
    victim = _create_fresh_workspace(client)
    # The victim trashes their own projection.
    client.post(
        f"/api/projections/{victim['view_slug']}/trash",
        headers={"Authorization": f"Bearer {victim['owner_token']}", "If-Match": "1"},
    )
    attacker = _create_fresh_workspace(client)
    r = client.post(
        f"/api/projections/{victim['view_slug']}/restore",
        headers={"Authorization": f"Bearer {attacker['owner_token']}", "If-Match": "2"},
    )
    assert r.status_code == 403, r.text
    assert store.get_projection_by_slug(victim["view_slug"])["status"] == "trashed"


def test_other_owner_cannot_purge(client, store):
    victim = _create_fresh_workspace(client)
    client.post(
        f"/api/projections/{victim['view_slug']}/trash",
        headers={"Authorization": f"Bearer {victim['owner_token']}", "If-Match": "1"},
    )
    attacker = _create_fresh_workspace(client)
    r = client.delete(
        f"/api/projections/{victim['view_slug']}",
        headers={"Authorization": f"Bearer {attacker['owner_token']}", "If-Match": "2"},
    )
    assert r.status_code == 403, r.text
    # the victim's row + financials are NOT erased
    assert store.get_projection_by_slug(victim["view_slug"]) is not None

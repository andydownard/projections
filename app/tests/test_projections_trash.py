"""M4 API — soft delete: trash / restore / purge (API_SPEC §4.8, DATA_MODEL §5.4).

Owner-only, If-Match required. Trash sets status=trashed (hidden from the default
list + non-owner GET 404); restore flips it back; DELETE hard-purges, permitted
ONLY when already trashed (else 409 not_trashed).

RED-first: the three endpoints do not exist yet.
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
        "org_name": "House of Hope", "city": "Longview, Texas",
        "opening_status": "pre_launch",
        "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
        "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
        "source_of_funds": "300000", "occupancy_annual": "120000",
        "lease_type": "nnn", "nnn_opex_annual": "0",
    },
    "trade_area": {"basis": "city", "households": "31798"},
    "assumptions": {"labor_pct": "0.60"},
}


def _create(client):
    r = client.post("/api/projections", json=VALID_BODY)
    assert r.status_code == 201, r.text
    return r.json()


def test_trash_hides_from_owner_list_and_restore_brings_back(client):
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    hdr = {"Authorization": f"Bearer {owner}"}

    # present in active list
    lst = client.get("/api/projections", headers=hdr).json()["projections"]
    assert any(p["view_slug"] == slug for p in lst)

    r = client.post(f"/api/projections/{slug}/trash",
                    headers={**hdr, "If-Match": "1"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "trashed"

    # gone from default (active) list
    lst2 = client.get("/api/projections", headers=hdr).json()["projections"]
    assert not any(p["view_slug"] == slug for p in lst2)

    # restore
    r2 = client.post(f"/api/projections/{slug}/restore",
                     headers={**hdr, "If-Match": "2"})
    assert r2.status_code == 200, r2.text
    assert r2.json()["status"] == "active"
    lst3 = client.get("/api/projections", headers=hdr).json()["projections"]
    assert any(p["view_slug"] == slug for p in lst3)


def test_trash_restore_response_envelope_carries_vm_and_bumps_version(client):
    """The shared trash/restore writer returns the full view-model envelope (not just
    a status), with the version incremented and a matching ETag. Guards the single
    _set_status_and_respond helper that both endpoints delegate to."""
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    hdr = {"Authorization": f"Bearer {owner}"}

    r = client.post(f"/api/projections/{slug}/trash", headers={**hdr, "If-Match": "1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "trashed"
    assert body["version"] == 2
    assert r.headers["ETag"] == "2"
    assert body["view_slug"] == slug
    assert body["name"] == "House of Hope"
    # the computed view-model is carried through verbatim, not dropped.
    for key in ("reco", "metrics", "rows", "monthly"):
        assert key in body, key

    r2 = client.post(f"/api/projections/{slug}/restore", headers={**hdr, "If-Match": "2"})
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    assert body2["status"] == "active"
    assert body2["version"] == 3
    assert r2.headers["ETag"] == "3"
    assert "reco" in body2


def test_trash_and_restore_reject_stale_if_match_with_409(client):
    """Optimistic concurrency on both lifecycle endpoints (Mutation Safety Quad c):
    a stale If-Match flips zero rows -> 409 version_conflict with recovery options."""
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    hdr = {"Authorization": f"Bearer {owner}"}

    r = client.post(f"/api/projections/{slug}/trash", headers={**hdr, "If-Match": "99"})
    assert r.status_code == 409, r.text
    detail = r.json().get("detail", r.json())
    assert detail["error"] == "version_conflict"
    assert "recovery" in detail

    # a real trash (version -> 2), then a stale restore is likewise rejected.
    client.post(f"/api/projections/{slug}/trash", headers={**hdr, "If-Match": "1"})
    r2 = client.post(f"/api/projections/{slug}/restore", headers={**hdr, "If-Match": "1"})
    assert r2.status_code == 409, r2.text
    assert r2.json().get("detail", r2.json())["error"] == "version_conflict"


def test_delete_on_active_returns_409_not_trashed(client):
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    r = client.delete(f"/api/projections/{slug}",
                      headers={"Authorization": f"Bearer {owner}", "If-Match": "1"})
    assert r.status_code == 409, r.text
    assert r.json().get("detail", r.json())["error"] == "not_trashed"


def test_purge_after_trash_returns_204_and_row_gone(client, store):
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    client.post(f"/api/projections/{slug}/trash",
                headers={"Authorization": f"Bearer {owner}", "If-Match": "1"})
    r = client.delete(f"/api/projections/{slug}",
                      headers={"Authorization": f"Bearer {owner}", "If-Match": "2"})
    assert r.status_code == 204, r.text
    # excluded from reads everywhere (deleted_at set)
    assert client.get(f"/api/projections/{slug}").status_code == 404
    assert store.get_projection_by_slug(slug) is None


def test_trash_is_owner_only(client):
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    r = client.post(f"/api/projections/{slug}/trash",
                    headers={"Authorization": f"Bearer {edit}", "If-Match": "1"})
    assert r.status_code == 403, r.text
    assert r.json().get("detail", r.json())["error"] == "owner_required"


# =============================================================== IMP-3 quad legs
# Whole-branch review: trash/restore share `_require_owner` with the already-
# cross-owner-tested rotate/patch/delete routes, so the enforcement below is
# shared-code-path-verified — these were the missing pins.

def test_trash_cross_owner_forbidden_and_untouched(client, store):
    # IMP-3(5a): a valid but DIFFERENT owner cannot trash this projection (TENANT,
    # PRD §20); no auth/owner-scope test existed for trash beyond the edit-token leg
    # above.
    created = _create(client)
    slug = created["view_slug"]
    attacker = _create(client)
    r = client.post(
        f"/api/projections/{slug}/trash",
        headers={"Authorization": f"Bearer {attacker['owner_token']}", "If-Match": "1"},
    )
    assert r.status_code == 403, r.text
    assert r.json().get("detail", r.json())["error"] == "forbidden"
    after = store.get_projection_by_slug(slug)
    assert after["status"] == "active"
    assert after["version"] == 1


def test_restore_requires_owner_and_rejects_other_owner(client, store):
    # IMP-3(4): POST /restore shares `_require_owner` with trash/rotate/delete but
    # had NO auth or owner-scope test of its own (a full hole in the quad matrix).
    created = _create(client)
    slug, owner, edit = (
        created["view_slug"], created["owner_token"], created["edit_token"])
    client.post(f"/api/projections/{slug}/trash",
                headers={"Authorization": f"Bearer {owner}", "If-Match": "1"})

    # edit token -> 403 owner_required (identical gate to trash/rotate/delete).
    r = client.post(f"/api/projections/{slug}/restore",
                    headers={"Authorization": f"Bearer {edit}", "If-Match": "2"})
    assert r.status_code == 403, r.text
    assert r.json().get("detail", r.json())["error"] == "owner_required"

    # a different, valid owner -> 403 forbidden; the trashed row is untouched.
    attacker = _create(client)
    r2 = client.post(
        f"/api/projections/{slug}/restore",
        headers={"Authorization": f"Bearer {attacker['owner_token']}", "If-Match": "2"},
    )
    assert r2.status_code == 403, r2.text
    assert r2.json().get("detail", r2.json())["error"] == "forbidden"
    assert store.get_projection_by_slug(slug)["status"] == "trashed"


def test_delete_stale_if_match_after_trash_returns_409_and_keeps_row(client, store):
    # IMP-3(6): the version-checked purge is proven at the STORE level
    # (test_purge_cascade.py::test_purge_version_mismatch_returns_zero_and_keeps_data)
    # but the API-level 409 — through the real DELETE route's _require_owner +
    # not_trashed gate + purge_projection call — had no test of its own.
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    client.post(f"/api/projections/{slug}/trash",
                headers={"Authorization": f"Bearer {owner}", "If-Match": "1"})

    r = client.delete(f"/api/projections/{slug}",
                      headers={"Authorization": f"Bearer {owner}", "If-Match": "99"})
    assert r.status_code == 409, r.text
    detail = r.json().get("detail", r.json())
    assert detail["error"] == "version_conflict"
    assert "recovery" in detail
    # nothing purged: the row (and its trashed status) survives.
    after = store.get_projection_by_slug(slug)
    assert after is not None
    assert after["status"] == "trashed"

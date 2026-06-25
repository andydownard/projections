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

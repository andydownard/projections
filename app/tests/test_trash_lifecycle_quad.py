"""M4 API — trash/restore/purge Mutation-Safety-Quad completion + list-trashed.

This project has no authentication (owner decision, 2026-09-13): trash/restore/
purge are reachable with no bearer at all, and the list (default and ?trashed=true)
is global, not owner-scoped. This file pins the pieces that remain:

  (d) per-IP RATE LIMIT with a negative path — abuse of trash/restore/purge must
      429 BEFORE the mutation, not be bypassable by a client bug.
  + the LIST-TRASHED read the Trash view needs: GET /api/projections?trashed=true
    returns every trashed projection (never the active ones), and the default
    list still excludes trashed.
  + the purge router 409 on a stale If-Match (the store-level case is in
    test_purge_cascade; this proves the DELETE endpoint surfaces it).
"""
import pytest
from fastapi.testclient import TestClient

import app.routers.projections as P
from app.main import create_app
from app.ratelimit import reset_rate_limits
from app.store import get_store
from app.store.sqlite import SqliteStore


@pytest.fixture(autouse=True)
def _reset_limits():
    reset_rate_limits()
    yield
    reset_rate_limits()


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


def _create(client, headers=None):
    r = client.post("/api/projections", json=VALID_BODY, headers=headers or {})
    assert r.status_code == 201, r.text
    return r.json()


# ----------------------------------------------------- Quad (d): per-IP rate limit
def test_trash_over_ip_cap_returns_429(client, monkeypatch):
    """Repeated trash POSTs from one IP trip the per-IP cap. A stale-version call
    still consumes a token (the limiter runs BEFORE the version check), so the cap
    binds regardless of the mutation outcome."""
    monkeypatch.setattr(P, "_LIFECYCLE_IP_LIMIT", 2, raising=False)
    created = _create(client)
    slug = created["view_slug"]
    r1 = client.post(f"/api/projections/{slug}/trash", headers={"If-Match": "1"})
    assert r1.status_code == 200, r1.text          # bucket = 1
    r2 = client.post(f"/api/projections/{slug}/trash", headers={"If-Match": "1"})
    assert r2.status_code == 409, r2.text          # bucket = 2 (stale version)
    r3 = client.post(f"/api/projections/{slug}/trash", headers={"If-Match": "1"})
    assert r3.status_code == 429, r3.text          # bucket = 3 > cap
    assert r3.json()["error"] == "rate_limited"
    assert "Retry-After" in r3.headers


def test_restore_over_ip_cap_returns_429(client, monkeypatch):
    monkeypatch.setattr(P, "_LIFECYCLE_IP_LIMIT", 2, raising=False)
    created = _create(client)
    slug = created["view_slug"]
    # Trash first (its OWN bucket), then drive the restore bucket over the cap.
    assert client.post(f"/api/projections/{slug}/trash",
                       headers={"If-Match": "1"}).status_code == 200
    r1 = client.post(f"/api/projections/{slug}/restore", headers={"If-Match": "2"})
    assert r1.status_code == 200, r1.text          # restore bucket = 1
    r2 = client.post(f"/api/projections/{slug}/restore", headers={"If-Match": "2"})
    assert r2.status_code == 409, r2.text          # restore bucket = 2 (stale)
    r3 = client.post(f"/api/projections/{slug}/restore", headers={"If-Match": "2"})
    assert r3.status_code == 429, r3.text          # restore bucket = 3 > cap


def test_purge_over_ip_cap_returns_429(client, monkeypatch):
    monkeypatch.setattr(P, "_LIFECYCLE_IP_LIMIT", 2, raising=False)
    created = _create(client)
    slug = created["view_slug"]
    assert client.post(f"/api/projections/{slug}/trash",
                       headers={"If-Match": "1"}).status_code == 200
    # Stale If-Match keeps the row alive (purge returns 0 -> 409) so each DELETE
    # consumes a token without erasing the projection.
    r1 = client.delete(f"/api/projections/{slug}", headers={"If-Match": "99"})
    assert r1.status_code == 409, r1.text          # purge bucket = 1
    r2 = client.delete(f"/api/projections/{slug}", headers={"If-Match": "99"})
    assert r2.status_code == 409, r2.text          # purge bucket = 2
    r3 = client.delete(f"/api/projections/{slug}", headers={"If-Match": "99"})
    assert r3.status_code == 429, r3.text          # purge bucket = 3 > cap


# ----------------------------------------------------------- list-trashed (read)
def test_list_trashed_returns_only_trashed(client):
    """GET /api/projections?trashed=true lists ONLY trashed projections (global,
    no auth); the default list keeps showing only the active ones."""
    a = _create(client)
    b = client.post("/api/projections", json=VALID_BODY).json()
    assert client.post(f"/api/projections/{a['view_slug']}/trash",
                       headers={"If-Match": "1"}).status_code == 200

    active = client.get("/api/projections").json()["projections"]
    active_slugs = {p["view_slug"] for p in active}
    assert a["view_slug"] not in active_slugs        # trashed -> hidden from default
    assert b["view_slug"] in active_slugs

    trashed = client.get("/api/projections?trashed=true").json()["projections"]
    trashed_slugs = {p["view_slug"] for p in trashed}
    assert trashed_slugs == {a["view_slug"]}         # ONLY the trashed one
    assert all(p["status"] == "trashed" for p in trashed)


def test_list_trashed_empty_when_nothing_trashed(client):
    _create(client)
    assert client.get("/api/projections?trashed=true").json() == {"projections": []}


# --------------------------------------------- purge router 409 on stale If-Match
def test_purge_stale_if_match_returns_409_and_keeps_data(client, store):
    created = _create(client)
    slug = created["view_slug"]
    assert client.post(f"/api/projections/{slug}/trash",
                       headers={"If-Match": "1"}).status_code == 200
    r = client.delete(f"/api/projections/{slug}", headers={"If-Match": "99"})
    assert r.status_code == 409, r.text
    assert r.json().get("detail", r.json())["error"] == "version_conflict"
    # nothing erased — the row survives a rejected purge
    assert store.get_projection_by_slug(slug) is not None

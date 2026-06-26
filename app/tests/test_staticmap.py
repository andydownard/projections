"""Server-proxied Static Map endpoint (key stays server-side; placeholder on no
location). The image-bytes seam is stubbed so no network/key is needed in tests.
"""
import pytest
from fastapi.testclient import TestClient

from app.geo import client as geo_client
from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(geo_client, "_get_bytes", lambda url: b"PNGDATA")
    geo_client.reset_static_cache()
    store = SqliteStore(":memory:")
    store.migrate()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


def _create(client, location):
    body = {
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
        "location": location,
    }
    return client.post("/api/projections", json=body).json()


def test_staticmap_returns_png_for_resolved_location(client):
    slug = _create(client, {"lat": 32.5007, "lng": -94.7405})["view_slug"]
    r = client.get(f"/api/projections/{slug}/staticmap?size=detail")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.content == b"PNGDATA"
    assert "max-age" in r.headers.get("cache-control", "")


def test_staticmap_404_when_no_location(client):
    # Manual / unresolved trade area -> no map (the client shows a placeholder tile).
    slug = _create(client, {})["view_slug"]
    r = client.get(f"/api/projections/{slug}/staticmap")
    assert r.status_code == 404
    assert r.json()["detail"]["error"] == "no_location"


def test_staticmap_404_for_unknown_slug(client):
    r = client.get("/api/projections/nope/staticmap")
    assert r.status_code == 404

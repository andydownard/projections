"""M2 API — create / read / owner-list slice (API_SPEC §4.1–4.3).

The server computes via the pure engine and persists the native view-model; reads
return that snapshot verbatim; lists are owner-scoped by the bearer owner token.
RED-first: these were written before app/routers/projections.py.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore


@pytest.fixture()
def client():
    store = SqliteStore(":memory:")
    store.migrate()
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


def _create(client, body=None):
    return client.post("/api/projections", json=body or VALID_BODY)


def test_create_returns_view_model_version_and_one_time_tokens(client):
    r = _create(client)
    assert r.status_code == 201, r.text
    vm = r.json()
    for key in ("reco", "metrics", "kpis", "rows", "monthly", "settings",
                "model_version", "view_slug", "version"):
        assert key in vm, key
    assert vm["version"] == 1
    assert vm["reco"]["tag"] in {
        "proceed", "revise", "find_cheaper_rent", "raise_cash", "delay", "do_not_proceed"}
    assert vm["owner_token"] and vm["edit_token"]
    # canonical 60% labor reflected in settings
    assert abs(vm["settings"]["laborPct"] - 0.60) < 1e-9


def test_get_by_slug_returns_stored_snapshot_with_etag(client):
    created = _create(client).json()
    slug = created["view_slug"]
    r = client.get(f"/api/projections/{slug}")
    assert r.status_code == 200, r.text
    assert r.headers.get("ETag") == "1"
    got = r.json()
    assert got["view_slug"] == slug
    assert got["version"] == 1
    assert got["reco"]["tag"] == created["reco"]["tag"]  # verbatim, no recompute


def test_get_unknown_slug_404(client):
    assert client.get("/api/projections/does-not-exist").status_code == 404


def test_list_is_owner_scoped(client):
    created = _create(client).json()
    owner = created["owner_token"]
    # the owner sees exactly their projection
    r = client.get("/api/projections", headers={"Authorization": f"Bearer {owner}"})
    assert r.status_code == 200
    items = r.json()["projections"]
    assert len(items) == 1 and items[0]["view_slug"] == created["view_slug"]
    # a different owner sees nothing (no global index)
    other = client.get("/api/projections", headers={"Authorization": "Bearer someone-else"})
    assert other.json()["projections"] == []
    # no token -> empty
    assert client.get("/api/projections").json()["projections"] == []


def test_second_create_with_same_owner_token_joins_workspace(client):
    first = _create(client).json()
    owner = first["owner_token"]
    second = client.post(
        "/api/projections", json=VALID_BODY,
        headers={"Authorization": f"Bearer {owner}"},
    ).json()
    # joining an existing workspace does not mint a new owner token
    assert "owner_token" not in second
    listing = client.get(
        "/api/projections", headers={"Authorization": f"Bearer {owner}"}
    ).json()["projections"]
    assert len(listing) == 2


def test_invalid_inputs_return_422(client):
    bad = {**VALID_BODY, "inputs": {**VALID_BODY["inputs"]}}
    bad["inputs"].pop("occupancy_annual")  # no occupancy AND no rent_per_sqft -> engine raises
    r = _create(client, bad)
    assert r.status_code == 422, r.text

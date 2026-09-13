"""Contract emission: location + trade-area provenance + evidence[] in the
view-model (the spine the detail map, the basis line, and the evidence panel read).

The Places->Census derivation is API metadata, not engine math — these assert it
travels into computed_json (and back out verbatim on read) WITHOUT disturbing the
single math authority, and that a manual/unresolved trade area carries no false
location or evidence.
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


CENSUS_TA = {
    "geography_name": "Longview city",
    "geography_fips": "4843012",
    "acs_vintage": "2022",
    "households_source": "census_acs",
    "moe": 412,
}
LOCATION = {
    "place_id": "PID",
    "lat": 32.5007,
    "lng": -94.7405,
    "formatted_address": "Longview, TX, USA",
}


def _body(location=None, **ta):
    return {
        "name": "House of Hope",
        "inputs": {
            "org_name": "House of Hope", "city": "Longview, Texas",
            "opening_status": "pre_launch",
            "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
            "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
            "source_of_funds": "300000", "occupancy_annual": "120000",
            "lease_type": "nnn", "nnn_opex_annual": "0",
        },
        "assumptions": {"labor_pct": "0.40"},
        "trade_area": {"basis": "city", "households": "31798", **ta},
        "location": location or {},
    }


def test_create_emits_location_trade_area_and_evidence(client):
    vm = client.post("/api/projections", json=_body(LOCATION, **CENSUS_TA)).json()
    assert vm["location"]["lat"] == pytest.approx(32.5007)
    assert vm["location"]["place_id"] == "PID"
    ta = vm["trade_area"]
    assert ta["geography_name"] == "Longview city"
    assert ta["households_source"] == "census_acs"
    assert ta["acs_vintage"] == "2022"
    assert ta["moe"] == 412
    ev = vm["evidence"]
    assert len(ev) == 1 and ev[0]["field"] == "households"
    assert ev[0]["method"] == "census_acs"
    assert "ACS 5-year (2022)" in ev[0]["source"]
    # Server is the sole formatting authority (PRD §13): it emits display strings
    # the client renders verbatim (no client-side Intl / number formatting).
    assert ev[0]["value_display"] == "~31,798 households"
    assert ev[0]["moe_display"] == "±412 households (MOE)"
    # The provenance did NOT disturb the math (households still drives the chain).
    assert vm["reco"]["tag"] in {
        "proceed", "revise", "find_cheaper_rent", "raise_cash", "delay", "do_not_proceed"}
    assert vm["kpis"][0]["value"]["raw"] > 0


def test_read_returns_provenance_verbatim(client):
    slug = client.post("/api/projections", json=_body(LOCATION, **CENSUS_TA)).json()["view_slug"]
    got = client.get(f"/api/projections/{slug}").json()
    assert got["location"]["lng"] == pytest.approx(-94.7405)
    assert got["trade_area"]["geography_name"] == "Longview city"
    assert got["evidence"][0]["value"] == "31798"


def test_list_item_carries_location_for_minimap(client):
    client.post("/api/projections", json=_body(LOCATION, **CENSUS_TA)).json()
    items = client.get("/api/projections").json()["projections"]
    assert len(items) == 1
    assert items[0]["coords"]["lat"] == pytest.approx(32.5007)


def test_manual_households_carry_no_evidence_or_location(client):
    # No Census provenance and no resolved location -> never a map over a typed number.
    vm = client.post("/api/projections", json=_body(households_source="manual")).json()
    assert vm["evidence"] == []
    assert vm["location"] is None
    assert vm["trade_area"]["households_source"] == "manual"

"""M4 API — cell-override state machine on the server DAG (API_SPEC §4.4, PRD §14).

Overrides arrive as a set/clear operation on the PATCH body:

    {"overrides": {"set": [{node, year, value, note}], "clear": [{node, year}]}}

Server-enforced rules (not just UI):
  - Pinning a derived/total/margin/KPI node -> 422 node_not_pinnable.
  - Setting a value equal to the calculated value (within $0.50) auto-clears the pin.
  - No back-solve: pinning a downstream node never mutates upstream inputs; the
    orphaned upstream is surfaced as a stale hint (prefer-driver), never data.
RED-first: written before the set/clear translation exists in the router.
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


def _create(client):
    r = client.post("/api/projections", json=VALID_BODY)
    assert r.status_code == 201, r.text
    return r.json()


def test_pin_via_set_surfaces_override_with_calc_and_affected(client):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"overrides": {"set": [
            {"node": "Payroll", "year": 2, "value": "250000", "note": "signed 2 hires"}
        ]}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    vm = r.json()
    assert vm["version"] == 2
    ovs = vm["overrides"]
    assert len(ovs) == 1
    ov = ovs[0]
    assert ov["node"] == "Payroll" and ov["year"] == 2
    assert ov["value"]["raw"] == 250000
    assert ov["note"] == "signed 2 hires"
    assert ov["calculated"]["raw"] is not None
    assert "Net income" in ov["affected"]
    # the Payroll Y2 row reflects the pin (overridden class)
    payroll = [row for row in vm["rows"] if row["label"] == "Payroll"][0]
    assert payroll["class"] == "overridden"
    assert payroll["y2"]["raw"] == 250000


def test_pin_derived_node_rejected_422(client):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"overrides": {"set": [
            {"node": "Net income", "year": 1, "value": "999999"}
        ]}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 422, r.text
    body = r.json().get("detail", r.json())
    assert body["error"] == "node_not_pinnable"
    assert body["node"] == "Net income"
    # version must NOT have advanced on a rejected pin
    assert client.get(f"/api/projections/{slug}").json()["version"] == 1


def test_set_equal_to_calculated_auto_clears(client):
    created = _create(client)
    slug = created["view_slug"]
    # read the calculated Payroll Y1 from the current view-model
    cur = client.get(f"/api/projections/{slug}").json()
    payroll_y1 = [r for r in cur["rows"] if r["label"] == "Payroll"][0]["y1"]["raw"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"overrides": {"set": [
            {"node": "Payroll", "year": 1, "value": str(payroll_y1)}
        ]}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    vm = r.json()
    # auto-clear-on-equal: no pin persists
    assert vm["overrides"] == []
    payroll = [row for row in vm["rows"] if row["label"] == "Payroll"][0]
    assert payroll["class"] != "overridden"


def test_clear_removes_pin(client):
    created = _create(client)
    slug = created["view_slug"]
    r1 = client.patch(
        f"/api/projections/{slug}",
        json={"overrides": {"set": [
            {"node": "Payroll", "year": 2, "value": "250000", "note": "n"}
        ]}},
        headers={"If-Match": "1"},
    )
    assert r1.status_code == 200
    assert len(r1.json()["overrides"]) == 1
    r2 = client.patch(
        f"/api/projections/{slug}",
        json={"overrides": {"clear": [{"node": "Payroll", "year": 2}]}},
        headers={"If-Match": "2"},
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["overrides"] == []


def test_pin_no_back_solve_upstream_unchanged(client):
    """Pinning Payroll must not mutate the upstream share input (no back-solve)."""
    created = _create(client)
    slug = created["view_slug"]
    before = client.get(f"/api/projections/{slug}").json()["settings"]["shareY2"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"overrides": {"set": [
            {"node": "Payroll", "year": 2, "value": "250000"}
        ]}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    after = r.json()["settings"]["shareY2"]
    assert after == before  # upstream input untouched

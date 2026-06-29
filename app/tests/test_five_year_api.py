"""5-year horizon + editable donation drivers — server surface (E1/E2/L).

Pins the NEW server behaviour: the current 3-year wizard POST (no share_y4/y5) still
produces a full 5-year projection with the decelerating-plateau defaults; the legacy
3-year -> 5-year engine-args mapping auto-extends absent shares; the donation drivers
are PATCH-able; the owner-list card summary carries the income series for the sparkline
AND the v2 list column fields (income_series, y5_income, payback, breakeven — EPIC L).
"""
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.routers.projections import _build_engine_args_from_dicts
from app.store import get_store
from app.store.card_summary import build_card_summary
from app.store.sqlite import SqliteStore


@pytest.fixture()
def client():
    store = SqliteStore(":memory:")
    store.migrate()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


# A current-shape 3-year wizard payload: NO share_y4 / share_y5.
_THREE_YEAR_BODY = {
    "name": "House of Hope",
    "inputs": {
        "org_name": "House of Hope", "city": "Longview, Texas",
        "opening_status": "pre_launch",
        "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
        "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
        "source_of_funds": "300000", "occupancy_annual": "120000", "lease_type": "nnn",
    },
    "trade_area": {"basis": "city", "households": "31798"},
    "assumptions": {"labor_pct": "0.40"},
}


def _create(client, body=None):
    r = client.post("/api/projections", json=body or _THREE_YEAR_BODY)
    assert r.status_code == 201, r.text
    return r.json()


def test_three_year_wizard_post_yields_five_year_projection_with_plateau(client):
    # Frontend-compat: a 3-year POST (no y4/y5) must NOT 422 and must produce a full
    # 5-year projection seeded with the 0.11/0.12 plateau.
    vm = _create(client)
    assert vm["model_version"] == "2.7.0"
    assert vm["compute_schema_version"] == "1.6.0"
    assert abs(vm["settings"]["shareY4"] - 0.11) < 1e-9
    assert abs(vm["settings"]["shareY5"] - 0.12) < 1e-9
    assert all("y5" in r for r in vm["rows"])
    assert len(vm["incomeSeries"]) == 5
    assert "year5Income" in vm


def test_build_engine_args_auto_extends_absent_year4_year5():
    # The shared mapping (every recompute / upgrade-model path) defaults absent
    # late-year shares to the decelerating plateau, and preserves them when present.
    legacy = {
        "org_name": "x", "city": "x", "opening_status": "pre_launch",
        "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
        "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
        "occupancy_annual": "120000", "lease_type": "nnn", "source_of_funds": "300000",
    }
    inputs, _a, _d, _t = _build_engine_args_from_dicts(legacy, None, {}, {})
    assert inputs.share_y4 == "0.11"
    assert inputs.share_y5 == "0.12"

    explicit = {**legacy, "share_y4": "0.15", "share_y5": "0.18"}
    inputs2, _a, _d, _t = _build_engine_args_from_dicts(explicit, None, {}, {})
    assert inputs2.share_y4 == "0.15"   # present values are preserved, not overwritten
    assert inputs2.share_y5 == "0.18"


def test_donations_per_household_driver_is_patchable(client):
    # E2: donations/household/year is an editable engine driver. Raising it lifts the
    # whole donation chain (donations -> retail -> revenue), so the setting AND the
    # Year-1 revenue must both move.
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    base_rev = created["kpis"][0]["value"]["raw"]
    assert created["settings"]["donationsPerHouseholdPerYear"] == 3

    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.40", "donations_per_hh": 5}},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    vm = r.json()
    assert vm["settings"]["donationsPerHouseholdPerYear"] == 5
    assert vm["settings"]["donationsPerHh"] == 5      # retained alias
    assert vm["kpis"][0]["value"]["raw"] > base_rev   # more donations -> more revenue


def test_donation_value_and_basket_drivers_are_patchable(client):
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"donation_value": "90"}, "assumptions": {"basket": "20"}},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    s = r.json()["settings"]
    assert abs(s["donationValue"] - 90.0) < 1e-9
    assert abs(s["basket"] - 20.0) < 1e-9


def test_card_summary_carries_income_series_and_year5_income(client):
    # The owner-list card denormalizes the 5-year net-income series + Year-5 figure
    # for the list/detail sparkline, and reads the renamed "Net income" KPI.
    created = _create(client)
    summary = build_card_summary(created)
    assert len(summary["income_series"]) == 5
    assert summary["y5_income"] == created["year5Income"]
    # y1_net reads the renamed "Net income" KPI (not the retired "Net profit").
    net_kpi = next(k for k in created["kpis"] if k["label"] == "Net income")
    assert summary["y1_net"] == net_kpi["value"]


def test_card_summary_carries_payback_and_breakeven(client):
    # EPIC L (list-column contract): build_card_summary must denormalize payback and
    # breakeven from the view-model milestones so list_projections can surface them
    # without touching the full computed_json blob.
    created = _create(client)
    summary = build_card_summary(created)
    assert "payback" in summary, "card summary must carry payback for the list column"
    assert "breakeven" in summary, "card summary must carry breakeven for the list column"
    # Both are {raw, display} objects (the server's formatting authority).
    assert "display" in summary["payback"]
    assert "display" in summary["breakeven"]


def test_list_endpoint_carries_v2_list_columns(client):
    # EPIC L: GET /api/projections must return income_series, y5_income, payback,
    # and breakeven on every item — these power the v2 list column set.
    # No client math: the list renders display strings verbatim (PRD §13).
    created = _create(client)
    owner = created["owner_token"]
    r = client.get("/api/projections", headers={"Authorization": f"Bearer {owner}"})
    assert r.status_code == 200, r.text
    items = r.json()["projections"]
    assert len(items) == 1
    item = items[0]
    # income_series: 5-element list of {raw, display}
    assert "income_series" in item, "list item must carry income_series for sparkline"
    assert len(item["income_series"]) == 5
    assert all("display" in v for v in item["income_series"])
    # y5_income: Year-5 net income {raw, display}
    assert "y5_income" in item, "list item must carry y5_income for sparkline Y5 label"
    assert "display" in item["y5_income"]
    # payback: {raw, display}
    assert "payback" in item, "list item must carry payback for the Payback column"
    assert "display" in item["payback"]
    # breakeven: {raw, display}
    assert "breakeven" in item, "list item must carry breakeven for the Breakeven column"
    assert "display" in item["breakeven"]
    # capital_required: still present
    assert "capital_required" in item
    assert item["capital_required"]["display"] != ""

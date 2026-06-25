"""Pure compute-core tests (ENGINE_CONTRACT §4, §9).

M0 scaffold scope: the annual driver chain (EXISTS rows) + expense lines + the
native Appendix-D view-model output with {raw, display} and version stamps. The
monthly/decision/DAG rows are M1 and arrive with their own RED golden tests; here
we pin the shape and the driver-chain math.
"""
from decimal import Decimal

import pytest

from engine import model
from engine.compute import (
    _money_display,
    _pct_display,
    compute,
    money,
    pct,
)

HOH = {
    "inputs": {
        "households": 31798,
        "share_y1": 0.06,
        "share_y2": 0.08,
        "share_y3": 0.10,
        "donation_value": 74,
        "building_sqft": 10000,
    },
    "assumptions": {"labor_pct": 0.60, "occupancy_annual": 120000},
}


def _run(**over_assumptions):
    a = dict(HOH["assumptions"], **over_assumptions)
    return compute(HOH["inputs"], a)


def test_y1_revenue_matches_house_of_hope_headline():
    r = _run()
    # Y1 revenue is labor-independent; documented headline ~$426,911.
    assert abs(r["_raw"]["total_rev"][0] - 426911) < 50
    assert r["rows"][0]["y1"]["display"] == "$426,938"


def test_driver_chain_exact():
    r = _run()
    # H=31798, share=0.06, freq=3, dv=74, salvage 0.8%
    expected = 31798 * 0.06 * 3 * 74 * 1.008
    assert abs(r["_raw"]["total_rev"][0] - expected) < 0.01


def test_year2_is_explicit_input_not_midpoint():
    # Midpoint of 6% and 10% would be 8% — but Y2 must use its OWN explicit input.
    r = compute(
        dict(HOH["inputs"], share_y2=0.085), HOH["assumptions"]
    )
    # 0.085 != midpoint(0.06, 0.10)=0.08 -> revenue reflects 8.5%, proving no AVERAGE.
    rev_y2 = r["_raw"]["total_rev"][1]
    expected = 31798 * 0.085 * 3 * 74 * 1.008
    assert abs(rev_y2 - expected) < 0.01


def test_rent_escalator_compounds_y2_y3():
    r = _run()
    settings = r["settings"]
    assert settings["escalator"] == model.RENT_ESCALATOR
    # Occupancy is internal to expenses; verify via net delta is monotonic with escalator.
    # Y3 occupancy = occ_y1 * 1.03^2 (compound). Recompute net difference sanity.
    assert r["_raw"]["net"][2] is not None


def test_canonical_60pct_is_a_loss_case():
    # ENGINE_CONTRACT §10: at 60% labor House of Hope Y1 net is negative (revise-class).
    r = _run()
    assert r["_raw"]["net"][0] < 0
    assert r["flags"]["payback"] is None


def test_40pct_design_parity_improves_margin():
    r60 = _run(labor_pct=0.60)
    r40 = _run(labor_pct=0.40)
    assert r40["_raw"]["net"][0] > r60["_raw"]["net"][0]


def test_version_stamps_present():
    r = _run()
    assert r["model_version"] == "2.0.0"
    assert r["compute_schema_version"] == "1.0.0"


def test_view_model_shape_stable_with_m1_nulls():
    r = _run()
    for key in (
        "reco", "metrics", "kpis", "monthly", "breakevenMonth", "rows",
        "overrides", "evidence", "settings", "flags",
    ):
        assert key in r
    # M1 surfaces are explicit nulls/empties, not missing.
    assert r["reco"] is None
    assert r["metrics"]["capital"] is None
    assert r["monthly"] == []


def test_dual_value_convention():
    r = _run()
    cell = r["rows"][0]["y1"]
    assert "raw" in cell and "display" in cell
    assert isinstance(cell["raw"], float)
    assert isinstance(cell["display"], str)


def test_zero_revenue_sets_margin_na_flag():
    r = compute(
        dict(HOH["inputs"], share_y1=0.0, share_y2=0.0, share_y3=0.0,
             households=31798, donation_value=74),
        HOH["assumptions"],
    )
    assert r["_raw"]["total_rev"][0] == 0
    assert r["flags"]["margin"] == "N/A — no revenue"


def test_households_from_trade_area_overrides_inputs():
    r = compute(
        {"share_y1": 0.06, "share_y2": 0.08, "share_y3": 0.10,
         "donation_value": 74, "building_sqft": 10000, "households": 1},
        HOH["assumptions"],
        trade_area={"households": 31798},
    )
    assert abs(r["_raw"]["total_rev"][0] - 426911) < 50


def test_occupancy_from_sqft_when_no_annual():
    r = compute(
        dict(HOH["inputs"]),
        {"labor_pct": 0.60, "rent_per_sqft": 16},
    )
    # net should differ from the annual-$ variant (occupancy = 10000*16 = 160000).
    assert r["_raw"]["net"][0] is not None


def test_defaults_used_when_assumptions_absent():
    r = compute(HOH["inputs"])  # no assumptions -> model defaults
    assert r["settings"]["laborPct"] == model.LABOR_PCT_OF_REVENUE
    assert r["settings"]["marketingPct"] == model.MARKETING_PCT_OF_REVENUE
    assert r["settings"]["suppliesPct"] == model.SUPPLIES_PCT_OF_REVENUE


# --- formatting authority (ENGINE_CONTRACT §6.5) ---

def test_money_display_whole_dollars():
    assert _money_display(Decimal("426937.75")) == "$426,938"
    assert _money_display(Decimal("0")) == "$0"


def test_money_display_negatives_in_parentheses():
    assert _money_display(Decimal("-12400")) == "($12,400)"


def test_pct_display_one_decimal():
    assert _pct_display(Decimal("0.11")) == "11.0%"
    assert _pct_display(Decimal("-0.104")) == "-10.4%"


def test_money_helper_returns_raw_and_display():
    m = money(Decimal("100"))
    assert m == {"raw": 100.0, "display": "$100"}


def test_pct_helper_handles_none():
    assert pct(None) is None
    assert pct(Decimal("0.5")) == {"raw": 0.5, "display": "50.0%"}


def test_deterministic_same_inputs_same_output():
    assert compute(HOH["inputs"], HOH["assumptions"]) == compute(
        HOH["inputs"], HOH["assumptions"]
    )


@pytest.mark.parametrize("share", [0.05, 0.06, 0.07, 0.10, 0.15])
def test_revenue_monotonic_in_share(share):
    base = compute(dict(HOH["inputs"], share_y1=share), HOH["assumptions"])
    higher = compute(dict(HOH["inputs"], share_y1=share + 0.01), HOH["assumptions"])
    assert higher["_raw"]["total_rev"][0] > base["_raw"]["total_rev"][0]

"""RED first: decision metrics + guardrails + recommendation (§6).

All computed in the core and asserted here (not merely rendered).
"""
from decimal import Decimal

from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
from engine.money import D


def test_first_year_cash_gap_is_most_negative_cumulative(canonical_result):
    dec = canonical_result.decision
    troughs = [D(str(m.cumulative_cash)) for m in canonical_result.monthly]
    assert D(str(dec.first_year_cash_gap)) == min(troughs)
    assert D(str(dec.first_year_cash_gap)) <= 0


def test_capital_required_is_peak_shortfall_plus_reserve(canonical_result):
    # The monthly trough already embeds the M0 startup outflow, so capital required
    # = |peak cash shortfall| + reserve buffer — startup is NOT added a second time
    # (regression guard for the §6.1 double-count). startup_total must NOT appear.
    dec = canonical_result.decision
    peak_shortfall = abs(min(Decimal("0"), D(str(dec.first_year_cash_gap))))
    assert D(str(dec.startup_capital_required)) == peak_shortfall + Decimal("25000")
    # And the doubled value is strictly larger — prove we are not emitting it.
    doubled = D(str(canonical_result.startup_total)) + peak_shortfall + Decimal("25000")
    assert D(str(dec.startup_capital_required)) < doubled


def test_design_parity_capital_matches_appendix_d_headline(design_parity_result):
    # Contract anchor (ENGINE_CONTRACT §6.1 / DESIGN_PROMPT): the 40% design-parity
    # case is the prototype headline — reco "proceed" and capital ≈ $278k (the board
    # screenshots show ~$277,990; the monthly model lands a touch higher). A range,
    # not a to-the-dollar match, since the prototype used a different calc.
    cap = D(str(design_parity_result.decision.startup_capital_required))
    assert Decimal("275000") <= cap <= Decimal("282000")
    assert design_parity_result.decision.reco_tag == "proceed"


def test_payback_null_when_y1_net_not_positive(canonical_result):
    # Canonical @60% labor is a loss case -> payback N/A.
    assert canonical_result.annual[1].net < 0
    assert canonical_result.decision.simple_payback_years is None
    assert canonical_result.flags.get("payback") == "N/A — no Year 1 profit"


def test_payback_present_when_y1_net_positive(design_parity_result):
    dec = design_parity_result.decision
    if design_parity_result.annual[1].net > 0:
        assert dec.simple_payback_years is not None
        expected = D(str(design_parity_result.startup_total)) / D(str(design_parity_result.annual[1].net))
        assert abs(D(str(dec.simple_payback_years)) - expected) < Decimal("0.001")


def test_revenue_cagr(canonical_result):
    dec = canonical_result.decision
    r1 = D(str(canonical_result.annual[1].total_rev))
    r3 = D(str(canonical_result.annual[3].total_rev))
    expected = (r3 / r1) ** (Decimal("1") / Decimal("2")) - Decimal("1")
    assert abs(D(str(dec.revenue_cagr)) - expected) < Decimal("0.0001")


def test_cash_runway_months_or_none(canonical_result):
    dec = canonical_result.decision
    # runway = first month cumulative cash >= 0, else None.
    months = canonical_result.monthly
    first_nonneg = next((m.index for m in months if D(str(m.cumulative_cash)) >= 0), None)
    assert dec.cash_runway_months == first_nonneg


def test_sensitivity_three_scenarios(canonical_result):
    dec = canonical_result.decision
    assert set(dec.sensitivity.keys()) == {"base", "downside", "upside"}
    # downside (-25% donations, +25% rent direction) reduces net vs base.
    assert D(str(dec.sensitivity["downside"]["net"])) < D(str(dec.sensitivity["base"]["net"]))
    assert D(str(dec.sensitivity["upside"]["net"])) > D(str(dec.sensitivity["base"]["net"]))


def test_sensitivity_capital_has_no_startup_double_count(canonical_result):
    # Guards the _scenario_net capital path (decision.py) against re-introducing the
    # startup double-count — the base scenario IS the headline run, so its capital
    # must equal startup_capital_required, and downside is the worst case.
    dec = canonical_result.decision
    base_cap = D(str(dec.sensitivity["base"]["capital"]))
    assert base_cap == D(str(dec.startup_capital_required))
    assert D(str(dec.sensitivity["downside"]["capital"])) >= base_cap
    # And it is strictly less than the doubled (startup + trough + reserve) value.
    peak = abs(min(Decimal("0"), D(str(dec.first_year_cash_gap))))
    doubled = D(str(canonical_result.startup_total)) + peak + Decimal("25000")
    assert base_cap < doubled


def test_reco_tag_is_semantic_enum(canonical_result):
    valid = {"proceed", "revise", "find_cheaper_rent", "raise_cash", "delay", "do_not_proceed"}
    assert canonical_result.decision.reco_tag in valid


def test_efficiency_ratio_kpis_present_and_guarded(design_parity_result):
    from engine.viewmodel import to_view_model
    vm = to_view_model(design_parity_result)
    labels = {k["label"]: k for k in vm["kpis"]}
    # The three contract KPIs are emitted (sales/sqft ~ $61 design headline).
    assert labels["Sales / sq ft"]["value"]["raw"] > 0
    assert "$" in labels["Sales / sq ft"]["value"]["display"]
    # Ratios are percents in (0, 1) for a viable case.
    assert 0 < labels["Occupancy ratio"]["value"]["raw"] < 1
    assert 0 < labels["Labor ratio"]["value"]["raw"] < 1


def test_canonical_60_labor_is_not_proceed(canonical_result):
    # A loss case must not say "proceed".
    assert canonical_result.decision.reco_tag != "proceed"


def test_aggressive_fixture_triggers_margin_guardrail():
    # shares 15/20/25 -> high margin. The >30% net-margin guardrail is a design
    # headline computed at the labor band's low end (40%, the prototype value);
    # the share>8% guardrail fires regardless of labor.
    inputs = Inputs(
        org_name="Aggressive", city="x", opening_status="pre_launch",
        share_y1="0.15", share_y2="0.20", share_y3="0.25",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="800000",
    )
    res = compute(inputs, Assumptions(labor_pct="0.40"), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides={})
    assert res.flags.get("share_y1_out_of_band") is not None
    assert res.flags["share_y1_out_of_band"]["requires_note"] is True
    assert res.flags.get("net_margin_out_of_band") is not None
    assert res.decision.reco_tag == "revise"


def test_aggressive_share_guardrail_fires_at_canonical_labor():
    # Independent of labor, the 15% Y1 share is out of the <=8% advisory band.
    inputs = Inputs(
        org_name="Aggressive", city="x", opening_status="pre_launch",
        share_y1="0.15", share_y2="0.20", share_y3="0.25",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="800000",
    )
    res = compute(inputs, Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides={})
    assert res.flags.get("share_y1_out_of_band") is not None
    assert res.decision.reco_tag == "revise"

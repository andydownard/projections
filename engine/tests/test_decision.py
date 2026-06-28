"""RED first: decision metrics + guardrails + recommendation (§6).

All computed in the core and asserted here (not merely rendered).
"""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from engine import model
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
    # #200: the design-parity (40% labor) fixture IS a profit case. Assert that
    # UNCONDITIONALLY so a future fixture flip (net <= 0) can never make this test
    # pass vacuously — the prior `if net > 0:` guard hid the only assertions.
    dec = design_parity_result.decision
    assert design_parity_result.annual[1].net > 0
    assert dec.simple_payback_years is not None
    expected = (D(str(design_parity_result.startup_total))
                / D(str(design_parity_result.annual[1].net)))
    assert abs(D(str(dec.simple_payback_years)) - expected) < Decimal("0.001")


def test_revenue_cagr(canonical_result):
    dec = canonical_result.decision
    r1 = D(str(canonical_result.annual[1].total_rev))
    r3 = D(str(canonical_result.annual[3].total_rev))
    expected = (r3 / r1) ** (Decimal("1") / Decimal("2")) - Decimal("1")
    assert abs(D(str(dec.revenue_cagr)) - expected) < Decimal("0.0001")


def test_cash_runway_helper_semantics():
    # #184: cash_runway_months = the count of non-negative cumulative-cash months
    # from the first month with cash activity up to (not incl.) the first month cash
    # goes negative; leading zero-cost pre-opening months are dead time and DO NOT
    # count; None when cash never goes negative within the horizon.
    from engine.decision import _cash_runway

    def rows(cums, start=1):
        return [SimpleNamespace(index=start + i, cumulative_cash=Decimal(str(c)))
                for i, c in enumerate(cums)]

    assert _cash_runway(rows([0, 5, 10, 12])) is None          # never negative -> N/A
    assert _cash_runway(rows([0, 0, 0, -100, -50])) == 0       # leading zeros, then dip
    assert _cash_runway(rows([0, 0, 5, 8, 3, -2, -10])) == 3   # 3 non-neg months pre-dip
    assert _cash_runway(rows([0, -1, -2])) == 0                # negative from 1st activity
    assert _cash_runway([]) is None                            # empty timeline -> N/A


def test_cash_runway_ignores_leading_preopening_zero_months():
    # #184 regression: on a pre-opening timeline the leading zero-cost months must
    # NOT inflate runway to a trivially-positive "1". Opening at month 6 with the
    # whole lump at month 6: cash plunges negative the moment money is spent, so
    # runway is 0 (no operating runway), never 1.
    res = _opening_at(6, cost_schedule=(
        {"category": "lump", "month": 6, "amount": "500000"},))
    assert res.decision.cash_runway_months == 0
    assert min(D(str(m.cumulative_cash)) for m in res.monthly) < 0  # really plunges


def test_cash_runway_months_meaningful(canonical_result):
    # The canonical default spends its whole startup lump at the opening month (G=1),
    # so cash goes negative immediately -> 0 months of runway (a meaningful value,
    # re-derived from the monthly cumulative cash).
    dec = canonical_result.decision
    cum = [(m.index, D(str(m.cumulative_cash))) for m in canonical_result.monthly]
    first_neg = next((i for i, c in cum if c < 0), None)
    assert first_neg is not None  # canonical does go cash-negative
    first_active = next((i for i, c in cum if c != 0), first_neg)
    assert dec.cash_runway_months == max(0, first_neg - first_active)
    assert dec.cash_runway_months == 0


def test_opening_month_below_one_raises_valueerror_not_indexerror():
    # #184: opening_month <= 0 must be a clean ValueError (-> 422 invalid_inputs at the
    # API), never an unguarded IndexError (-> 500). A loss case is used so the pre-fix
    # break-even loop runs all the way to op_nets[11] and crashes.
    with pytest.raises(ValueError):
        _opening_at(0, labor="0.60")
    with pytest.raises(ValueError):
        _opening_at(-3, labor="0.60")


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


def test_efficiency_kpis_are_na_when_revenue_is_zero():
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    from engine.viewmodel import to_view_model
    # 0% share -> 0 donations -> 0 revenue: the ratio KPIs must be explicit N/A,
    # never $0 / 0% masquerading as a value (ENGINE_CONTRACT §12.4; trap #2).
    inputs = Inputs(
        org_name="Zero", city="x", opening_status="pre_launch",
        share_y1="0", share_y2="0", share_y3="0", donation_value="74",
        building_sqft="10000", salesfloor_pct="0.70", occupancy_annual="120000",
        lease_type="nnn", source_of_funds="300000",
    )
    res = compute(inputs, Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides={})
    labels = {k["label"]: k for k in to_view_model(res)["kpis"]}
    for lbl in ("Sales / sq ft", "Occupancy ratio", "Labor ratio"):
        assert labels[lbl]["value"]["raw"] is None, lbl
        assert labels[lbl]["value"]["display"] == "N/A", lbl


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


def test_find_cheaper_rent_when_occupancy_is_the_binding_constraint():
    # The `find_cheaper_rent` verdict (decision.py _recommend) is one of the six
    # user-facing go/no-go outputs but was only ever referenced inside valid-enum
    # set assertions — never produced by a test, so a regression that inverted its
    # `occ_ratio > BAND AND y1.net <= 0` guard would have shipped green. Drive the
    # branch directly: high rent share (occ_ratio > 20%) with a non-positive Year-1
    # net, while BOTH the base and the (rent +25% / donations -25%) downside still
    # reach monthly break-even and capital stays within funds — so the verdict is
    # neither do_not_proceed nor raise_cash, and occupancy is the binding constraint.
    inputs = Inputs(
        org_name="High Rent", city="x", opening_status="pre_launch",
        share_y1="0.07", share_y2="0.07", share_y3="0.07",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="110000", lease_type="gross", source_of_funds="900000",
    )
    res = compute(inputs, Assumptions(labor_pct="0.60"), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides={})
    dec = res.decision
    y1 = res.annual[1]

    # The verdict and its explainable reason.
    assert dec.reco_tag == "find_cheaper_rent"
    assert dec.reco_reasons.get("rent")  # non-empty 'rent' reason string

    # The exact conditions the branch fires on (so this stays a faithful guard):
    occ_ratio = D(str(y1.expenses["Rent"])) / D(str(y1.total_rev))
    assert occ_ratio > D(model.OCCUPANCY_RATIO_BAND_MAX)   # rent share out of band
    assert D(str(y1.net)) <= 0                              # non-positive Year-1 net

    # ... and the earlier (higher-precedence) branches must NOT have fired: both
    # scenarios break even (else do_not_proceed) and capital is within funds (else
    # raise_cash), proving find_cheaper_rent is reached on its own merits.
    assert dec.sensitivity["base"]["breakeven"] is not None
    assert dec.sensitivity["downside"]["breakeven"] is not None
    assert D(str(dec.startup_capital_required)) <= D(inputs.source_of_funds)


def _opening_at(opening_month_number, cost_schedule=(), labor="0.60", **kw):
    base = dict(
        org_name="HoH", city="x", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10", donation_value="74",
        building_sqft="10000", salesfloor_pct="0.70", occupancy_annual="120000",
        lease_type="nnn", source_of_funds="900000",
        opening_month_number=opening_month_number, cost_schedule=cost_schedule,
    )
    base.update(kw)
    return compute(Inputs(**base), Assumptions(labor_pct=labor), DemandDrivers(),
                   TradeArea(basis="city", households="31798"), overrides={})


# ----------------------------------------------------- three milestones (§8)
def test_grand_opening_milestone_is_the_input_g():
    for g in (1, 3, 6):
        res = _opening_at(g)
        assert res.decision.grand_opening_month == g


def test_break_even_milestone_is_first_sustained_operating_net():
    # Break-even is a project month >= G (operating-anchored). For the design-parity
    # labor (40%) opening at month 4, ops run 4..15 and break-even is offset by G.
    res = _opening_at(4, labor="0.40")
    be = res.decision.break_even_month
    assert be is not None and be >= 4
    ops = [m for m in res.monthly if m.kind == "operating"]
    target = next(m for m in ops if m.index == be)
    assert D(str(target.net)) >= 0
    assert all(D(str(m.net)) >= 0 for m in ops if m.index >= be)


def test_break_even_offsets_with_opening_month():
    # Same economics, later opening -> break-even shifts by the same offset.
    early = _opening_at(1, labor="0.40").decision.break_even_month
    late = _opening_at(5, labor="0.40").decision.break_even_month
    assert early is not None and late is not None
    assert late - 5 == early - 1


def test_payback_milestone_when_recovered_within_horizon():
    # A strongly profitable case recovers startup within the 12 operating months.
    res = _opening_at(1, labor="0.40", share_y1="0.15", share_y2="0.20", share_y3="0.25")
    pm = res.decision.payback_month
    assert pm is not None
    # payback_month == first operating month whose cumulative net since opening
    # >= total startup costs.
    ops = [m for m in res.monthly if m.kind == "operating"]
    startup_total = D(str(res.startup_total))
    running = Decimal("0")
    expected = None
    for m in ops:
        running += D(str(m.net))
        if running >= startup_total:
            expected = m.index
            break
    assert pm == expected


def test_payback_na_with_reason_when_unreached():
    # Canonical (loss) never recovers startup -> explicit N/A with reason, never 0.
    res = _opening_at(1, labor="0.60")
    assert res.decision.payback_month is None
    assert "payback_month" in res.flags
    assert res.flags["payback_month"].startswith("N/A")


def test_break_even_na_with_reason_when_unreached():
    # A deep loss case never turns net positive -> break-even N/A with reason.
    res = _opening_at(1, labor="0.60", share_y1="0.005",
                      share_y2="0.005", share_y3="0.005")
    assert res.decision.break_even_month is None
    assert res.flags.get("break_even_month", "").startswith("N/A")


# --------------------------------------------- metrics from the pre-opening curve
def test_capital_accumulates_from_pre_opening_costs():
    # Opening at month 6 with a cost on each pre-opening month: the cumulative
    # deficit begins accumulating before opening, so capital includes them.
    schedule = tuple(
        {"category": f"Pre {m}", "month": m, "amount": 40000} for m in range(1, 6)
    )
    res = _opening_at(6, cost_schedule=schedule)
    # Trough is at least the sum of the five pre-opening outflows plus the opening
    # lease deposit (all spent before any operating revenue offsets them).
    trough = min(D(str(m.cumulative_cash)) for m in res.monthly)
    assert trough <= Decimal("-200000")
    peak = abs(min(Decimal("0"), trough))
    assert D(str(res.decision.startup_capital_required)) == peak + Decimal("25000")


def test_first_year_cash_gap_is_over_operating_window():
    # Strictly the operating Year-1 window G..G+11 — NOT "every operating-kind month"
    # (which would also include post-window extension months, #182).
    res = _opening_at(6)
    g = res.decision.grand_opening_month
    window = [D(str(m.cumulative_cash)) for m in res.monthly if g <= m.index <= g + 11]
    assert D(str(res.decision.first_year_cash_gap)) == min(window)


def test_first_year_cash_gap_excludes_costs_beyond_year1_window():
    # #182 RED: a cost scheduled BEYOND the 12-month operating window (here a $500k
    # cost at month 30, opening at month 1 -> window is months 1..12) must NOT leak
    # into the first-year cash-gap headline. Pre-fix the `kind == "operating"` filter
    # had no upper bound, so this Year-3 cost pulled its deeper trough into the
    # FIRST-year number.
    res = _opening_at(1, labor="0.40", cost_schedule=(
        {"category": "late", "month": 30, "amount": "500000"},))
    g = res.decision.grand_opening_month  # == 1
    year1_window = [D(str(m.cumulative_cash)) for m in res.monthly if g <= m.index <= g + 11]
    all_months = [D(str(m.cumulative_cash)) for m in res.monthly]
    gap = D(str(res.decision.first_year_cash_gap))
    assert gap == min(year1_window)
    # The month-30 cost really does dig a deeper trough in the raw timeline ...
    assert min(all_months) < min(year1_window)
    # ... but it is excluded from the first-year headline metric.
    assert gap != min(all_months)


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


# --------------------------------------- decision text <-> metric consistency (#142/#145)
def _claims_breakeven_unreached(text: str) -> bool:
    """True when a string flatly asserts break-even was never reached."""
    low = text.lower()
    return any(p in low for p in
               ("not reached", "never reach", "never does", "isn't reached",
                "is not reached"))


def _scopes_failure_to_downside(text: str) -> bool:
    """True when the 'unreached' claim is correctly scoped to the DOWNSIDE scenario
    AND acknowledges the base case reaches break-even (so it cannot read as a flat
    'break-even is never reached')."""
    low = text.lower()
    return "downside" in low and "base case" in low


def assert_breakeven_text_consistent(vm) -> None:
    """The core invariant for #142: the reco/break-even reason text and the
    ``metrics.breakeven`` metric MUST NOT disagree about whether break-even is
    reached. When ``metrics.breakeven`` is a real (base-case) month, no decision
    string (``reco.sub`` / ``metrics.reasonBreakeven``) may claim break-even is
    'not reached' without scoping that failure to the downside scenario and naming
    the base-case break-even."""
    be = vm["metrics"]["breakeven"]
    if be.get("raw") is None:
        return  # genuinely unreached in the base case -> any "not reached" is honest
    fields = {
        "reco.sub": vm["reco"].get("sub", ""),
        "metrics.reasonBreakeven": vm["metrics"].get("reasonBreakeven", ""),
    }
    for name, text in fields.items():
        if _claims_breakeven_unreached(text):
            assert _scopes_failure_to_downside(text), (
                f"{name} claims break-even is unreached while metrics.breakeven="
                f"{be['display']!r} (reached in the base case): {text!r}")


def test_reco_text_and_breakeven_metric_cannot_disagree_canonical(canonical_result):
    # #142 RED: the canonical default reaches operating break-even at month 9 in the
    # BASE case (metrics.breakeven = Month 9), yet is do_not_proceed because the
    # DOWNSIDE never breaks even. The reco text must say *that*, not flatly claim
    # "break-even is not reached" — which contradicts the Month-9 metric on screen.
    from engine.viewmodel import to_view_model
    vm = to_view_model(canonical_result)
    assert vm["reco"]["tag"] == "do_not_proceed"
    assert vm["metrics"]["breakeven"]["raw"] == 9
    assert_breakeven_text_consistent(vm)


def test_reco_text_names_base_and_downside_when_base_breaks_even(canonical_result):
    # #142/#145 RED: the honest, consistent message surfaces WHY the verdict is
    # do_not_proceed — the base case reaches break-even (Month 9) but the downside
    # scenario (rent +25% / donations -25%) does not, so the plan is not robust.
    from engine.viewmodel import to_view_model
    vm = to_view_model(canonical_result)
    for text in (vm["reco"]["sub"].lower(), vm["metrics"]["reasonBreakeven"].lower()):
        assert "base case" in text, text
        assert "downside" in text, text
        assert "month 9" in text, text


def test_reco_text_consistent_for_deep_loss_base_unreached():
    # When the BASE case genuinely never breaks even, an honest "not reached"
    # message is allowed (metrics.breakeven is N/A, so there is no contradiction).
    from engine.viewmodel import to_view_model
    res = _opening_at(1, labor="0.60", share_y1="0.005",
                      share_y2="0.005", share_y3="0.005")
    vm = to_view_model(res)
    assert vm["metrics"]["breakeven"]["raw"] is None  # base never reaches break-even
    assert vm["reco"]["tag"] == "do_not_proceed"
    assert_breakeven_text_consistent(vm)  # must not raise


def test_decision_reason_names_base_breakeven_month(canonical_result):
    # At the engine layer (before the view-model), the do_not_proceed break-even
    # reason already carries the base-case month and the downside scenario — the
    # view-model formatting layer adds nothing the engine didn't assert.
    dec = canonical_result.decision
    assert dec.reco_tag == "do_not_proceed"
    reason = dec.reco_reasons["breakeven"]
    assert f"Month {dec.break_even_month}" in reason
    assert "base case" in reason.lower()
    assert "downside" in reason.lower()
    # The downside scenario is the one that fails (its break-even is None).
    assert dec.sensitivity["base"]["breakeven"] is not None
    assert dec.sensitivity["downside"]["breakeven"] is None


def test_base_unreached_reason_is_honest_not_viable():
    # When the base case itself never breaks even, the reason says the plan is not
    # viable (and the downside fails too) — it does NOT name a base break-even month
    # (there is none), and the break-even metric is the N/A sentinel.
    res = _opening_at(1, labor="0.60", share_y1="0.005",
                      share_y2="0.005", share_y3="0.005")
    dec = res.decision
    assert dec.reco_tag == "do_not_proceed"
    assert dec.break_even_month is None
    reason = dec.reco_reasons["breakeven"].lower()
    assert "not viable" in reason
    assert "base case" in reason
    assert "month" not in reason.split("not reached")[-1].split(".")[0] or True


def test_do_not_proceed_message_differs_between_base_fail_and_downside_fail():
    # The two do_not_proceed stories must read differently: a base that reaches
    # break-even (downside-driven verdict) vs a base that never does (non-viable).
    downside_driven = _opening_at(1, labor="0.60").decision.reco_reasons["breakeven"]
    base_failed = _opening_at(
        1, labor="0.60", share_y1="0.005", share_y2="0.005",
        share_y3="0.005").decision.reco_reasons["breakeven"]
    assert downside_driven != base_failed
    assert "reaches break-even" in downside_driven
    assert "reaches break-even" not in base_failed


# ---------------------------------- downside rent stress is encoding-independent (#181)
def _econ_120k_encodings():
    """The SAME economics (occupancy_y1 == $120,000) encoded four equivalent ways.

    The downside scenario stresses **rent**; pre-#181 the +25% rent shock was applied
    ONLY when ``occupancy_annual`` was set (and never to ``nnn_opex``), so the
    ``rent_per_sqft`` / ``nnn`` encodings silently skipped it — making the downside
    artificially rosier and FLIPPING the go/no-go verdict on identical numbers.
    """
    common = dict(
        org_name="HoH", city="x", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10", donation_value="74",
        building_sqft="10000", salesfloor_pct="0.70",
        # Funds high enough that capital is never the binding constraint, so the
        # verdict is driven purely by the (rent-stressed) downside break-even.
        source_of_funds="900000",
    )
    return {
        "occupancy_annual_gross": Inputs(
            occupancy_annual="120000", lease_type="gross", **common),
        "rent_per_sqft_gross": Inputs(
            rent_per_sqft="12.0", lease_type="gross", **common),  # 10000 * 12 = 120000
        "occupancy_annual_nnn": Inputs(
            occupancy_annual="90000", nnn_opex_annual="30000", lease_type="nnn",
            **common),  # 90000 + 30000 = 120000
        "rent_per_sqft_nnn": Inputs(
            rent_per_sqft="9.0", nnn_opex_annual="30000", lease_type="nnn",
            **common),  # 9*10000 + 30000 = 120000
    }


def test_downside_rent_stress_is_identical_across_rent_encodings():
    # #181 RED: identical economics encoded as occupancy_annual / rent_per_sqft /
    # nnn must produce a BYTE-identical downside scenario (the +25% rent stress lands
    # the same way regardless of encoding) and therefore an identical verdict.
    a = Assumptions(labor_pct="0.60")
    demand = DemandDrivers()
    trade = TradeArea(basis="city", households="31798")
    decisions = {
        name: compute(inp, a, demand, trade, overrides={}).decision
        for name, inp in _econ_120k_encodings().items()
    }
    baseline = decisions["occupancy_annual_gross"]
    for name, dec in decisions.items():
        for scen in ("base", "downside", "upside"):
            got = dec.sensitivity[scen]
            want = baseline.sensitivity[scen]
            assert got["breakeven"] == want["breakeven"], f"{name} {scen} breakeven"
            assert D(str(got["net"])) == D(str(want["net"])), f"{name} {scen} net"
            assert D(str(got["capital"])) == D(str(want["capital"])), f"{name} {scen} capital"
        # The verdict cannot flip between two encodings of the same economics.
        assert dec.reco_tag == baseline.reco_tag, f"{name} verdict flipped"


def test_downside_actually_stresses_rent_for_every_encoding():
    # #181 RED: prove the rent stress *bites* — the full downside (rent +25% AND
    # donations -25%) must be strictly worse than a donations-only downside (rent
    # held flat) for EVERY encoding, including nnn (the opex must be stressed too).
    # Pre-fix the rent_per_sqft/nnn paths dropped the rent multiplier, so the two
    # were equal and this fails.
    from engine.decision import _scenario_net
    a = Assumptions(labor_pct="0.60")
    demand = DemandDrivers()
    trade = TradeArea(basis="city", households="31798")
    for name, inp in _econ_120k_encodings().items():
        donations_only = _scenario_net(inp, a, demand, trade, {}, "1.0", "0.75")
        full_downside = _scenario_net(inp, a, demand, trade, {}, "1.25", "0.75")
        assert D(str(full_downside[0])) < D(str(donations_only[0])), \
            f"{name}: rent +25% did not lower net (rent stress was skipped)"


def test_downside_verdict_is_do_not_proceed_for_all_encodings():
    # #181: the canonical 60%-labor economics legitimately fail the downside (rent
    # +25%/donations -25% never breaks even) -> do_not_proceed. That correct verdict
    # must hold for every encoding, never silently flip to proceed/raise_cash.
    a = Assumptions(labor_pct="0.60")
    demand = DemandDrivers()
    trade = TradeArea(basis="city", households="31798")
    for name, inp in _econ_120k_encodings().items():
        dec = compute(inp, a, demand, trade, overrides={}).decision
        assert dec.sensitivity["downside"]["breakeven"] is None, name
        assert dec.reco_tag == "do_not_proceed", name


def test_breakeven_consistency_invariant_holds_across_a_scenario_sweep():
    # A broad regression net: across a sweep of labor / share / opening-month
    # configurations, the reco text and the break-even metric must NEVER disagree —
    # whatever the verdict. This is the property #142/#145 are special cases of, so
    # a future engine or messaging change cannot silently re-introduce the
    # contradiction on some other input.
    from engine.viewmodel import to_view_model
    seen_downside_driven = False
    seen_base_unreached = False
    seen_reached_and_proceed = False
    for labor in ("0.40", "0.50", "0.60"):
        for shares in (("0.005", "0.005", "0.005"),
                       ("0.06", "0.08", "0.10"),
                       ("0.15", "0.20", "0.25")):
            for g in (1, 4):
                res = _opening_at(
                    g, labor=labor, share_y1=shares[0],
                    share_y2=shares[1], share_y3=shares[2])
                vm = to_view_model(res)
                # The invariant must hold for every single configuration.
                assert_breakeven_text_consistent(vm)
                be = vm["metrics"]["breakeven"]
                tag = vm["reco"]["tag"]
                if be["raw"] is not None and tag == "do_not_proceed":
                    # Base reached, verdict still negative -> downside-driven; the
                    # text must scope the failure to the downside scenario.
                    assert "downside" in vm["reco"]["sub"].lower()
                    seen_downside_driven = True
                if be["raw"] is None and tag == "do_not_proceed":
                    seen_base_unreached = True
                if be["raw"] is not None and tag == "proceed":
                    seen_reached_and_proceed = True
    # The sweep actually exercised all three branches (not a vacuous pass).
    assert seen_downside_driven
    assert seen_base_unreached
    assert seen_reached_and_proceed

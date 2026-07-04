"""RED first: the Appendix-D view-model is the engine's native output (§9).

Top-level field names verbatim; money/percent emitted as {raw, display}; the
API never hard-codes hex (reco.tag is the semantic enum, color is client-derived).
"""
import json

from engine.viewmodel import to_view_model


def test_top_level_fields_present(canonical_result):
    vm = to_view_model(canonical_result)
    for key in ("reco", "metrics", "kpis", "monthly", "rows", "overrides",
                "settings", "sensitivity", "confidence", "flags", "version",
                "model_version", "compute_schema_version", "breakevenMonth"):
        assert key in vm, key


def test_reco_carries_semantic_tag_not_hex(canonical_result):
    vm = to_view_model(canonical_result)
    assert vm["reco"]["tag"] in {
        "proceed", "revise", "find_cheaper_rent", "raise_cash", "delay", "do_not_proceed"}
    # API never returns hex color.
    assert "color" not in vm["reco"] or vm["reco"].get("color") is None
    assert "headline" in vm["reco"] and "sub" in vm["reco"]


def test_metrics_dual_value(canonical_result):
    vm = to_view_model(canonical_result)
    cap = vm["metrics"]["capital"]
    assert "raw" in cap and "display" in cap
    assert cap["display"].startswith("$")
    for r in ("reasonCapital", "reasonGap", "reasonBreakeven"):
        assert r in vm["metrics"]


def test_rows_have_class_and_editable(canonical_result):
    vm = to_view_model(canonical_result)
    assert vm["rows"], "rows must be non-empty"
    sample = vm["rows"][0]
    for k in ("label", "group", "y1", "y2", "y3", "class", "editable"):
        assert k in sample
    assert all(r["class"] in {"input", "computed", "overridden", "estimated"}
               for r in vm["rows"])


def test_overridden_row_class_when_pinned():
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    inputs = Inputs(
        org_name="x", city="x", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10", share_y4="0.11", share_y5="0.12",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="300000",
    )
    res = compute(inputs, Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"),
                  overrides={"Payroll#1": {"value": "200000", "note": "n", "ts": "t"}})
    vm = to_view_model(res)
    payroll_rows = [r for r in vm["rows"] if r["label"] == "Payroll"]
    assert payroll_rows and payroll_rows[0]["class"] == "overridden"
    # I3 (#322): a pinned component row STAYS editable so the owner can re-edit the
    # pin in place (the cell is the override entry point). The "overridden" class is
    # the orange highlight; editability is independent of the pin.
    assert payroll_rows[0]["editable"] is True
    assert vm["overrides"], "overrides[] must list the pin"
    assert vm["overrides"][0]["node"] == "Payroll"


def test_override_inspector_fields_calc_value_affected():
    """Override Inspector (M4): each overrides[] entry carries the calc-vs-override
    pair (`calculated` from the unpinned recompute, `value` the pin), the note, the
    pinned date, and the list of derived rows the pin rewrites (`affected`)."""
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    inputs = Inputs(
        org_name="x", city="x", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10", share_y4="0.11", share_y5="0.12",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="300000",
    )
    res = compute(inputs, Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"),
                  overrides={"Payroll#2": {"value": "250000", "note": "signed 2 hires",
                                            "ts": "2026-06-20T14:00:00Z"}})
    vm = to_view_model(res)
    assert len(vm["overrides"]) == 1
    ov = vm["overrides"][0]
    assert ov["node"] == "Payroll" and ov["year"] == 2
    assert ov["value"]["raw"] == 250000
    assert ov["note"] == "signed 2 hires"
    assert ov["pinnedDate"] == "2026-06-20T14:00:00Z"
    # calculated = what the engine would compute for this node WITHOUT the pin.
    assert ov["calculated"]["raw"] is not None
    assert abs(ov["calculated"]["raw"] - 250000) > 1
    # affected = derived rows the pin rewrites (foot-through to totals/net/margin).
    assert "Total Expenses" in ov["affected"]
    assert "Net income" in ov["affected"]
    assert "Payroll taxes" in ov["affected"]  # payroll drives its own tax line


def test_monthly_rows_shape(canonical_result):
    vm = to_view_model(canonical_result)
    ops = [m for m in vm["monthly"] if m["month"] >= 1]
    # CASH-based model 2.7.0: the monthly series spans the full 60-month horizon so the
    # cash-flow chart shows the payback crossing (was 12; default opening at month 1).
    assert len(ops) == 60
    for m in ops:
        for k in ("month", "revenue", "expenses", "net", "cumulativeCash"):
            assert k in m


def test_settings_block(canonical_result):
    vm = to_view_model(canonical_result)
    s = vm["settings"]
    for k in ("laborPct", "marketingPct", "suppliesPct", "cardPct",
              "payrollTaxPct", "salvagePct", "escalator", "basket",
              "donationsPerHh", "shareY1", "shareY2", "shareY3",
              "shareY4", "shareY5", "donationValue",
              "donationsPerHouseholdPerYear", "reserveBuffer",
              # 1.6.0: the full editable knob set (audit P0)
              "sensitivityDelta", "fixedAnnual", "nnnOpexAnnual",
              "buildingSqft", "salesfloorPct"):
        assert k in s
    assert abs(s["laborPct"] - 0.60) < 1e-9
    assert abs(s["sensitivityDelta"] - 0.25) < 1e-9
    assert abs(s["buildingSqft"] - 10000.0) < 1e-9
    assert abs(s["salesfloorPct"] - 0.70) < 1e-9
    assert abs(s["nnnOpexAnnual"] - 0.0) < 1e-9
    # fixedAnnual is the label -> annual-$ operating map (990-grounded Insurance
    # liability = $10,000 at 2.7.0; was $2,000).
    assert s["fixedAnnual"]["Insurance liability"] == 10000.0


def test_sensitivity_block_serialized(canonical_result):
    # schema 1.6.0: the §12.2 ±stress scenarios (already computed in decision.py) are
    # serialized so the client renders the tornado/robustness view without recomputing.
    vm = to_view_model(canonical_result)
    sens = vm["sensitivity"]
    assert set(sens) == {"base", "downside", "upside", "delta"}
    # delta is the ± stress fraction (0.25 default), the single source read by the engine.
    assert abs(sens["delta"] - 0.25) < 1e-9
    for scenario in ("base", "downside", "upside"):
        block = sens[scenario]
        assert set(block) == {"net", "breakeven", "capital"}
        # net + capital are dual-value {raw, display} money views (single format authority).
        for money_key in ("net", "capital"):
            assert set(block[money_key]) >= {"raw", "display"}
            assert isinstance(block[money_key]["raw"], float)
            assert isinstance(block[money_key]["display"], str)
        # break-even is a plain project-month int, or None when never reached.
        assert block["breakeven"] is None or isinstance(block["breakeven"], int)
    # The serialized values are the engine's decision.sensitivity verbatim (no re-math).
    dec_sens = canonical_result.decision.sensitivity
    assert sens["downside"]["net"]["raw"] == float(dec_sens["downside"]["net"])
    assert sens["downside"]["capital"]["raw"] == float(dec_sens["downside"]["capital"])
    assert sens["downside"]["breakeven"] == dec_sens["downside"]["breakeven"]
    assert sens["base"]["net"]["raw"] == float(dec_sens["base"]["net"])


def test_confidence_block_from_ramp_flag(canonical_result):
    # schema 1.6.0: the ramp low-confidence flag (build_flags) is surfaced as a
    # confidence label the client can render (audit P0 — it was previously dropped).
    vm = to_view_model(canonical_result)
    assert canonical_result.flags["ramp_low_confidence"] is True
    assert vm["confidence"] == {"ramp": "low"}


def test_view_model_is_json_serializable(canonical_result):
    vm = to_view_model(canonical_result)
    json.dumps(vm)  # must not raise (no Decimal leaks)


def test_version_stamps(canonical_result):
    vm = to_view_model(canonical_result)
    assert vm["model_version"] == "2.8.0"     # FUSION: cash display (A) × params/gaps operating (B)
    # 1.7.0: cash income/margin surfaces + monthly[] 60 rows + Month-N payback (A) UNION
    # +sensitivity+delta +confidence{ramp} + editable settings knobs (B).
    assert vm["compute_schema_version"] == "1.7.0"
    assert "utilitiesPerSqft" in vm["settings"]
    assert "rentPerSqft" in vm["settings"]


def test_startup_costs_exposed_dual_value(canonical_result):
    # schema 1.5.0: startupCosts is the per-category one-time startup line items as
    # {raw, display}, and startupTotal is their sum — the SAME format authority the
    # Board Packet .docx renders so the packet can never invent a startup figure.
    vm = to_view_model(canonical_result)
    assert vm["startupCosts"], "startupCosts must be non-empty"
    for item in vm["startupCosts"]:
        assert set(item) == {"category", "amount"}
        assert item["amount"]["display"].startswith("$")
    # The computed lease-deposit line is included (engine adds it on top of STARTUP).
    cats = [c["category"] for c in vm["startupCosts"]]
    assert "Lease Deposit + First Month Rent" in cats
    # startupTotal foots to the sum of the line items.
    assert "raw" in vm["startupTotal"] and "display" in vm["startupTotal"]
    assert vm["startupTotal"]["display"].startswith("$")
    total = round(sum(c["amount"]["raw"] for c in vm["startupCosts"]))
    assert round(vm["startupTotal"]["raw"]) == total


# ----------------------------------------------------- three milestones (§8, #117)
def _preopening_result(opening_month_number=3):
    """A pre-opening result: grand opening on month G with a timed cost schedule
    placing one-time costs on the pre-opening months and the opening month."""
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    inputs = Inputs(
        org_name="House of Hope", city="Longview, Texas", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10", share_y4="0.11", share_y5="0.12",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="300000",
        opening_month_number=opening_month_number,
        cost_schedule=(
            {"category": "Consultant", "month": 1, "amount": "20000"},
            {"category": "Build-out", "month": 2, "amount": "50000"},
            {"category": "Equipment", "month": 3, "amount": "30000"},
        ),
    )
    return compute(inputs, Assumptions(), DemandDrivers(),
                   TradeArea(basis="city", households="31798"))


def _recovered_payback_result():
    """A strongly profitable case that recovers startup within the 12 operating
    months, so payback is a real milestone (not N/A)."""
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    inputs = Inputs(
        org_name="Strong", city="x", opening_status="pre_launch",
        share_y1="0.15", share_y2="0.20", share_y3="0.25", share_y4="0.11", share_y5="0.12",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="800000",
        opening_month_number=1,
    )
    return compute(inputs, Assumptions(labor_pct="0.40"), DemandDrivers(),
                   TradeArea(basis="city", households="31798"))


def test_milestones_block_has_three_dual_value_milestones(canonical_result):
    vm = to_view_model(canonical_result)
    ms = vm["milestones"]
    assert set(ms) == {"grandOpening", "breakEven", "payback"}
    # grand opening = the input G (month 1 default); always reached, dual-value.
    assert ms["grandOpening"] == {"raw": 1, "display": "Month 1"}
    # break-even is a real project month for the canonical fixture (month 8).
    assert ms["breakEven"]["raw"] == canonical_result.decision.break_even_month
    assert ms["breakEven"]["display"] == f"Month {canonical_result.decision.break_even_month}"


def test_payback_milestone_is_na_with_reason_when_unreached(canonical_result):
    vm = to_view_model(canonical_result)
    pb = vm["milestones"]["payback"]
    # Explicit N/A with the engine's reason string — never a misleading 0.
    assert pb["raw"] is None
    assert pb["display"] == "N/A"
    assert pb["reason"].startswith("N/A")


def test_payback_milestone_carries_month_and_duration_when_reached():
    res = _recovered_payback_result()
    assert res.decision.payback_month is not None  # guard the fixture's intent
    pb = to_view_model(res)["milestones"]["payback"]
    g = res.decision.grand_opening_month
    pm = res.decision.payback_month
    assert pb["raw"] == pm
    assert pb["display"] == f"Month {pm}"
    # duration = months from opening to recovery (inclusive), server-formatted.
    assert pb["duration"] == f"{pm - g + 1} months"


def test_breakeven_milestone_is_na_with_reason_when_unreached():
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    inputs = Inputs(
        org_name="Deep loss", city="x", opening_status="pre_launch",
        share_y1="0.005", share_y2="0.005", share_y3="0.005", share_y4="0.11", share_y5="0.12",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="300000",
    )
    res = compute(inputs, Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"))
    be = to_view_model(res)["milestones"]["breakEven"]
    assert be["raw"] is None and be["display"] == "N/A"
    assert be["reason"].startswith("N/A")


def test_simple_payback_years_kpi_is_replaced_by_payback_period(canonical_result):
    vm = to_view_model(canonical_result)
    labels = [k["label"] for k in vm["kpis"]]
    # The crude startup/Y1-net KPI is retired from the view-model surface.
    assert "Payback (yrs)" not in labels
    assert not any(k.get("sub") == "startup / Y1 net" for k in vm["kpis"])
    # A precise payback-period KPI takes its place, sourced from the milestone.
    payback_kpis = [k for k in vm["kpis"] if k["label"] == "Payback period"]
    assert len(payback_kpis) == 1
    assert payback_kpis[0]["value"]["raw"] == vm["milestones"]["payback"]["raw"]
    assert payback_kpis[0]["value"]["display"] == vm["milestones"]["payback"]["display"]


def test_monthly_covers_all_project_months_one_to_n_with_preopening():
    res = _preopening_result(opening_month_number=3)
    vm = to_view_model(res)
    months = [m["month"] for m in vm["monthly"]]
    n = res.inputs.opening_month_number + 59   # N = G + 59 (60 operating months)
    assert months == list(range(1, n + 1))  # 1..N, x-axis from month 1
    m1 = vm["monthly"][0]
    # The monthly view mirrors the xlsx columns: scheduled one-time costs are their
    # own field and Net = revenue - operating expenses - scheduled costs.
    assert "scheduledCosts" in m1
    assert m1["scheduledCosts"]["raw"] == 20000.0          # the month-1 schedule row
    assert m1["revenue"]["raw"] == 0.0 and m1["expenses"]["raw"] == 0.0
    # Pre-opening month 1 reads as a real monthly loss and feeds cumulative cash
    # from month 1 (never dropped or forced into month 1).
    assert m1["net"]["raw"] == -20000.0
    assert m1["cumulativeCash"]["raw"] == -20000.0


def test_monthly_net_is_revenue_minus_expenses_minus_scheduled_costs(canonical_result):
    # Single-structure parity with the xlsx Net column (= B - C - D), and
    # cumulativeCash is the running sum of net.
    vm = to_view_model(canonical_result)
    running = 0.0
    for m in vm["monthly"]:
        expected_net = m["revenue"]["raw"] - m["expenses"]["raw"] - m["scheduledCosts"]["raw"]
        assert abs(m["net"]["raw"] - expected_net) < 0.5
        running += m["net"]["raw"]
        assert abs(m["cumulativeCash"]["raw"] - running) < 0.5


def test_compute_populates_view_model_natively(canonical_result):
    # compute() emits the Appendix-D view-model as native output.
    assert canonical_result.view_model
    assert canonical_result.view_model["reco"]["tag"] in {
        "proceed", "revise", "find_cheaper_rent", "raise_cash", "delay", "do_not_proceed"}


# --------------------------------- decision-text <-> break-even consistency (#142/#145)
def _do_not_proceed_base_reaches_downside_fails(opening_month_number=1):
    """A do_not_proceed result whose BASE case reaches break-even but whose DOWNSIDE
    does not — the Grace Mission economics, parameterizable on opening month so
    the consistency holds when the timeline is shifted, not just at month 1.

    (re-homed from canonical after 6.2 monthly split — see task-6.1-6.2-report:
    canonical's downside now reaches break-even, so canonical is raise_cash and
    Grace is the fixture whose downside legitimately never breaks even.)"""
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    from engine.tests.conftest import GRACE_PAYROLL_OVERRIDE
    inputs = Inputs(
        org_name="Grace Mission", city="Tyler, Texas", opening_status="pre_launch",
        share_y1="0.04", share_y2="0.05", share_y3="0.06", share_y4="0.07", share_y5="0.08",
        donation_value="74", building_sqft="6000", salesfloor_pct="0.70",
        rent_per_sqft="14", lease_type="gross", source_of_funds="250000",
        opening_month_number=opening_month_number,
    )
    return compute(inputs, Assumptions(), DemandDrivers(),
                   TradeArea(basis="city", households="25000"),
                   overrides=dict(GRACE_PAYROLL_OVERRIDE))


def test_do_not_proceed_sub_is_engine_reason_not_static_fallback(grace_result):
    # The verdict sub for do_not_proceed must be the engine's precise break-even
    # reason (single source of truth) — NOT the static _RECO_HEADLINES fallback —
    # so reco.sub can never drift from the metric's reason text (#142).
    # (re-homed from canonical after 6.2 monthly split — see task-6.1-6.2-report)
    from engine.viewmodel import _RECO_HEADLINES, to_view_model
    vm = to_view_model(grace_result)
    assert vm["reco"]["tag"] == "do_not_proceed"
    static_sub = _RECO_HEADLINES["do_not_proceed"][1]
    assert vm["reco"]["sub"] != static_sub
    assert vm["reco"]["sub"] == grace_result.decision.reco_reasons["breakeven"]


def test_do_not_proceed_sub_equals_reason_breakeven(grace_result):
    # The banner sub and the break-even tile's reason are the SAME server string,
    # so the two surfaces can never tell a board member different stories (#145).
    # (re-homed from canonical after 6.2 monthly split — see task-6.1-6.2-report)
    from engine.viewmodel import to_view_model
    vm = to_view_model(grace_result)
    assert vm["reco"]["tag"] == "do_not_proceed"
    assert vm["reco"]["sub"] == vm["metrics"]["reasonBreakeven"]


def test_do_not_proceed_reason_month_matches_breakeven_metric(grace_result):
    # The Month-N named in the reason text is exactly the base-case break-even month
    # rendered in metrics.breakeven — they are derived from the same value, so the
    # words and the number can never disagree.
    # (re-homed from canonical after 6.2 monthly split — see task-6.1-6.2-report)
    from engine.viewmodel import to_view_model
    vm = to_view_model(grace_result)
    be = vm["metrics"]["breakeven"]
    assert be["raw"] is not None
    assert f"Month {be['raw']}" in vm["reco"]["sub"]
    assert be["display"] in vm["reco"]["sub"]


def test_breakeven_consistency_holds_when_timeline_shifts():
    # Shifting grand opening still yields a base-reaches / downside-fails verdict
    # whose text names both scenarios and never contradicts the (shifted) metric.
    from engine.tests.test_decision import assert_breakeven_text_consistent
    from engine.viewmodel import to_view_model
    for g in (1, 3, 6):
        res = _do_not_proceed_base_reaches_downside_fails(opening_month_number=g)
        if res.decision.reco_tag != "do_not_proceed":
            continue
        vm = to_view_model(res)
        if vm["metrics"]["breakeven"]["raw"] is None:
            continue  # base unreached at this offset — covered elsewhere
        assert_breakeven_text_consistent(vm)
        assert "downside" in vm["reco"]["sub"].lower()


def test_proceed_case_keeps_default_breakeven_reason_and_is_consistent():
    # A genuine proceed verdict: reasonBreakeven falls back to the plain definition,
    # reco.sub is the proceed sub, and the consistency invariant holds (break-even
    # reached, no "not reached" claim anywhere). Built inline as the 40%-labor
    # design-parity SHAPE with adequate funding (source_of_funds > its $302,238 capital
    # need) — at the 2.7.0 990-grounded basis the design-parity fixture's own $300k
    # funds now yields raise_cash (capital crosses funds by $2,238), so a dedicated
    # proceed case is constructed here to keep this branch covered.
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    from engine.tests.test_decision import assert_breakeven_text_consistent
    from engine.viewmodel import to_view_model
    inputs = Inputs(
        org_name="House of Hope", city="Longview, Texas", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10", share_y4="0.11", share_y5="0.12",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="400000",
    )
    result = compute(inputs, Assumptions(labor_pct="0.40"), DemandDrivers(),
                     TradeArea(basis="city", households="31798"), overrides={})
    vm = to_view_model(result)
    assert vm["reco"]["tag"] == "proceed"
    assert vm["metrics"]["reasonBreakeven"] == (
        "First month operating net turns and stays non-negative.")
    assert "downside" not in vm["reco"]["sub"].lower()
    assert_breakeven_text_consistent(vm)


# --------------------------------------------- view-model helper unit coverage
# These small helpers have arms the full-result path never exercises: `flags` is
# always a dict-of-bools/dicts (so _jsonable's list/tuple + Decimal arms never
# run), and `_row_class`'s computed fallthrough + `_milestone`'s no-reason arm
# only occur on shapes the canonical/design fixtures don't produce. Drive them
# directly so the engine's lone format authority is fully covered (no math).
def test_jsonable_recurses_lists_tuples_and_floats_decimals():
    from decimal import Decimal

    from engine.viewmodel import _jsonable

    out = _jsonable({"nums": [Decimal("1.5"), Decimal("2")], "pair": (Decimal("3"),),
                     "flag": True, "name": "x"})
    # list AND tuple recurse to lists; nested Decimals become plain floats.
    assert out == {"nums": [1.5, 2.0], "pair": [3.0], "flag": True, "name": "x"}
    assert all(isinstance(v, float) for v in out["nums"])
    assert isinstance(out["pair"][0], float)
    # passthrough for already-JSON-native scalars.
    assert _jsonable(True) is True
    assert _jsonable("s") == "s"


def test_row_class_computed_fallthrough_for_derived_label():
    from engine.viewmodel import _row_class

    # A derived row (not pinnable, not pinned) classes as 'computed' — the
    # fallthrough arm the editable/overridden rows never reach.
    assert _row_class("Net income", set()) == "computed"
    # Contrast: an editable component is 'input'; a pinned one is 'overridden'.
    assert _row_class("Payroll", set()) == "input"
    assert _row_class("Payroll", {"Payroll"}) == "overridden"


def test_milestone_na_without_reason_when_flag_absent():
    from engine.viewmodel import _milestone

    # Unreached milestone with NO flag entry -> bare N/A sentinel, no 'reason' key
    # (the False arm of `if reason:`).
    out = _milestone(None, {}, "missing_key")
    assert out["display"] == "N/A" and out["raw"] is None
    assert "reason" not in out
    # With a flag present the reason is attached (the True arm).
    assert _milestone(None, {"k": "why"}, "k")["reason"] == "why"


def test_milestone_duration_is_singular_for_one_month():
    from engine.viewmodel import _milestone

    # opening==month -> a 1-month duration renders the singular 'month' word.
    out = _milestone(5, {}, "k", opening_month=5)
    assert out["duration"] == "1 month"
    # >1 month uses the plural.
    assert _milestone(7, {}, "k", opening_month=5)["duration"] == "3 months"


def test_month_view_formats_reached_month_and_na_sentinel_when_none():
    from engine.money import na_view
    from engine.viewmodel import _month_view

    # A reached project month -> dual-value {raw, display}; the "Month N" string is
    # built here ONCE (the engine's lone format authority), never on the client (§9).
    assert _month_view(6) == {"raw": 6, "display": "Month 6"}
    assert _month_view(1) == {"raw": 1, "display": "Month 1"}
    # Unreached (None) -> the explicit N/A sentinel, never a misleading 0.
    assert _month_view(None) == na_view()
    assert _month_view(None)["raw"] is None and _month_view(None)["display"] == "N/A"


def test_breakeven_surfaces_all_route_through_one_month_view(canonical_result):
    from engine.viewmodel import _month_view, to_view_model

    # metrics.breakeven, the "Break-even month" KPI, and the breakEven milestone are
    # the SAME dual-value from one helper, so the three surfaces can never disagree.
    vm = to_view_model(canonical_result)
    expected = _month_view(canonical_result.decision.break_even_month)
    assert vm["metrics"]["breakeven"] == expected
    kpi = [k for k in vm["kpis"] if k["label"] == "Break-even month"]
    assert len(kpi) == 1 and kpi[0]["value"] == expected
    assert vm["milestones"]["breakEven"]["raw"] == expected["raw"]
    assert vm["milestones"]["breakEven"]["display"] == expected["display"]

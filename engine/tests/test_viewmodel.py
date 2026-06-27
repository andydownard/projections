"""RED first: the Appendix-D view-model is the engine's native output (§9).

Top-level field names verbatim; money/percent emitted as {raw, display}; the
API never hard-codes hex (reco.tag is the semantic enum, color is client-derived).
"""
import json

from engine.viewmodel import to_view_model


def test_top_level_fields_present(canonical_result):
    vm = to_view_model(canonical_result)
    for key in ("reco", "metrics", "kpis", "monthly", "rows", "overrides",
                "settings", "flags", "version", "model_version",
                "compute_schema_version", "breakevenMonth"):
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
        share_y1="0.06", share_y2="0.08", share_y3="0.10",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="300000",
    )
    res = compute(inputs, Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"),
                  overrides={"Payroll#1": {"value": "200000", "note": "n", "ts": "t"}})
    vm = to_view_model(res)
    payroll_rows = [r for r in vm["rows"] if r["label"] == "Payroll"]
    assert payroll_rows and payroll_rows[0]["class"] == "overridden"
    assert vm["overrides"], "overrides[] must list the pin"
    assert vm["overrides"][0]["node"] == "Payroll"


def test_override_inspector_fields_calc_value_affected():
    """Override Inspector (M4): each overrides[] entry carries the calc-vs-override
    pair (`calculated` from the unpinned recompute, `value` the pin), the note, the
    pinned date, and the list of derived rows the pin rewrites (`affected`)."""
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    inputs = Inputs(
        org_name="x", city="x", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10",
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
    assert "Net profit" in ov["affected"]
    assert "Payroll taxes" in ov["affected"]  # payroll drives its own tax line


def test_monthly_rows_shape(canonical_result):
    vm = to_view_model(canonical_result)
    ops = [m for m in vm["monthly"] if m["month"] >= 1]
    assert len(ops) == 12
    for m in ops:
        for k in ("month", "revenue", "expenses", "net", "cumulativeCash"):
            assert k in m


def test_settings_block(canonical_result):
    vm = to_view_model(canonical_result)
    s = vm["settings"]
    for k in ("laborPct", "marketingPct", "suppliesPct", "cardPct",
              "payrollTaxPct", "salvagePct", "escalator", "basket",
              "donationsPerHh", "shareY1", "shareY2", "shareY3",
              "reserveBuffer"):
        assert k in s
    assert abs(s["laborPct"] - 0.60) < 1e-9


def test_view_model_is_json_serializable(canonical_result):
    vm = to_view_model(canonical_result)
    json.dumps(vm)  # must not raise (no Decimal leaks)


def test_version_stamps(canonical_result):
    vm = to_view_model(canonical_result)
    assert vm["model_version"] == "2.2.0"
    # Adding the milestones block + replacing the simple-payback KPI is a view-model
    # SHAPE change (no math change) -> COMPUTE_SCHEMA_VERSION bumps to 1.2.0.
    assert vm["compute_schema_version"] == "1.2.0"


# ----------------------------------------------------- three milestones (§8, #117)
def _preopening_result(opening_month_number=3):
    """A pre-opening result: grand opening on month G with a timed cost schedule
    placing one-time costs on the pre-opening months and the opening month."""
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    inputs = Inputs(
        org_name="House of Hope", city="Longview, Texas", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10",
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
        share_y1="0.15", share_y2="0.20", share_y3="0.25",
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
    # break-even is a real project month for the canonical fixture (month 9).
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
        share_y1="0.005", share_y2="0.005", share_y3="0.005",
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
    n = res.inputs.opening_month_number + 11
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

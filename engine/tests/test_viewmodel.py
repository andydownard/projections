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
    from engine.compute import (Assumptions, DemandDrivers, Inputs, TradeArea,
                                 compute)
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
    assert vm["model_version"] == "2.0.0"
    assert vm["compute_schema_version"] == "1.0.0"


def test_compute_populates_view_model_natively(canonical_result):
    # compute() emits the Appendix-D view-model as native output.
    assert canonical_result.view_model
    assert canonical_result.view_model["reco"]["tag"] in {
        "proceed", "revise", "find_cheaper_rent", "raise_cash", "delay", "do_not_proceed"}

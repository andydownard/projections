"""Three-way golden gate (CLAUDE.md rule 6 / PRD §13/§18) — the spine of correctness.

For each golden fixture, with AND without an override, assert:
  engine resolved values  ==  the in-sheet .xlsx formulas  ==  a LibreOffice recalc
within <$0.50 on dollar cells / <0.1pp on percent cells, with ZERO formula errors
(#VALUE! #DIV/0! #REF! #NAME? #NULL! #NUM! #N/A). This is what makes the
"single math authority" claim enforceable: if the engine and the live workbook
ever disagree, this fails.

Runs where LibreOffice (`soffice`) is installed (CI pins it); skipped otherwise so
the fast unit suite is never blocked. Each fixture spawns one soffice recalc (slow).
"""
import pathlib
import shutil
import sys

import pytest
from openpyxl import load_workbook

from engine.compute import compute
from engine.viewmodel import to_view_model
from engine.xlsx import build_xlsx

# The LibreOffice recalc harness (soffice + a Basic recalc macro) lives in the
# reference skill scripts; put them on the path so `recalc` + its `office` package
# resolve. recalc.py recalcs the workbook in place and reports formula errors.
_SCRIPTS = (
    pathlib.Path(__file__).resolve().parents[2]
    / "reference/thrift-store-projections-skill/scripts"
)
sys.path.insert(0, str(_SCRIPTS))

pytestmark = pytest.mark.skipif(
    shutil.which("soffice") is None, reason="LibreOffice (soffice) not installed"
)

# Percent rows reconcile at 0.1pp; money/count rows at <$0.50 (PRD §18 tolerance).
_PCT_LABELS = {"Donor market share", "Net margin"}
_PCT_TOL = 0.001
_USD_TOL = 0.5


def _reconcile(result, tmp_path) -> int:
    """Build the workbook, recalc it in LibreOffice, and assert every 3-year-table
    cell equals the engine's resolved value within tolerance. Returns cells checked."""
    import recalc as recalc_harness

    vm = to_view_model(result)
    xlsx = tmp_path / "projection.xlsx"
    build_xlsx(result, str(xlsx))

    report = recalc_harness.recalc(str(xlsx), timeout=90)
    assert "error" not in report, report
    assert report["status"] == "success", report
    assert report["total_errors"] == 0, report.get("error_summary")

    wb = load_workbook(str(xlsx), data_only=True)
    ws = wb["Projection"]
    label_row = {
        ws.cell(row=r, column=1).value: r
        for r in range(1, ws.max_row + 1)
        if isinstance(ws.cell(row=r, column=1).value, str)
    }

    checked = 0
    for vmrow in vm["rows"]:
        label = vmrow["label"]
        if label not in label_row:
            continue
        r = label_row[label]
        tol = _PCT_TOL if label in _PCT_LABELS else _USD_TOL
        for i, key in enumerate(("y1", "y2", "y3", "y4", "y5")):
            expect = vmrow[key]
            if not expect or expect.get("raw") is None:
                continue
            cell = ws.cell(row=r, column=2 + i).value
            assert cell is not None, f"{label} {key}: empty cell after recalc"
            assert abs(float(cell) - float(expect["raw"])) <= tol, (
                f"{label} {key}: LibreOffice {cell} vs engine {expect['raw']} "
                f"(tolerance {tol})"
            )
            checked += 1
    wb.close()
    return checked


def test_golden_gate_canonical_60(canonical_result, tmp_path):
    assert _reconcile(canonical_result, tmp_path) >= 30


def test_golden_gate_design_parity_40(design_parity_result, tmp_path):
    assert _reconcile(design_parity_result, tmp_path) >= 30


def test_golden_gate_preopening_custom_schedule(tmp_path):
    # Golden coverage INCLUDING pre-opening months (#120): grand opening on month 3
    # with a timed multi-month cost schedule (two pre-opening months + the opening
    # month) must still reconcile the 3-year table three ways AND recalc clean —
    # the pre-opening monthly rows, the scheduled-cost column and the milestones
    # block carry zero formula errors.
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute

    inputs = Inputs(
        org_name="House of Hope", city="Longview, Texas", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10", share_y4="0.11", share_y5="0.12",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="400000",
        opening_month_number=3,
        cost_schedule=(
            {"category": "Consultant", "month": 1, "amount": "20000"},
            {"category": "Build-out", "month": 2, "amount": "50000"},
            {"category": "Equipment", "month": 3, "amount": "30000"},
            {"category": "Post-open support", "month": 15, "amount": "8000"},
        ),
    )
    res = compute(inputs, Assumptions(labor_pct="0.40"), DemandDrivers(),
                  TradeArea(basis="city", households="31798"))
    pre_open = [m for m in res.monthly if m.kind == "pre_open"]
    assert pre_open, "fixture must have pre-opening months"
    assert _reconcile(res, tmp_path) >= 30


def test_golden_gate_month1_lump_default(tmp_path):
    # The month-1-lump default leg (#120): the migration default (no schedule,
    # opening_month_number=1) reconciles three ways and recalcs clean.
    from engine import model
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute

    inputs = Inputs(
        org_name="House of Hope", city="Longview, Texas", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10", share_y4="0.11", share_y5="0.12",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="300000",
        opening_month_number=model.DEFAULT_OPENING_MONTH_NUMBER,
        cost_schedule=tuple(model.default_cost_schedule()),
    )
    res = compute(inputs, Assumptions(labor_pct="0.40"), DemandDrivers(),
                  TradeArea(basis="city", households="31798"))
    assert all(m.kind == "operating" for m in res.monthly)  # no pre-opening months
    assert _reconcile(res, tmp_path) >= 30


def test_golden_gate_with_payroll_override(canonical_inputs, tmp_path):
    # §18: totals stay live formulas over the now-hard-coded orange override cell,
    # and the §12.4 guards must still recalc clean WITH an override present.
    inputs, assumptions, demand, trade = canonical_inputs
    res = compute(
        inputs, assumptions, demand, trade,
        overrides={"Payroll#1": {"value": "250000", "note": "2 hires", "ts": "t"}},
    )
    assert _reconcile(res, tmp_path) >= 30


def test_golden_gate_loss_case_recalcs_clean(tmp_path):
    # The Grace-Mission loss case (§12.4): a negative-Y1-net fixture with an
    # overridden Payroll. The guarded blank-string paths — payback
    # =IF(net<=0,"",...) — only exist on the loss path, so this is the fixture that
    # proves LibreOffice recalcs them without a #DIV/0! (zero formula errors).
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute

    inputs = Inputs(
        org_name="Grace Mission", city="x", opening_status="pre_launch",
        share_y1="0.02", share_y2="0.02", share_y3="0.02", share_y4="0.02", share_y5="0.02",
        donation_value="74",
        building_sqft="8000", salesfloor_pct="0.70", occupancy_annual="400000",
        lease_type="nnn", source_of_funds="300000",
    )
    res = compute(
        inputs, Assumptions(), DemandDrivers(),
        TradeArea(basis="city", households="20000"),
        overrides={"Payroll#1": {"value": "250000", "note": "x", "ts": "t"}},
    )
    assert res.annual[1].net < 0, "fixture must be a loss case"
    assert _reconcile(res, tmp_path) >= 30


def test_golden_gate_aggressive(aggressive_result, tmp_path):
    # AGENTS.md fixture 2 (the §12.2 guardrail case) reconciles three ways WITHOUT
    # overrides — the aggressive shares drive large positive figures; every 5-year
    # cell must foot server == in-sheet formula == LibreOffice recalc, zero errors.
    assert _reconcile(aggressive_result, tmp_path) >= 30


def test_golden_gate_aggressive_with_override(aggressive_inputs, tmp_path):
    # …and WITH a component pin present: a hard-coded orange Marketing cell, with
    # totals still live formulas over it, must recalc clean too (§18 with-overrides).
    inputs, assumptions, demand, trade = aggressive_inputs
    res = compute(
        inputs, assumptions, demand, trade,
        overrides={"Marketing & outreach#1":
                   {"value": "40000", "note": "campaign", "ts": "t"}},
    )
    assert _reconcile(res, tmp_path) >= 30


def test_golden_gate_grace_with_payroll_override(grace_result, tmp_path):
    # AGENTS.md fixture 3 in its canonical (frozen) form: the $14/sq-ft loss case
    # WITH the one Payroll#1 override. The guarded blank-string payback path
    # =IF(net<=0,"",...) only exists on the loss path, so this proves LibreOffice
    # recalcs it with zero #DIV/0! WHILE an override is present.
    assert grace_result.annual[1].net < 0, "fixture must be a loss case"
    assert _reconcile(grace_result, tmp_path) >= 30


def test_golden_gate_grace_without_override(grace_inputs, tmp_path):
    # …and the same loss case WITHOUT the override (computed Payroll) still
    # reconciles three ways (with/without-overrides coverage for the loss fixture).
    inputs, assumptions, demand, trade = grace_inputs
    res = compute(inputs, assumptions, demand, trade, overrides={})
    assert res.annual[1].net < 0
    assert _reconcile(res, tmp_path) >= 30


def test_concurrent_recalc_calls_are_hermetic(
        canonical_result, design_parity_result, tmp_path):
    # #199 regression: two recalc() calls running CONCURRENTLY on distinct workbooks
    # must BOTH succeed. Each gets its own throwaway LibreOffice profile (a unique
    # -env:UserInstallation), so they never contend for the single shared profile.
    # Pre-fix, the second call would forward its document to the already-running
    # instance and return 0 WITHOUT recalculating -> empty cached cells (the flaky
    # "empty cell after recalc" red). This proves the harness is now hermetic, so the
    # slowest CI job can be parallelised (pytest-xdist) without flaking.
    import concurrent.futures

    import recalc as recalc_harness

    xa = tmp_path / "a.xlsx"
    xb = tmp_path / "b.xlsx"
    build_xlsx(canonical_result, str(xa))
    build_xlsx(design_parity_result, str(xb))

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        fa = ex.submit(recalc_harness.recalc, str(xa), 90)
        fb = ex.submit(recalc_harness.recalc, str(xb), 90)
        reports = [fa.result(), fb.result()]

    for r in reports:
        assert "error" not in r, r
        assert r["status"] == "success", r
        assert r["total_errors"] == 0, r

    # Both workbooks must carry actual recalculated values (not empty cached cells):
    # the Total Revenue Y1 cell is a live formula that must resolve to a number.
    for x in (xa, xb):
        wb = load_workbook(str(x), data_only=True)
        ws = wb["Projection"]
        vals = [
            ws.cell(row=r, column=2).value
            for r in range(1, ws.max_row + 1)
            if ws.cell(row=r, column=1).value == "Total Revenue"
        ]
        assert vals and isinstance(vals[0], (int, float)), vals
        wb.close()

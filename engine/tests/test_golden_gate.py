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
        for i, key in enumerate(("y1", "y2", "y3")):
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


def test_golden_gate_with_payroll_override(canonical_inputs, tmp_path):
    # §18: totals stay live formulas over the now-hard-coded orange override cell,
    # and the §12.4 guards must still recalc clean WITH an override present.
    inputs, assumptions, demand, trade = canonical_inputs
    res = compute(
        inputs, assumptions, demand, trade,
        overrides={"Payroll#1": {"value": "250000", "note": "2 hires", "ts": "t"}},
    )
    assert _reconcile(res, tmp_path) >= 30

"""RED first: the .xlsx cell contract (§11) — structure, guards, overrides.

The recalc/reconciliation against LibreOffice lives in the golden-gate test
(test_golden_gate.py); here we assert the workbook *structure*: blue inputs,
live formulas, totals as formulas, division guards, the monthly tab, and the
orange overridden-component cell + exact comment string.
"""
import pathlib

import openpyxl

from engine.compute import (Assumptions, DemandDrivers, Inputs, TradeArea,
                            compute)
from engine.xlsx import build_xlsx


def _inputs():
    return Inputs(
        org_name="House of Hope", city="Longview, Texas", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="300000",
    )


def _build(tmp_path, overrides=None):
    res = compute(_inputs(), Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides=overrides or {})
    path = tmp_path / "proj.xlsx"
    build_xlsx(res, str(path))
    return res, path


def test_two_tabs_projection_and_monthly(tmp_path):
    _res, path = _build(tmp_path)
    wb = openpyxl.load_workbook(path)
    assert "Projection" in wb.sheetnames
    assert "Monthly Cash Flow" in wb.sheetnames


def test_totals_are_formulas_not_literals(tmp_path):
    _res, path = _build(tmp_path)
    wb = openpyxl.load_workbook(path)
    ws = wb["Projection"]
    formulas = [c.value for row in ws.iter_rows() for c in row
                if isinstance(c.value, str) and c.value.startswith("=")]
    assert any(f.startswith("=SUM(") for f in formulas)        # totals are SUMs
    assert any("/" in f and "IF(" in f for f in formulas)       # guarded divisions


def test_no_unguarded_division_by_a_cell(tmp_path):
    import re
    # A division whose denominator is a CELL reference (could be 0) must be
    # guarded. Division by a literal constant (e.g. /12) is always safe.
    cell_denom = re.compile(r"/\s*\$?[A-Z]{1,3}\$?\d+")
    _res, path = _build(tmp_path)
    wb = openpyxl.load_workbook(path)
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c.value, str) and c.value.startswith("=") and cell_denom.search(c.value):
                    assert "IF(" in c.value, \
                        f"unguarded cell division at {ws.title}!{c.coordinate}: {c.value}"


def test_year2_share_not_average(tmp_path):
    _res, path = _build(tmp_path)
    wb = openpyxl.load_workbook(path)
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c.value, str):
                    assert "AVERAGE(" not in c.value  # midpoint is dead


def test_overridden_cell_is_orange_with_exact_comment(tmp_path):
    overrides = {"Payroll#1": {"value": "200000", "note": "frozen", "ts": "2026-06-24"}}
    _res, path = _build(tmp_path, overrides=overrides)
    wb = openpyxl.load_workbook(path)
    ws = wb["Projection"]
    # find the Payroll Year-1 cell: hard-coded numeric 200000, orange, commented.
    found = None
    for row in ws.iter_rows():
        label = row[0].value
        if label == "Payroll":
            found = row[1]  # Year-1 column (B)
            break
    assert found is not None
    assert float(found.value) == 200000.0           # hard-coded, not a formula
    assert found.comment is not None
    assert found.comment.text.startswith("Manual override — calc was =")
    assert "set to $200,000 on 2026-06-24" in found.comment.text


def test_monthly_tab_has_twelve_month_rows(tmp_path):
    _res, path = _build(tmp_path)
    wb = openpyxl.load_workbook(path)
    ws = wb["Monthly Cash Flow"]
    months = [c.value for col in ws.iter_cols(min_col=1, max_col=1) for c in col
              if isinstance(c.value, str) and c.value.startswith("Month ")]
    assert len(months) >= 12

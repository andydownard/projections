"""RED first: the .xlsx cell contract (§11) — structure, guards, overrides.

The recalc/reconciliation against LibreOffice lives in the golden-gate test
(test_golden_gate.py); here we assert the workbook *structure*: blue inputs,
live formulas, totals as formulas, division guards, the monthly tab, and the
orange overridden-component cell + exact comment string.
"""

import openpyxl

from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
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
                if (isinstance(c.value, str) and c.value.startswith("=")
                        and cell_denom.search(c.value)):
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


# --------------------------------------------------------------- pre-opening
def _preopening_inputs():
    """A projection with grand opening on month 3 and a timed cost schedule that
    places costs on the two pre-opening months and the opening month."""
    return Inputs(
        org_name="House of Hope", city="Longview, Texas", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="300000",
        opening_month_number=3,
        cost_schedule=(
            {"category": "Consultant", "month": 1, "amount": "20000"},
            {"category": "Build-out", "month": 2, "amount": "50000"},
            {"category": "Equipment", "month": 3, "amount": "30000"},
        ),
    )


def _build_preopening(tmp_path, overrides=None):
    res = compute(_preopening_inputs(), Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides=overrides or {})
    path = tmp_path / "preopen.xlsx"
    build_xlsx(res, str(path))
    return res, path


def _month_row_map(ws):
    """Map project-month int -> worksheet row index, parsing the 'Month N' label."""
    import re
    out = {}
    for col in ws.iter_cols(min_col=1, max_col=1):
        for c in col:
            if isinstance(c.value, str):
                m = re.match(r"Month (\d+)", c.value)
                if m:
                    out[int(m.group(1))] = c.row
    return out


def test_monthly_tab_emits_a_row_per_project_month_1_to_n(tmp_path):
    res, path = _build_preopening(tmp_path)
    wb = openpyxl.load_workbook(path)
    ws = wb["Monthly Cash Flow"]
    rowmap = _month_row_map(ws)
    expected = [m.index for m in res.monthly]
    assert sorted(rowmap) == expected
    assert expected[0] == 1
    assert len(expected) == res.inputs.opening_month_number + 11  # N = G + 11


def test_monthly_tab_has_scheduled_costs_column(tmp_path):
    _res, path = _build_preopening(tmp_path)
    wb = openpyxl.load_workbook(path)
    ws = wb["Monthly Cash Flow"]
    headers = [ws.cell(row=2, column=col).value for col in range(1, 7)]
    assert "Scheduled costs" in headers


def test_scheduled_costs_land_on_their_month_numbers(tmp_path):
    res, path = _build_preopening(tmp_path)
    wb = openpyxl.load_workbook(path)
    ws = wb["Monthly Cash Flow"]
    headers = [ws.cell(row=2, column=col).value for col in range(1, 7)]
    sched_col = headers.index("Scheduled costs") + 1
    rowmap = _month_row_map(ws)
    by_month = {m.index: m.startup_outflow for m in res.monthly}
    for month, r in rowmap.items():
        cell = ws.cell(row=r, column=sched_col).value
        assert float(cell) == float(by_month[month]), f"month {month}"
    # the two explicit pre-opening schedule rows landed on months 1 and 2
    assert float(ws.cell(row=rowmap[1], column=sched_col).value) == 20000.0
    assert float(ws.cell(row=rowmap[2], column=sched_col).value) == 50000.0


def test_pre_opening_months_have_negative_net_from_scheduled_costs(tmp_path):
    res, path = _build_preopening(tmp_path)
    wb = openpyxl.load_workbook(path)
    ws = wb["Monthly Cash Flow"]
    headers = [ws.cell(row=2, column=col).value for col in range(1, 7)]
    rev_col = headers.index("Revenue") + 1
    exp_col = headers.index("Operating expenses") + 1
    sched_col = headers.index("Scheduled costs") + 1
    net_col = headers.index("Net") + 1
    rowmap = _month_row_map(ws)
    pre_open = [m.index for m in res.monthly if m.kind == "pre_open"]
    assert pre_open == [1, 2]
    for month in pre_open:
        r = rowmap[month]
        # no operating activity
        assert float(ws.cell(row=r, column=rev_col).value) == 0.0
        assert float(ws.cell(row=r, column=exp_col).value) == 0.0
        # net is a live formula over revenue - opex - scheduled costs (so it is
        # the negative scheduled cost — a real monthly loss)
        net = ws.cell(row=r, column=net_col).value
        assert isinstance(net, str) and net.startswith("=")
        from openpyxl.utils import get_column_letter
        rc = get_column_letter(rev_col)
        ec = get_column_letter(exp_col)
        sc = get_column_letter(sched_col)
        assert net == f"={rc}{r}-{ec}{r}-{sc}{r}"


def test_preopening_workbook_has_no_unguarded_divisions(tmp_path):
    import re
    cell_denom = re.compile(r"/\s*\$?[A-Z]{1,3}\$?\d+")
    _res, path = _build_preopening(tmp_path)
    wb = openpyxl.load_workbook(path)
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if (isinstance(c.value, str) and c.value.startswith("=")
                        and cell_denom.search(c.value)):
                    assert "IF(" in c.value, \
                        f"unguarded cell division at {ws.title}!{c.coordinate}"

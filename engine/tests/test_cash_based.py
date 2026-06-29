"""RED first: the CASH-BASED projection convention (epic #321).

The projection is cash-based: there is NO amortization and NO capitalization. The
one-time startup is a CASH outflow that hits when paid (Year 1, at/around opening).
The DISPLAYED Net income AND Net margin are both cash-based and therefore congruent
(no second margin, no footnote): displayed cash_net[1] = operating_net[1] -
startup_total; cash_net[y] = operating_net[y] for y>=2; displayed net_margin[y] =
cash_net[y] / total_rev[y]. Payback is the first project-month where cumulative cash
returns to >= 0 after going negative ("Month N"). The monthly model spans the full
60-month horizon so payback resolves across years.

The INTERNAL operating net (AnnualYear.net) is unchanged and still drives the verdict.
"""
from decimal import Decimal

from openpyxl import load_workbook

from engine.money import D
from engine.viewmodel import to_view_model
from engine.xlsx import build_xlsx


def test_year1_cash_net_subtracts_full_startup(canonical_result):
    # (a) Displayed Year-1 Net income = operating net - startup_total (cash basis);
    # Years 2-5 stay operating net (cash_net == operating for y>=2).
    res = canonical_result
    expected_y1 = D(str(res.annual[1].net)) - D(str(res.startup_total))
    vm = to_view_model(res)
    net_row = next(r for r in vm["rows"] if r["label"] == "Net income")
    assert abs(D(str(net_row["y1"]["raw"])) - expected_y1) < Decimal("0.01")
    for y in (2, 3, 4, 5):
        assert abs(D(str(net_row[f"y{y}"]["raw"])) - D(str(res.annual[y].net))) < Decimal("0.01")
    # The Net income KPI agrees with the Year-1 row cell.
    net_kpi = next(k for k in vm["kpis"] if k["label"] == "Net income")
    assert net_kpi["value"]["raw"] == net_row["y1"]["raw"]
    # incomeSeries[0] and the card-feeding KPI are cash-based too.
    assert abs(D(str(vm["incomeSeries"][0]["raw"])) - expected_y1) < Decimal("0.01")


def test_net_and_margin_are_congruent_cash_basis(canonical_result):
    # (b) Both displayed numbers are cash-based and AGREE: displayed margin == cash_net
    # / revenue == displayed net / revenue (one congruent margin, no operating twin).
    res = canonical_result
    rev = D(str(res.annual[1].total_rev))
    cash_net_y1 = D(str(res.annual[1].net)) - D(str(res.startup_total))
    vm = to_view_model(res)
    net_row = next(r for r in vm["rows"] if r["label"] == "Net income")
    margin_row = next(r for r in vm["rows"] if r["label"] == "Net margin")
    assert abs(D(str(net_row["y1"]["raw"])) - cash_net_y1) < Decimal("0.01")
    assert abs(D(str(margin_row["y1"]["raw"])) - cash_net_y1 / rev) < Decimal("0.0001")
    # congruence: displayed margin == displayed net / revenue, exactly.
    assert abs(D(str(margin_row["y1"]["raw"]))
               - D(str(net_row["y1"]["raw"])) / rev) < Decimal("0.0001")
    # KPI margin congruent too.
    margin_kpi = next(k for k in vm["kpis"] if k["label"] == "Net margin")
    assert abs(D(str(margin_kpi["value"]["raw"])) - cash_net_y1 / rev) < Decimal("0.0001")


def test_positive_operating_net_yields_finite_payback_month(design_parity_result):
    # (c) Aurora-class: a realistic positive-operating-net projection resolves to a real
    # payback Month N (first project-month cumulative cash >= 0 AFTER going negative).
    res = design_parity_result
    assert res.annual[1].net > 0                      # positive operating net
    pm = res.decision.payback_month
    assert pm is not None                             # a real month, never N/A here
    # It matches the cash-recovery definition over the full monthly series.
    gone_negative = False
    expected = None
    for m in res.monthly:
        cc = D(str(m.cumulative_cash))
        if cc < 0:
            gone_negative = True
        elif gone_negative and cc >= 0:
            expected = m.index
            break
    assert pm == expected
    # It lands in a later year (across the 60-month horizon, not within Year 1).
    assert pm > 12
    # The view-model surfaces it as "Month N".
    pb = to_view_model(res)["milestones"]["payback"]
    assert pb["raw"] == pm and pb["display"] == f"Month {pm}"


def test_year1_annual_cash_net_equals_sum_of_year1_monthly_cash_nets(canonical_result):
    # (d) Reg #15: Year-1 annual cash net == sum of ALL Year-1 monthly cash nets,
    # INCLUDING startup outflows. Year-1 cash window = project months 1..G+11.
    res = canonical_result
    g = res.decision.grand_opening_month
    monthly_sum = sum((D(str(m.cash_net)) for m in res.monthly if m.index <= g + 11),
                      Decimal("0"))
    annual_cash_net = D(str(res.annual[1].net)) - D(str(res.startup_total))
    assert monthly_sum == annual_cash_net


def test_xlsx_net_income_year1_subtracts_startup(canonical_result, tmp_path):
    # (e) The .xlsx Net income Year-1 cell subtracts the Total Startup Costs cell so the
    # in-sheet net foots to the server cash net (operating - startup) within $0.50;
    # Years 2-5 stay the operating =rev-exp formula.
    res = canonical_result
    path = tmp_path / "cash.xlsx"
    build_xlsx(res, str(path))
    wb = load_workbook(path)
    ws = wb["Projection"]
    labels = {ws.cell(row=r, column=1).value: r
              for r in range(1, ws.max_row + 1)
              if isinstance(ws.cell(row=r, column=1).value, str)}
    net_row = labels["Net income"]
    tr, te, su = labels["Total Revenue"], labels["Total Expenses"], labels["Total Startup Costs"]
    assert ws.cell(row=net_row, column=2).value == f"=B{tr}-B{te}-B{su}"
    assert ws.cell(row=net_row, column=3).value == f"=C{tr}-C{te}"   # Year 2 stays operating
    # The relationship the formula encodes equals the server cash net within $0.50.
    server_cash = (D(str(res.annual[1].total_rev)) - D(str(res.annual[1].total_exp))
                   - D(str(res.startup_total)))
    expected = D(str(res.annual[1].net)) - D(str(res.startup_total))
    assert abs(server_cash - expected) < Decimal("0.5")
    # The retired "Simple payback (years)" cell is gone; payback rides MILESTONES.
    assert "Simple payback (years)" not in labels

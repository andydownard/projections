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

from engine.compute import (
    Assumptions,
    DemandDrivers,
    Inputs,
    TradeArea,
    cash_margin,
    cash_net,
    compute,
)
from engine.money import D
from engine.viewmodel import to_view_model
from engine.xlsx import build_xlsx


def _projection(labor_pct, shares=("0.06", "0.08", "0.10", "0.11", "0.12"),
                source_of_funds="300000"):
    """A House-of-Hope-shaped projection with a chosen labor % and donor-share path.

    Reuses the canonical inputs (deterministic: explicit annual occupancy, default
    assumptions, fixed trade area) so every constructed case below is byte-stable —
    no clock / network / random. Only labor_pct, the five shares, and the committed
    funds vary, which is all these cash-convention assertions need.
    """
    s1, s2, s3, s4, s5 = shares
    inputs = Inputs(
        org_name="House of Hope", city="Longview, Texas",
        opening_status="pre_launch",
        share_y1=s1, share_y2=s2, share_y3=s3, share_y4=s4, share_y5=s5,
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds=source_of_funds,
    )
    return compute(inputs, Assumptions(labor_pct=labor_pct), DemandDrivers(),
                   TradeArea(basis="city", households="31798"), overrides={})


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


# --------------------------------------------------------------------------- NEW
# Hardening for epic #321: extend the cash convention's invariants to EVERY year,
# to a middle-year payback crossing, to the per-year monthly roll-up, to the full
# Y2-5 xlsx formula set, and to the capital / income-series / guardrail / N/A paths.


def test_net_and_margin_are_congruent_for_every_year(canonical_result):
    # (a, all years) The Y1-only congruence test has a twin for EACH year: the displayed
    # margin equals the displayed cash net over revenue for Y1..Y5, not just Year 1, so
    # the board can never see a row whose margin and net disagree. Year 1 carries the
    # startup hit; Years 2-5 are operating — both are congruent by the same rule.
    res = canonical_result
    vm = to_view_model(res)
    net_row = next(r for r in vm["rows"] if r["label"] == "Net income")
    margin_row = next(r for r in vm["rows"] if r["label"] == "Net margin")
    for y in (1, 2, 3, 4, 5):
        rev = D(str(res.annual[y].total_rev))
        cn = cash_net(res, y)
        cm = cash_margin(res, y)
        # engine-level congruence: cash_margin == cash_net / revenue.
        assert abs(cm - cn / rev) < Decimal("0.0001"), y
        # view-model congruence: the displayed margin cell == the displayed net cell
        # over revenue, exactly (one congruent margin per year).
        assert abs(D(str(margin_row[f"y{y}"]["raw"]))
                   - D(str(net_row[f"y{y}"]["raw"])) / rev) < Decimal("0.0001"), y
        # and the displayed net cell IS the cash net (Y1 startup-subtracted, Y2-5 operating).
        assert abs(D(str(net_row[f"y{y}"]["raw"])) - cn) < Decimal("0.01"), y


def test_payback_crosses_zero_in_a_middle_year():
    # (c, middle year) A constructed projection whose cumulative cash recovers in a MIDDLE
    # year of the 60-month horizon. With labor 30% the operating net is strong enough to
    # repay the startup outflow during Year 2 (not in Year 1, not as late as Year 5).
    res = _projection("0.30")
    pm = res.decision.payback_month
    assert pm == 23                         # deterministic Month-N, a real finite month
    assert pm != 12 and pm is not None      # not capped at Year-1 end, not N/A
    assert 12 < pm <= 48                    # a middle year (Year 2-4), not Year 1 or 5
    assert (pm - 1) // 12 + 1 == 2          # lands specifically in Year 2
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
    # cumulative cash is negative the month BEFORE recovery and >= 0 at recovery.
    by_index = {m.index: D(str(m.cumulative_cash)) for m in res.monthly}
    assert by_index[pm - 1] < 0 <= by_index[pm]
    # surfaced as "Month 23" with a duration measured from grand opening.
    pb = to_view_model(res)["milestones"]["payback"]
    assert pb["raw"] == pm and pb["display"] == f"Month {pm}"


def test_each_later_year_cash_net_equals_sum_of_its_twelve_monthly_cash_nets(canonical_result):
    # (d, Y2-5) Reg #15 per year, on the CASH series: for Years 2-5 the displayed annual
    # cash net == the sum of that year's 12 monthly cash nets, to the penny. No startup
    # outflow lands in Years 2-5 (the lump is at opening), so each month's cash_net equals
    # its operating net there and the displayed cash net equals the operating net.
    res = canonical_result
    g = res.decision.grand_opening_month       # == 1 for the canonical fixture
    assert g == 1
    for y in (2, 3, 4, 5):
        lo, hi = 12 * (y - 1) + 1, 12 * y      # G=1 => Year y is months 12(y-1)+1..12y
        ops = [m for m in res.monthly if lo <= m.index <= hi]
        assert len(ops) == 12, y
        # no one-time outflow in these months => cash_net == operating net month-by-month.
        assert all(D(str(m.startup_outflow)) == Decimal("0") for m in ops), y
        monthly_cash = sum((D(str(m.cash_net)) for m in ops), Decimal("0"))
        assert monthly_cash == cash_net(res, y), y          # displayed cash net foots
        assert monthly_cash == D(str(res.annual[y].net)), y  # == operating net (no startup)


def test_xlsx_only_year1_subtracts_startup_years_two_to_five_are_operating(
        canonical_result, tmp_path):
    # (e, full Y2-5) The xlsx Net-income row: ONLY the Year-1 cell subtracts the Total
    # Startup Costs cell; every later year (columns C-F) is the plain operating =rev-exp,
    # with NO reference to the startup row. (The existing test checks B and C only.)
    res = canonical_result
    path = tmp_path / "cash5.xlsx"
    build_xlsx(res, str(path))
    ws = load_workbook(path)["Projection"]
    labels = {ws.cell(row=r, column=1).value: r
              for r in range(1, ws.max_row + 1)
              if isinstance(ws.cell(row=r, column=1).value, str)}
    net_row = labels["Net income"]
    tr, te, su = labels["Total Revenue"], labels["Total Expenses"], labels["Total Startup Costs"]
    # Year 1 (col B) folds in the one-time startup; Years 2-5 (cols C-F) do not.
    assert ws.cell(row=net_row, column=2).value == f"=B{tr}-B{te}-B{su}"
    for col_idx, col in ((3, "C"), (4, "D"), (5, "E"), (6, "F")):
        formula = ws.cell(row=net_row, column=col_idx).value
        assert formula == f"={col}{tr}-{col}{te}", col
        assert f"B{su}" not in formula and f"{col}{su}" not in formula, col


def test_capital_required_is_the_launch_trough_plus_reserve_not_the_cash_net(
        canonical_result, design_parity_result):
    # (capital unchanged) The cash-net display change does NOT touch capital required: it
    # is still |launch-window cumulative-cash trough| + reserve buffer, reconstructed here
    # straight from the monthly series (which is unchanged), for BOTH fixtures.
    for res in (canonical_result, design_parity_result):
        g = res.decision.grand_opening_month
        reserve = D(str(res.assumptions.reserve_buffer))
        launch = [D(str(m.cumulative_cash)) for m in res.monthly if m.index <= g + 11]
        trough = min(launch)
        peak_shortfall = abs(min(Decimal("0"), trough))
        expected_capital = peak_shortfall + reserve
        assert D(str(res.decision.startup_capital_required)) == expected_capital
        assert D(str(res.decision.peak_cash_shortfall)) == peak_shortfall
        # The figure is reserve + a positive trough — never a function of the displayed
        # Year-1 cash net's sign-handling; it stands on the monthly cash low point.
        assert peak_shortfall > 0
        assert D(str(res.decision.startup_capital_required)) > reserve


def test_income_series_and_year5_income_are_cash_based(canonical_result):
    # (incomeSeries / year5Income) The sparkline feed is cash-based: each incomeSeries[y]
    # == cash_net(y); year5Income == cash_net(5), which equals the Year-5 OPERATING net
    # because no startup lands in Year 5; and incomeSeries[0] carries the Year-1 startup
    # hit, so it is strictly below the Year-1 operating net.
    res = canonical_result
    vm = to_view_model(res)
    for y in (1, 2, 3, 4, 5):
        assert abs(D(str(vm["incomeSeries"][y - 1]["raw"])) - cash_net(res, y)) < Decimal("0.01"), y
    # Year 5: cash == operating (no startup in Y5), and it is the last series point.
    assert abs(D(str(vm["year5Income"]["raw"])) - cash_net(res, 5)) < Decimal("0.01")
    assert abs(D(str(vm["year5Income"]["raw"])) - D(str(res.annual[5].net))) < Decimal("0.01")
    assert vm["year5Income"]["raw"] == vm["incomeSeries"][4]["raw"]
    # Year 1: the startup hit pushes the first series point below the operating net.
    assert D(str(vm["incomeSeries"][0]["raw"])) < D(str(res.annual[1].net))
    assert abs(D(str(vm["incomeSeries"][0]["raw"]))
               - (D(str(res.annual[1].net)) - D(str(res.startup_total)))) < Decimal("0.01")


def test_net_margin_guardrail_evaluates_on_the_cash_margin():
    # (§12.2 on cash margin) The guardrail runs on the DISPLAYED cash margin. A high-
    # operating-margin aggressive case has a Year-1 OPERATING margin above the ~30% band,
    # yet because the startup hit depresses the Year-1 CASH margin below 30%, Year 1 does
    # NOT trip — while the steady-state Years 4-5 (cash == operating there) DO trip.
    res = _projection("0.40", shares=("0.15", "0.20", "0.25", "0.27", "0.30"),
                      source_of_funds="2000000")
    # Year-1 operating margin is implausibly high, but its cash margin is not.
    assert res.annual[1].margin > D("0.30")
    assert cash_margin(res, 1) < D("0.30")
    assert "net_margin_out_of_band" not in res.flags          # Year-1 key does NOT fire
    # Years 4 and 5 trip on the cash margin (which equals the operating margin there).
    for y, key in ((4, "net_margin_y4_out_of_band"), (5, "net_margin_y5_out_of_band")):
        assert cash_margin(res, y) > D("0.30"), y
        assert key in res.flags, key
        assert abs(D(str(res.flags[key]["value"])) - cash_margin(res, y)) < Decimal("0.0001"), y
        assert res.flags[key]["requires_note"] is True


def test_canonical_never_recovers_keeps_payback_na_with_reason(canonical_result):
    # (never-recovers N/A) The canonical 60%-labor case never recovers its startup within
    # the 60-month horizon: payback is N/A-with-reason (never a misleading 0 or Month 60),
    # even though the OPERATING net turns positive in later years — the operating/cash
    # distinction is exactly why cash payback can stay unreached.
    res = canonical_result
    assert res.decision.payback_month is None
    # cumulative cash never returns to >= 0 after going negative.
    cum = [D(str(m.cumulative_cash)) for m in res.monthly]
    assert min(cum) < 0
    assert all(c < 0 for c in cum if c == cum[-1]) and cum[-1] < 0   # still negative at horizon end
    # operating net is positive in the steady-state years, yet cash never recovers.
    assert res.annual[3].net > 0 and res.annual[5].net > 0
    # the N/A reason travels through flags -> view-model milestone + KPI (never a 0).
    reason = res.flags.get("payback_month")
    assert reason and reason.startswith("N/A")
    vm = to_view_model(res)
    pb = vm["milestones"]["payback"]
    assert pb["raw"] is None and pb["display"] == "N/A" and pb["reason"] == reason
    kpi = next(k for k in vm["kpis"] if k["label"] == "Payback period")
    assert kpi["value"]["raw"] is None and kpi["value"]["display"] == "N/A"

"""5-year horizon (model 2.6.0) + editable donation drivers (E1/E2).

These pin the NEW surface the 3-year tests never covered: Year 4 / Year 5 driven by
their own share inputs through the compounding escalator, the §12.2 Y4/Y5 guardrails,
the renamed "Net income" total, the new view-model fields (incomeSeries / year5Income
/ settings drivers), the 5-column .xlsx, and — the load-bearing invariant — that the
decision metrics (capital / break-even / first-year cash gap) stay Year-1-anchored and
are INDEPENDENT of the Year 4/5 inputs.
"""
import os
import tempfile
from decimal import Decimal

from openpyxl import load_workbook

from engine import model
from engine.compute import (
    Assumptions,
    DemandDrivers,
    Inputs,
    TradeArea,
    compute,
    compute_annual,
)
from engine.money import D
from engine.xlsx import build_xlsx


def _inputs(**kw):
    base = dict(
        org_name="HoH", city="x", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10",
        share_y4="0.11", share_y5="0.12",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="300000",
    )
    base.update(kw)
    return Inputs(**base)


def _compute(labor="0.40", **kw):
    return compute(_inputs(**kw), Assumptions(labor_pct=labor), DemandDrivers(),
                   TradeArea(basis="city", households="31798"), overrides={})


# --------------------------------------------------------------- horizon shape
def test_compute_returns_five_annual_years():
    res = _compute()
    assert sorted(res.annual.keys()) == [1, 2, 3, 4, 5]
    assert sorted(res.occupancy.keys()) == [1, 2, 3, 4, 5]


def test_year4_year5_revenue_track_their_own_shares():
    # Revenue is linear in share (retail = H*share*freq*dv; +salvage), so the Y5/Y4
    # revenue ratio equals the share ratio 0.12/0.11 exactly — Y4/Y5 are real
    # independent inputs, not a midpoint or a repeat of Year 3.
    res = _compute()
    r3 = D(str(res.annual[3].total_rev))
    r4 = D(str(res.annual[4].total_rev))
    r5 = D(str(res.annual[5].total_rev))
    assert r4 > r3      # 0.11 > 0.10
    assert r5 > r4      # 0.12 > 0.11
    assert abs(r5 / r4 - (Decimal("0.12") / Decimal("0.11"))) < Decimal("1e-9")


def test_year4_year5_default_to_the_decelerating_plateau():
    # The engine resolves whatever shares it is given; the 0.11/0.12 plateau is the
    # product default supplied at every edge. Constructing with the defaults and
    # reading them back proves the canonical curve is 6/8/10/11/12%.
    res = _compute()
    assert res.annual[4].share == Decimal("0.11")
    assert res.annual[5].share == Decimal("0.12")


# ------------------------------------------------- escalator compounds through Y5
def test_rent_escalator_compounds_through_year5():
    inputs = _inputs()
    years, _su, _st, occ = compute_annual(
        inputs, Assumptions(), DemandDrivers(),
        TradeArea(basis="city", households="31798"), {})
    occ1 = occ[1]
    e = D(model.RENT_ESCALATOR)
    for y in (1, 2, 3, 4, 5):
        assert occ[y] == occ1 * (Decimal("1") + e) ** (y - 1)
    # The Year 4 / Year 5 powers are the NEW surface (3-year stopped at ^2).
    assert occ[4] == occ1 * Decimal("1.03") ** 3
    assert occ[5] == occ1 * Decimal("1.03") ** 4
    # and the Rent EXPENSE line for Y4/Y5 equals that escalated occupancy.
    assert D(str(years[4].expenses["Rent"])) == occ[4]
    assert D(str(years[5].expenses["Rent"])) == occ[5]


# ------------------------------------------------------------ §12.2 Y4/Y5 flags
def test_high_year4_year5_share_raises_out_of_band_flags():
    res = _compute(share_y4="0.20", share_y5="0.25")  # both > 8% band
    assert res.flags["share_y4_out_of_band"]["requires_note"] is True
    assert res.flags["share_y5_out_of_band"]["requires_note"] is True
    assert abs(res.flags["share_y4_out_of_band"]["value"] - 0.20) < 1e-9
    assert abs(res.flags["share_y5_out_of_band"]["value"] - 0.25) < 1e-9


def test_low_year4_year5_share_does_not_flag():
    res = _compute(share_y4="0.05", share_y5="0.07")  # both within the 8% band
    assert "share_y4_out_of_band" not in res.flags
    assert "share_y5_out_of_band" not in res.flags


def test_year4_net_margin_guardrail_fires_above_thirty_percent():
    # High late-year share + low labor pushes the Year 4 margin well past 30%.
    res = _compute(labor="0.25", share_y4="0.30", share_y5="0.30")
    assert res.annual[4].margin is not None
    assert D(str(res.annual[4].margin)) > D(model.NET_MARGIN_FLAG_MAX)
    assert res.flags["net_margin_y4_out_of_band"]["requires_note"] is True
    assert res.flags["net_margin_y5_out_of_band"]["requires_note"] is True


# --------------------------- first-year cash gap stays Year-1-anchored (invariant)
def test_first_year_cash_gap_is_independent_of_year4_year5_inputs():
    # The first-year cash gap comes from the Year-1 window only, so wildly different
    # Year 4/5 share inputs must NOT move it by a cent. (Capital and break-even DO now
    # read the whole 60 months — owner decision 2026-10-08, "Full 60 months" — so a
    # collapsing Year 4 can push break-even out and capital up.)
    base = _compute(share_y4="0.11", share_y5="0.12")
    moved = _compute(share_y4="0.01", share_y5="0.40")
    assert base.decision.first_year_cash_gap == moved.decision.first_year_cash_gap
    assert base.decision.break_even_month == 4
    assert moved.decision.break_even_month > 12   # Year 4 collapses -> later break-even
    # ...but the CAGR (Y1->Y5) DOES move, because it reads Year 5 revenue.
    assert base.decision.revenue_cagr != moved.decision.revenue_cagr


def test_cagr_spans_year1_to_year5_four_periods():
    res = _compute()
    r1 = D(str(res.annual[1].total_rev))
    r5 = D(str(res.annual[5].total_rev))
    expected = (r5 / r1) ** (Decimal("1") / Decimal("4")) - Decimal("1")
    assert abs(D(str(res.decision.revenue_cagr)) - expected) < Decimal("1e-9")


# ------------------------------------------------------ view-model 5-year surface
def test_view_model_rows_carry_five_year_cells_and_net_income_label():
    vm = _compute().view_model
    for row in vm["rows"]:
        for k in ("y1", "y2", "y3", "y4", "y5"):
            assert k in row, (row["label"], k)
    labels = [r["label"] for r in vm["rows"]]
    assert "Net income" in labels        # renamed total
    assert "Net profit" not in labels    # old label is gone everywhere


def test_income_series_is_annual_net_income_y1_to_y5():
    # CASH-based (epic #321): incomeSeries Y1 includes the one-time startup hit
    # (operating net − startup_total); Years 2-5 are operating net (== cash). The
    # series and year5Income are the displayed Net-income surfaces, so they match the
    # cash basis of the 5-year row / KPI exactly.
    from engine.compute import cash_net
    res = _compute()
    vm = res.view_model
    assert len(vm["incomeSeries"]) == 5
    for i, y in enumerate((1, 2, 3, 4, 5)):
        assert vm["incomeSeries"][i]["raw"] == float(cash_net(res, y))
    # Year 1 really is startup-reduced, not the operating net.
    assert vm["incomeSeries"][0]["raw"] == float(
        D(str(res.annual[1].net)) - D(str(res.startup_total)))
    assert vm["year5Income"]["raw"] == float(cash_net(res, 5))
    # the series is server-formatted {raw,display} (one format authority).
    assert all("display" in cell for cell in vm["incomeSeries"])


def test_settings_expose_share_y4_y5_and_editable_donation_drivers():
    res = _compute(share_y4="0.11", share_y5="0.12", donation_value="74")
    s = res.view_model["settings"]
    assert abs(s["shareY4"] - 0.11) < 1e-9
    assert abs(s["shareY5"] - 0.12) < 1e-9
    assert abs(s["donationValue"] - 74.0) < 1e-9
    assert s["donationsPerHouseholdPerYear"] == model.DONATIONS_PER_HH_PER_YEAR
    assert abs(s["basket"] - float(D(model.AVG_BASKET_VALUE))) < 1e-9


def test_net_income_kpi_replaces_net_profit():
    kpis = _compute().view_model["kpis"]
    labels = [k["label"] for k in kpis]
    assert "Net income" in labels
    assert "Net profit" not in labels
    cagr = next(k for k in kpis if k["label"] == "Revenue CAGR")
    assert cagr["sub"] == "Y1->Y5"


# ---------------------------------------------------------- 5-column .xlsx export
def test_xlsx_emits_five_year_columns_and_net_income_label():
    res = _compute()
    fd, path = tempfile.mkstemp(suffix=".xlsx")
    os.close(fd)
    try:
        build_xlsx(res, path)
        wb = load_workbook(path)
        ws = wb["Projection"]
        assert "5-Year" in ws["A1"].value
        header = None
        for r in range(1, ws.max_row + 1):
            if ws.cell(row=r, column=2).value == "Year 1":
                header = [ws.cell(row=r, column=c).value for c in range(2, 7)]
                break
        assert header == ["Year 1", "Year 2", "Year 3", "Year 4", "Year 5"]
        labels = [ws.cell(row=r, column=1).value for r in range(1, ws.max_row + 1)]
        assert "Net income" in labels
        assert "Net profit" not in labels
        wb.close()
    finally:
        os.remove(path)

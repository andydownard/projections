"""RED first: monthly pre-opening timeline (§5/§6) + the penny-exact roll-up.

The timeline is project months 1..N (N = G + 11). Months 1..G-1 are first-class
pre-opening P&L months; G..N are the 12 operating months. Year-1 annual P&L == sum
of the 12 operating months, to the penny, for every line. Cumulative cash, trough,
and break-even month are derived from the monthly series.
"""
from decimal import Decimal

from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
from engine.money import D


def _opening_at(opening_month_number, cost_schedule=()):
    inputs = Inputs(
        org_name="HoH", city="x", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10",
        share_y4="0.11", share_y5="0.12", donation_value="74",
        building_sqft="10000", salesfloor_pct="0.70", occupancy_annual="120000",
        lease_type="nnn", source_of_funds="300000",
        opening_month_number=opening_month_number, cost_schedule=cost_schedule,
    )
    return compute(inputs, Assumptions(), DemandDrivers(),
                   TradeArea(basis="city", households="31798"), overrides={})


def test_sixty_operating_months(canonical_result):
    # CASH model 2.7.0: the operating ramp spans the full 5-year horizon (60 months), so
    # the cash-flow series can reach the payback crossing.
    ops = [m for m in canonical_result.monthly if m.kind == "operating"]
    assert len(ops) == 60
    # Default opening month is 1, so operating project months are 1..60.
    assert [m.index for m in ops] == list(range(1, 61))
    # Year-1 is the first 12 operating months (the launch S-curve, byte-identical).
    assert len([m for m in ops if m.index <= 12]) == 12


def test_no_pre_open_months_when_opening_at_month_one(canonical_result):
    # G == 1 => the pre-opening range 1..G-1 is empty (single lump at opening,
    # reproducing today's behavior — NOT a separate M0 row). The full horizon is 60.
    assert all(m.kind == "operating" for m in canonical_result.monthly)
    assert len(canonical_result.monthly) == 60


def test_pre_opening_months_are_first_class_pl_months():
    # Opening at month 4 with a cost on each pre-opening month: months 1..3 are
    # real P&L months whose net = -(scheduled cost), not excluded, not merged.
    schedule = (
        {"category": "Consultant", "month": 1, "amount": 10000},
        {"category": "Build-out", "month": 2, "amount": 20000},
        {"category": "Equipment", "month": 3, "amount": 5000},
    )
    res = _opening_at(4, schedule)
    rows = {m.index: m for m in res.monthly}
    # N = G + 59 = 63 project months; months 1..3 pre-opening, 4..63 operating.
    assert len(res.monthly) == 63
    assert [r.kind for r in res.monthly[:3]] == ["pre_open", "pre_open", "pre_open"]
    assert all(m.kind == "operating" for m in res.monthly[3:])
    # Pre-opening months carry no operating revenue/expense; their loss is the cost.
    assert rows[1].revenue == 0 and rows[1].expenses == 0
    assert D(str(rows[1].net)) == Decimal("0")
    assert D(str(rows[1].startup_outflow)) == Decimal("10000")
    assert D(str(rows[1].cash_net)) == Decimal("-10000")
    assert D(str(rows[2].cash_net)) == Decimal("-20000")
    # Cumulative cash accumulates the pre-opening losses before opening.
    assert D(str(rows[3].cumulative_cash)) == Decimal("-35000")


def test_n_equals_g_plus_fiftynine():
    for g in (1, 2, 6, 12):
        res = _opening_at(g)
        assert max(m.index for m in res.monthly) == g + 59
        ops = [m for m in res.monthly if m.kind == "operating"]
        assert len(ops) == 60
        assert [m.index for m in ops] == list(range(g, g + 60))


def _y1_ops(res):
    """The Year-1 operating months (the first 12 operating months, G..G+11)."""
    g = res.decision.grand_opening_month
    return [m for m in res.monthly if m.kind == "operating" and g <= m.index <= g + 11]


def test_operating_rollup_holds_when_opening_is_late():
    # Year-1 annual P&L == sum of the 12 Year-1 operating months even when opening is
    # late (the pre-opening months never absorb or distort the operating roll-up). The
    # roll-up is scoped to the Year-1 window — Years 2-5 have their own operating months.
    res = _opening_at(6)
    ops = _y1_ops(res)
    assert len(ops) == 12
    rev = sum((D(str(m.revenue)) for m in ops), Decimal("0"))
    exp = sum((D(str(m.expenses)) for m in ops), Decimal("0"))
    net = sum((D(str(m.net)) for m in ops), Decimal("0"))
    assert rev == D(str(res.annual[1].total_rev))
    assert exp == D(str(res.annual[1].total_exp))
    assert net == D(str(res.annual[1].net))


def test_every_year_rolls_up_from_its_twelve_operating_months():
    # Regression #15, now PER YEAR: each year's annual revenue / operating expense / net
    # equals the sum of that year's 12 operating months, to the penny (Decimal, residual
    # in the last bucket). Years 2-5 use the uniform intra-year split; Year 1 the S-curve.
    res = _opening_at(1)
    for y in (1, 2, 3, 4, 5):
        lo, hi = 12 * (y - 1) + 1, 12 * y          # G=1 => Year y is months 12(y-1)+1..12y
        ops = [m for m in res.monthly if lo <= m.index <= hi]
        assert len(ops) == 12, y
        assert sum((D(str(m.revenue)) for m in ops), Decimal("0")) == \
            D(str(res.annual[y].total_rev)), y
        assert sum((D(str(m.expenses)) for m in ops), Decimal("0")) == \
            D(str(res.annual[y].total_exp)), y
        assert sum((D(str(m.net)) for m in ops), Decimal("0")) == \
            D(str(res.annual[y].net)), y


def test_cumulative_is_running_sum_across_pre_open_and_operating():
    schedule = (
        {"category": "A", "month": 1, "amount": 12000},
        {"category": "B", "month": 2, "amount": 8000},
    )
    res = _opening_at(3, schedule)
    running = Decimal("0")
    for m in res.monthly:
        running += D(str(m.cash_net))
        assert D(str(m.cumulative_cash)) == running


def test_post_opening_support_cost_lands_on_its_month():
    # A row after the opening milestone (post-open support) lands on that month and
    # is an additional outflow on top of that operating month's net.
    schedule = (
        {"category": "Launch", "month": 1, "amount": 50000},
        {"category": "Post-open support", "month": 14, "amount": 9000},
    )
    res = _opening_at(1, schedule)
    row14 = next(m for m in res.monthly if m.index == 14)
    assert D(str(row14.startup_outflow)) == Decimal("9000")
    assert row14.kind == "operating"
    assert D(str(row14.cash_net)) == D(str(row14.net)) - Decimal("9000")


def test_timeline_extends_past_operating_year_for_late_cost():
    # A scheduled cost beyond the 60-month operating window extends the timeline
    # (N = max(G+59, last month)) so the cost is never dropped; the extra months carry
    # no operating ramp.
    schedule = ({"category": "Year-6 refit", "month": 65, "amount": 30000},)
    res = _opening_at(1, schedule)
    assert max(m.index for m in res.monthly) == 65
    ramp = [m for m in res.monthly if m.kind == "operating" and m.index <= 12]
    assert sum((D(str(m.revenue)) for m in ramp), Decimal("0")) == \
        D(str(res.annual[1].total_rev))
    beyond = next(m for m in res.monthly if m.index == 65)
    assert beyond.revenue == 0 and beyond.expenses == 0
    assert D(str(beyond.startup_outflow)) == Decimal("30000")


def test_no_scheduled_cost_keeps_timeline_at_g_plus_fiftynine():
    res = _opening_at(4)
    assert max(m.index for m in res.monthly) == 4 + 59


def test_revenue_rolls_up_to_annual_to_the_penny(canonical_result):
    # Scoped to the Year-1 operating window (G=1 => months 1..12); Years 2-5 have their
    # own operating months (covered by test_every_year_rolls_up_from_its_twelve_…).
    ops = [m for m in canonical_result.monthly if m.kind == "operating" and m.index <= 12]
    rev = sum((D(str(m.revenue)) for m in ops), Decimal("0"))
    assert rev == D(str(canonical_result.annual[1].total_rev))


def test_expenses_roll_up_to_annual_to_the_penny(canonical_result):
    ops = [m for m in canonical_result.monthly if m.kind == "operating" and m.index <= 12]
    exp = sum((D(str(m.expenses)) for m in ops), Decimal("0"))
    # operating-month expenses exclude one-time startup outflows; they equal the
    # annual operating total_exp to the penny.
    assert exp == D(str(canonical_result.annual[1].total_exp))


def test_net_rolls_up_to_annual_to_the_penny(canonical_result):
    ops = [m for m in canonical_result.monthly if m.kind == "operating" and m.index <= 12]
    net = sum((D(str(m.net)) for m in ops), Decimal("0"))
    assert net == D(str(canonical_result.annual[1].net))


def test_cumulative_cash_is_running_sum_including_startup(canonical_result):
    months = canonical_result.monthly
    # cumulativeCash[m] = cumulativeCash[m-1] + cashNet[m]; first month seeds from
    # the prior. The minimum across the series is the trough.
    running = Decimal("0")
    for m in months:
        running += D(str(m.cash_net))
        assert D(str(m.cumulative_cash)) == running


def test_startup_outflow_drives_a_negative_trough(canonical_result):
    troughs = [D(str(m.cumulative_cash)) for m in canonical_result.monthly]
    assert min(troughs) < 0  # startup spend pushes cumulative cash negative


def test_break_even_month_is_first_sustained_nonneg_net(canonical_result):
    # Break-even is computed over the YEAR-1 operating window only (so it is byte-
    # identical to the 12-month model and a later-year operating dip can never erase a
    # real Year-1 break-even). Assert the invariant over the Year-1 operating months.
    be = canonical_result.monthly_breakeven
    g = canonical_result.decision.grand_opening_month
    y1_ops = [m for m in canonical_result.monthly
              if m.kind == "operating" and g <= m.index <= g + 11]
    if be is not None:
        target = next(m for m in y1_ops if m.index == be)
        assert target.net >= 0
        assert all(m.net >= 0 for m in y1_ops if m.index >= be)

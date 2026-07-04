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


def test_twelve_operating_months(canonical_result):
    ops = [m for m in canonical_result.monthly if m.kind == "operating"]
    assert len(ops) == 12
    # Default opening month is 1, so operating project months are 1..12.
    assert [m.index for m in ops] == list(range(1, 13))


def test_no_pre_open_months_when_opening_at_month_one(canonical_result):
    # G == 1 => the pre-opening range 1..G-1 is empty (single lump at opening,
    # reproducing today's behavior — NOT a separate M0 row).
    assert all(m.kind == "operating" for m in canonical_result.monthly)
    assert len(canonical_result.monthly) == 12


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
    # N = G + 11 = 15 project months; months 1..3 pre-opening, 4..15 operating.
    assert len(res.monthly) == 15
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


def test_n_equals_g_plus_eleven():
    for g in (1, 2, 6, 12):
        res = _opening_at(g)
        assert max(m.index for m in res.monthly) == g + 11
        ops = [m for m in res.monthly if m.kind == "operating"]
        assert len(ops) == 12
        assert [m.index for m in ops] == list(range(g, g + 12))


def test_operating_rollup_holds_when_opening_is_late():
    # Year-1 annual P&L == sum of the 12 operating months even when opening is late
    # (the pre-opening months never absorb or distort the operating roll-up).
    res = _opening_at(6)
    ops = [m for m in res.monthly if m.kind == "operating"]
    rev = sum((D(str(m.revenue)) for m in ops), Decimal("0"))
    exp = sum((D(str(m.expenses)) for m in ops), Decimal("0"))
    net = sum((D(str(m.net)) for m in ops), Decimal("0"))
    assert rev == D(str(res.annual[1].total_rev))
    assert exp == D(str(res.annual[1].total_exp))
    assert net == D(str(res.annual[1].net))


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
    # A scheduled cost beyond G+11 extends the timeline (N = max(G+11, last month))
    # so the cost is never dropped; the extra months carry no operating ramp.
    schedule = ({"category": "Year-3 refit", "month": 20, "amount": 30000},)
    res = _opening_at(1, schedule)
    assert max(m.index for m in res.monthly) == 20
    ramp = [m for m in res.monthly if m.kind == "operating" and m.index <= 12]
    assert sum((D(str(m.revenue)) for m in ramp), Decimal("0")) == \
        D(str(res.annual[1].total_rev))
    beyond = next(m for m in res.monthly if m.index == 20)
    assert beyond.revenue == 0 and beyond.expenses == 0
    assert D(str(beyond.startup_outflow)) == Decimal("30000")


def test_no_scheduled_cost_keeps_timeline_at_g_plus_eleven():
    res = _opening_at(4)
    assert max(m.index for m in res.monthly) == 15


def test_revenue_rolls_up_to_annual_to_the_penny(canonical_result):
    ops = [m for m in canonical_result.monthly if m.kind == "operating"]
    rev = sum((D(str(m.revenue)) for m in ops), Decimal("0"))
    assert rev == D(str(canonical_result.annual[1].total_rev))


def test_expenses_roll_up_to_annual_to_the_penny(canonical_result):
    ops = [m for m in canonical_result.monthly if m.kind == "operating"]
    exp = sum((D(str(m.expenses)) for m in ops), Decimal("0"))
    # operating-month expenses exclude one-time startup outflows; they equal the
    # annual operating total_exp to the penny.
    assert exp == D(str(canonical_result.annual[1].total_exp))


def test_net_rolls_up_to_annual_to_the_penny(canonical_result):
    ops = [m for m in canonical_result.monthly if m.kind == "operating"]
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
    be = canonical_result.monthly_breakeven
    ops = [m for m in canonical_result.monthly if m.kind == "operating"]
    if be is not None:
        # net[be] >= 0 and stays non-negative thereafter
        assert ops[be - 1].net >= 0
        assert all(m.net >= 0 for m in ops[be - 1:])


# ----------------------------------------------- Task 6.2: fixed/variable/payroll split
def test_fixed_costs_are_spread_flat_not_revenue_weighted():
    # With zero revenue every operating-month expense is pure FIXED cost. The model
    # spreads fixed lines FLAT (1/12 per operating month, last month absorbs the
    # residual), so the first 11 operating months are byte-equal — NOT the ascending
    # revenue-weighted shape the pre-6.2 single "other" stream produced (month 12 would
    # be ~3x month 1 under the S-curve).
    from engine.money import round_dollars
    inputs = Inputs(
        org_name="Zero", city="x", opening_status="pre_launch",
        share_y1="0", share_y2="0", share_y3="0", share_y4="0", share_y5="0",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="300000",
    )
    res = compute(inputs, Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides={})
    ops = [m for m in res.monthly if m.kind == "operating"]
    fixed_annual = D(str(res.annual[1].total_exp))  # all expense is fixed at 0 revenue
    assert fixed_annual > 0
    first = D(str(ops[0].expenses))
    for m in ops[:11]:
        assert D(str(m.expenses)) == first, m.index         # flat: first 11 all equal
    # the 12th month is the same to the dollar; it only absorbs the sub-dollar cent
    # residual (NOT the old revenue-weighted shape where month 12 was ~3x month 1).
    assert round_dollars(D(str(ops[11].expenses))) == round_dollars(first)
    # each flat month is annual_fixed / 12 (to the dollar).
    assert round_dollars(first) == round_dollars(fixed_annual / 12)
    # penny-exact roll-up survives the flat spread.
    assert sum((D(str(m.expenses)) for m in ops), Decimal("0")) == fixed_annual


def test_expense_streams_split_fixed_payroll_and_pct_of_revenue(canonical_result):
    # ENGINE_CONTRACT §5.2 three-stream split: Payroll AND Payroll taxes ride the
    # payroll hire-ramp (_PAYROLL_WEIGHTS, NOT the revenue S-curve); card fees /
    # marketing / supplies ride the revenue S-curve (_REVENUE_WEIGHTS); every other
    # (fixed) line spreads flat (_flat_monthly). Reconstruct the three streams with the
    # engine's own helpers and assert the per-month expense equals their sum, exactly.
    from engine.monthly import (_distribute, _flat_monthly,
                                _PAYROLL_WEIGHTS, _PCT_OF_REVENUE_LABELS,
                                _REVENUE_WEIGHTS)
    y1 = canonical_result.annual[1]
    pct = sum((D(str(v)) for k, v in y1.expenses.items() if k in _PCT_OF_REVENUE_LABELS),
              Decimal("0"))
    pay = sum((D(str(y1.expenses.get(k, Decimal("0"))))
               for k in ("Payroll", "Payroll taxes")), Decimal("0"))
    fix = D(str(y1.total_exp)) - pct - pay
    # Payroll taxes must be part of the payroll stream, not %-of-revenue.
    assert "Payroll taxes" not in _PCT_OF_REVENUE_LABELS
    assert _PCT_OF_REVENUE_LABELS == frozenset(
        {"Credit card fees", "Marketing & outreach", "Supplies & processing"})
    pct_parts = _distribute(pct, _REVENUE_WEIGHTS)
    pay_parts = _distribute(pay, _PAYROLL_WEIGHTS)
    fix_parts = _flat_monthly(fix)
    expected = [pct_parts[i] + pay_parts[i] + fix_parts[i] for i in range(12)]
    ops = [m for m in canonical_result.monthly if m.kind == "operating"]
    for i in range(12):  # every operating month matches component-by-component
        assert D(str(ops[i].expenses)) == expected[i], i
    assert sum((D(str(m.expenses)) for m in ops), Decimal("0")) == D(str(y1.total_exp))


def test_canonical_trough_capital_and_breakeven_shift_with_flat_fixed_costs(canonical_result):
    # Charging fixed costs flat (front-loaded vs the back-loaded revenue S-curve) and
    # payroll taxes on the payroll ramp deepens the early cash trough. Re-pinned at the
    # 2.7.0 regen (Task 6.4 — 990-grounded payroll tax 8% + Insurance $10k deepen it
    # further): the canonical trough is ≈ -$322,854 at project month 7, capital ≈
    # $347,854, operating break-even month 8. (6.2: -$317,403 / $342,403 / month 8.)
    from engine.money import round_dollars
    troughs = [(m.index, D(str(m.cumulative_cash))) for m in canonical_result.monthly]
    trough_month, trough = min(troughs, key=lambda t: t[1])
    assert trough_month == 7
    assert round_dollars(trough) == Decimal("-322854")
    cap = D(str(canonical_result.decision.startup_capital_required))
    assert round_dollars(cap) == Decimal("347854")
    assert canonical_result.decision.break_even_month == 8

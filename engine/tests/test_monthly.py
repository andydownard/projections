"""RED first: monthly pre-opening timeline (§5/§6) + the penny-exact roll-up.

The timeline is project months 1..N (N = G + 11). Months 1..G-1 are first-class
pre-opening P&L months; G..N are the 12 operating months. Year-1 annual P&L == sum
of the 12 operating months, to the penny, for every line. Cumulative cash, trough,
and break-even month are derived from the monthly series.
"""
from decimal import Decimal

import pytest

from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
from engine.money import D
from engine.monthly import _BLEND_MONTHS, _blend_then_flat, _ease, _ease_weight, _year_slices

_PENNY = Decimal("0.01")


def _penny(value):
    """Round a Decimal to the penny — the footing contract this module's docstring

    states ("to the penny", Regression #15), not infinite-Decimal-precision equality.
    Model v3's new chained divisions (customers, items_sold/produced, production
    hours) push some intermediate sums past Python decimal's default 28-significant-
    digit context precision, so two mathematically-identical totals reached via a
    different operation order can differ in the ~22nd decimal place (millionths of a
    trillionth of a cent) — real, but far below a penny, and the wrong thing for an
    exact ``==`` to catch (same class of test-fragility the exported .xlsx's exact
    ``float ==`` comparison hit; see test_xlsx.py).
    """
    return D(value).quantize(_PENNY)


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
    assert _penny(exp) == _penny(res.annual[1].total_exp)
    assert _penny(net) == _penny(res.annual[1].net)


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
        assert _penny(sum((D(str(m.expenses)) for m in ops), Decimal("0"))) == \
            _penny(res.annual[y].total_exp), y
        assert _penny(sum((D(str(m.net)) for m in ops), Decimal("0"))) == \
            _penny(res.annual[y].net), y


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
    assert _penny(exp) == _penny(canonical_result.annual[1].total_exp)


def test_net_rolls_up_to_annual_to_the_penny(canonical_result):
    ops = [m for m in canonical_result.monthly if m.kind == "operating" and m.index <= 12]
    net = sum((D(str(m.net)) for m in ops), Decimal("0"))
    assert _penny(net) == _penny(canonical_result.annual[1].net)


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
    # Year-1 operating months only (the fused monthly[] spans 60 months; the 6.2 split
    # is a Year-1 property, so scope to the first 12 operating months).
    ops = [m for m in res.monthly if m.kind == "operating"][:12]
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
    # ENGINE_CONTRACT §5.2 three-stream split: Payroll, Payroll taxes, AND (Model v3)
    # Workers' comp expense ride the payroll hire-ramp (_PAYROLL_WEIGHTS, NOT the
    # revenue S-curve); card fees / marketing / supplies ride the revenue S-curve
    # (_REVENUE_WEIGHTS); every other (fixed) line spreads flat (_flat_monthly).
    # Reconstruct the three streams with the engine's own helpers and assert the
    # per-month expense equals their sum, exactly.
    from engine.monthly import (
        _PAYROLL_WEIGHTS,
        _PCT_OF_REVENUE_LABELS,
        _REVENUE_WEIGHTS,
        _distribute,
        _flat_monthly,
    )
    y1 = canonical_result.annual[1]
    pct = sum((D(str(v)) for k, v in y1.expenses.items() if k in _PCT_OF_REVENUE_LABELS),
              Decimal("0"))
    # Model v3: Workers' comp expense (2% of payroll) rides the payroll ramp, same
    # stream as Payroll/Payroll taxes, not the flat fixed residual (Task 1.5).
    pay = sum((D(str(y1.expenses.get(k, Decimal("0"))))
               for k in ("Payroll", "Payroll taxes", "Workers' comp expense")), Decimal("0"))
    fix = D(str(y1.total_exp)) - pct - pay
    # Payroll taxes must be part of the payroll stream, not %-of-revenue.
    assert "Payroll taxes" not in _PCT_OF_REVENUE_LABELS
    assert _PCT_OF_REVENUE_LABELS == frozenset(
        {"Credit card fees", "Marketing & outreach", "Supplies & processing"})
    pct_parts = _distribute(pct, _REVENUE_WEIGHTS)
    pay_parts = _distribute(pay, _PAYROLL_WEIGHTS)
    fix_parts = _flat_monthly(fix)
    expected = [pct_parts[i] + pay_parts[i] + fix_parts[i] for i in range(12)]
    # 3.1.0: the three-stream shape is then eased toward flat by ONE weight (the
    # smallest ease that keeps month 12 under Year 2's monthly average), so the
    # canonical expense months are that same blend of the three streams.
    from engine.monthly import _REVENUE_WEIGHTS as _rw
    rev = D(str(y1.total_rev))
    rev_parts = _distribute(rev, _rw)
    net_parts = [rev_parts[i] - expected[i] for i in range(12)]
    y2 = canonical_result.annual[2]
    w = min(_ease_weight(rev_parts, rev, D(str(y2.total_rev)) / 12),
            _ease_weight(net_parts, D(str(y1.net)), D(str(y2.net)) / 12))
    assert w < 1  # the canonical fixture DOES need easing (its exit beat Year 2)
    expected = _ease(expected, D(str(y1.total_exp)), w)
    # Year-1 operating months only (fused monthly[] spans 60 months; the three-stream
    # split is a Year-1 property).
    ops = [m for m in canonical_result.monthly if m.kind == "operating"][:12]
    for i in range(12):  # every operating month matches component-by-component
        assert D(str(ops[i].expenses)) == expected[i], i
    assert _penny(sum((D(str(m.expenses)) for m in ops), Decimal("0"))) == _penny(y1.total_exp)


def test_canonical_trough_capital_and_breakeven_after_the_ease(canonical_result):
    # Re-pinned at 3.1.0 (owner 2026-10-08: net never drops after opening). Year 2
    # loses money overall, so an eased Year 1 can no longer show a profitable month:
    # every Year-1 month is a loss, break-even is None, and the launch-window trough
    # is the Year-1 close: -(startup $238,500 + operating loss $65,068) = -$303,568,
    # so capital = $303,568 + $25,000 reserve = $328,568. (3.0.0: trough -$329,597 at
    # month 7, capital $354,597, break-even month 8.) Scoped to the launch window,
    # same as decision.py (#182).
    from engine.money import round_dollars
    g = canonical_result.decision.grand_opening_month
    launch = [(m.index, D(str(m.cumulative_cash)))
              for m in canonical_result.monthly if m.index <= g + 11]
    trough_month, trough = min(launch, key=lambda t: t[1])
    assert trough_month == 12
    assert round_dollars(trough) == Decimal("-303568")
    cap = D(str(canonical_result.decision.startup_capital_required))
    assert round_dollars(cap) == Decimal("328568")
    assert canonical_result.decision.break_even_month is None


# ------------------------------------------------ owner request, 2026-10-08 (3.1.0):
# "net income or revenue should only go up — no dip after Year 1." The 2.9.0 glide
# only softened the Year 1 -> 2 seam; Year 1's S-curve still exited ABOVE Year 2's
# own monthly average, so the Net bars fell for months. Year 1 (and each later year)
# is now EASED toward its flat average just enough that its last month never exceeds
# the next year's monthly average, which makes a non-decreasing path feasible.
_ALL_FIXTURES = [
    "canonical_result", "design_parity_result", "aggressive_result",
    "grace_result", "nnn_gross_check_result",
]


def _op_series(res, attr):
    ops = [m for m in res.monthly if m.kind == "operating"]
    return [D(str(getattr(m, attr))) for m in ops]


# sub-cent slack: the last month of each year absorbs the Decimal residual.
_CENT_SLACK = Decimal("0.01")


@pytest.mark.parametrize("fixture_name", _ALL_FIXTURES)
@pytest.mark.parametrize("series,annual_attr", [("net", "net"), ("revenue", "total_rev")])
def test_monthly_net_and_revenue_never_drop_when_the_years_grow(
        fixture_name, series, annual_attr, request):
    # Year 1 always rises within itself. Each later year (its seam month included)
    # must rise whenever its annual total is at least the prior year's; a year whose
    # total FALLS (e.g. Grace Mission's Year 2 net) may glide down, which is honest.
    res = request.getfixturevalue(fixture_name)
    vals = _op_series(res, series)
    assert len(vals) == 60
    totals = {y: D(str(getattr(res.annual[y], annual_attr))) for y in (1, 2, 3, 4, 5)}
    checked = 0
    for y in (1, 2, 3, 4, 5):
        if y > 1 and totals[y] < totals[y - 1]:
            continue
        first = 12 * (y - 1) - (1 if y > 1 else 0)  # include the seam step into year y
        for i in range(first, 12 * y - 1):
            assert vals[i + 1] >= vals[i] - _CENT_SLACK, (
                fixture_name, series, y, i + 1, vals[i], vals[i + 1])
            checked += 1
    assert checked >= 11


def test_canonical_year1_exit_net_no_longer_exceeds_year2_average(canonical_result):
    # The exact defect the owner saw: month 12 net was +$13,153 while Year 2's
    # monthly average is about -$1,877, so the bars fell for four months.
    nets = _op_series(canonical_result, "net")
    y2_avg = D(str(canonical_result.annual[2].net)) / 12
    assert nets[11] <= y2_avg + _CENT_SLACK
    assert nets[12] >= nets[11] - _CENT_SLACK


@pytest.mark.parametrize("fixture_name", _ALL_FIXTURES)
def test_easing_keeps_every_year_footing_to_the_penny(fixture_name, request):
    # Regression #15 survives the easing: each year's 12 months roll up exactly.
    res = request.getfixturevalue(fixture_name)
    ops = [m for m in res.monthly if m.kind == "operating"]
    for y in (1, 2, 3, 4, 5):
        yr = ops[12 * (y - 1): 12 * y]
        a = res.annual[y]
        assert sum((D(str(m.revenue)) for m in yr), Decimal("0")) == D(str(a.total_rev))
        assert sum((D(str(m.expenses)) for m in yr), Decimal("0")) == D(str(a.total_exp))
        assert sum((D(str(m.net)) for m in yr), Decimal("0")) == D(str(a.net))


def test_ease_weight_is_one_when_the_exit_already_fits():
    parts = [Decimal(v) for v in ("1", "2", "3")]
    assert _ease_weight(parts, Decimal("6"), Decimal("5")) == 1


def test_ease_weight_is_one_when_next_year_falls():
    # A falling next year cannot be met by any rising path; keep the shape, the dip
    # is honest (annual totals drop) rather than flattening Year 1 for nothing.
    parts = [Decimal(v) for v in ("1", "2", "9")]
    assert _ease_weight(parts, Decimal("12"), Decimal("3")) == 1


def test_ease_weight_caps_the_eased_exit_at_the_next_year_average():
    parts = [Decimal(v) for v in ("1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "18")]
    total = sum(parts, Decimal("0"))           # 84, avg 7
    cap = Decimal("10")
    w = _ease_weight(parts, total, cap)
    eased = _ease(parts, total, w)
    assert 0 < w < 1
    assert sum(eased, Decimal("0")) == total
    assert eased[-1] <= cap
    assert all(eased[i + 1] >= eased[i] for i in range(11))


def test_ease_with_weight_zero_is_flat():
    parts = [Decimal(v) for v in ("1", "2", "3", "6")]
    eased = _ease(parts, Decimal("12"), Decimal("0"), months=4)
    assert eased == [Decimal("3")] * 4


def test_blend_then_flat_feet_exactly_and_is_one_smooth_progression():
    total = Decimal("591768.631749120")
    prev_last = Decimal("40214.462298692480")
    parts = _blend_then_flat(total, prev_last)
    assert len(parts) == 12
    assert sum(parts, Decimal("0")) == total  # Regression #15: always feet exactly
    # `prev_last, parts[0..blend-1], parts[blend]` is ONE arithmetic progression —
    # every consecutive gap (including prev_last -> parts[0] and the blend -> flat
    # boundary) is identical, so there's no second jump where the glide meets the
    # flat tail (the bug an earlier, naive-average version of this fix had).
    chain = [prev_last] + parts[:_BLEND_MONTHS + 1]
    gaps = [chain[i + 1] - chain[i] for i in range(len(chain) - 1)]
    for g in gaps[1:]:
        assert abs(g - gaps[0]) < Decimal("0.0001"), gaps
    # every month after the blend window is the plain flat split, at that same level.
    for i in range(_BLEND_MONTHS, 11):
        assert parts[i] == parts[_BLEND_MONTHS]


def test_blend_then_flat_is_a_noop_when_already_at_the_flat_average():
    total = Decimal("120000")
    prev_last = total / 12  # already exactly the flat rate — nothing to glide
    parts = _blend_then_flat(total, prev_last)
    assert sum(parts, Decimal("0")) == total
    assert all(p == parts[0] for p in parts)


def test_blend_then_flat_glides_upward_smoothly_when_growth_outpaces_the_exit_rate():
    # The symmetric case to the canonical fixture's decline: a year whose annual
    # total implies a HIGHER run-rate than the prior year's exit. The glide must
    # step UP monotonically into the (also higher) solved flat level — same one-
    # smooth-progression property, opposite direction.
    total = Decimal("900000")
    prev_last = Decimal("40000")
    parts = _blend_then_flat(total, prev_last)
    assert sum(parts, Decimal("0")) == total
    chain = [prev_last] + parts[:_BLEND_MONTHS + 1]
    for i in range(len(chain) - 1):
        assert chain[i + 1] > chain[i], chain  # strictly increasing, no dip
    gaps = [chain[i + 1] - chain[i] for i in range(len(chain) - 1)]
    for g in gaps[1:]:
        assert abs(g - gaps[0]) < Decimal("0.0001"), gaps
    for i in range(_BLEND_MONTHS, 11):
        assert parts[i] == parts[_BLEND_MONTHS]


# ------------------------------------------------- Task 1.2: production-station module
def test_stations_staffed_footing(canonical_result):
    # stations_staffed is a pure rescale of monthly revenue (not itself footing-exact
    # additive to a fixed annual total); assert consistency — every operating month's
    # stations_staffed equals the same formula recomputed independently off that
    # month's own revenue, proving the wiring rather than a footing identity.
    a = canonical_result.assumptions
    salv_pct = D(str(a.salvage_pct))
    ops = [m for m in canonical_result.monthly if m.kind == "operating"]
    assert ops
    for m in ops:
        retail_m = D(str(m.revenue)) / (Decimal("1") + salv_pct)
        items_sold_m = retail_m / D(str(a.avg_item_price))
        items_produced_m = items_sold_m / D(str(a.sell_through))
        production_hours_m = items_produced_m / D(str(a.items_per_hour))
        expected = production_hours_m / D(str(a.productive_hours_per_station))
        assert D(str(m.stations_staffed)) == expected, m.index


def test_pre_open_months_have_zero_stations_staffed():
    res = _opening_at(4, ({"category": "Consultant", "month": 1, "amount": 10000},))
    pre_open = [m for m in res.monthly if m.kind == "pre_open"]
    assert pre_open
    for m in pre_open:
        assert D(str(m.stations_staffed)) == Decimal("0")


def test_stations_installed_is_ceil_of_peak(canonical_result):
    # compute()'s stations_installed is the CEILING of the peak monthly
    # stations_staffed across the whole horizon — never floor/round, and never a
    # crash when the peak is 0 (guarded implicitly: ceil(0) == 0).
    peak = max(D(str(m.stations_staffed)) for m in canonical_result.monthly)
    installed = canonical_result.stations_installed
    assert isinstance(installed, int)
    assert installed >= peak
    assert Decimal(installed) - 1 < peak


def test_build_monthly_chains_years_2_5_off_each_other_not_just_year_1(aggressive_result):
    # Regression: Year 3 must anchor its glide on Year 2's OWN computed exit value
    # (not, say, Year 1's), so a multi-year run of glides stays internally
    # consistent. Reconstruct Year 2's exit revenue/expense directly and confirm
    # Year 3's month-25 (its first month) sits on the SAME glide chain implied by
    # that exact anchor, to the penny.
    a = aggressive_result.annual
    rev1, _, net1 = _year_slices(a[1], 1, next_year=a[2])
    rev2, _, net2 = _year_slices(
        a[2], 2, prev_rev_last=rev1[-1], prev_net_last=net1[-1], next_year=a[3],
    )
    rev3, exp3, _ = _year_slices(
        a[3], 3, prev_rev_last=rev2[-1], prev_net_last=net2[-1], next_year=a[4],
    )
    month25 = next(m for m in aggressive_result.monthly if m.index == 25)
    assert D(str(month25.revenue)) == rev3[0]
    assert D(str(month25.expenses)) == exp3[0]


# ------------------------------------------- Task 1.3: within-year share ramp (linear)
def _assert_eased_from(actual, raw, total):
    """`actual` is `raw` blended toward the flat average by ONE weight (the 3.1.0 ease).

    Month 1 fixes the weight; every month through 11 must match that blend (the 12th
    absorbs the footing residual). A weight of 1 means the shape was left untouched.
    """
    avg = total / 12
    w = (actual[0] - avg) / (raw[0] - avg)
    assert Decimal("0") < w <= Decimal("1"), w
    for i in range(11):
        assert abs(actual[i] - (w * raw[i] + (1 - w) * avg)) < Decimal("1e-9"), i
    assert sum(actual, Decimal("0")) == total


def test_share_ramp_unset_is_byte_identical(canonical_result):
    # canonical_result's Inputs leave share_m1/share_m12 at their None default, so
    # Year-1 revenue must still ride the S-curve (_REVENUE_WEIGHTS) — the new optional
    # linear ramp must not perturb existing behavior when unset. From 3.1.0 the
    # S-curve is then eased toward flat (one weight), so check it is the S-curve's
    # blend, not the raw split.
    from engine.monthly import _REVENUE_WEIGHTS, _distribute

    y1 = D(str(canonical_result.annual[1].total_rev))
    raw = _distribute(y1, _REVENUE_WEIGHTS)
    ops = [m for m in canonical_result.monthly if m.kind == "operating"][:12]
    _assert_eased_from([D(str(m.revenue)) for m in ops], raw, y1)


def test_share_ramp_linear_when_set(canonical_inputs):
    # Setting share_m1/share_m12 switches Year-1 revenue onto a straight linear
    # interpolation instead of the S-curve. Recompute the expected split via the
    # SAME _linear_share_weights + _distribute call the engine itself uses (not a
    # hand-typed dollar literal), for both month 1 and month 12.
    from dataclasses import replace

    from engine.monthly import _distribute, _linear_share_weights

    inputs, assumptions, demand, trade = canonical_inputs
    ramped = replace(inputs, share_m1="0.04", share_m12="0.16")
    result = compute(ramped, assumptions, demand, trade, overrides={})

    y1 = D(str(result.annual[1].total_rev))
    weights = _linear_share_weights(D("0.04"), D("0.16"))
    raw = _distribute(y1, weights)
    ops = [m for m in result.monthly if m.kind == "operating"][:12]
    # 3.1.0: the linear split is eased toward flat by one weight, like the S-curve.
    _assert_eased_from([D(str(m.revenue)) for m in ops], raw, y1)
    # share_m1 (0.04) < share_m12 (0.16) => month 1 revenue must be the smallest
    # share and month 12 the largest — the ramp is monotonically increasing.
    assert ops[0].revenue < ops[-1].revenue


def test_share_ramp_annual_roundtrip_holds(canonical_inputs):
    # Regression #15 on the new path: with the linear ramp active, Year-1's 12
    # operating months must still sum to the annual total_rev to the penny.
    from dataclasses import replace

    inputs, assumptions, demand, trade = canonical_inputs
    ramped = replace(inputs, share_m1="0.04", share_m12="0.16")
    result = compute(ramped, assumptions, demand, trade, overrides={})

    g = result.decision.grand_opening_month
    ops = [m for m in result.monthly
           if m.kind == "operating" and g <= m.index <= g + 11]
    total_rev = sum((D(str(m.revenue)) for m in ops), Decimal("0"))
    assert total_rev == D(str(result.annual[1].total_rev))


def test_build_monthly_signature_takes_inputs_not_opening_month_number(canonical_inputs):
    # build_monthly's signature is (annual, assumptions, inputs, startup_by_month) —
    # NOT (annual, assumptions, opening_month_number, startup_by_month). Exercise it
    # directly (not just through compute()) to pin the new call shape.
    from engine.compute import compute_annual, startup_outflows_by_month
    from engine.monthly import build_monthly

    inputs, assumptions, demand, trade = canonical_inputs
    years, startup, startup_total, occupancy = compute_annual(
        inputs, assumptions, demand, trade, overrides={})
    startup_by_month = startup_outflows_by_month(inputs, assumptions, occupancy[1])
    rows, breakeven = build_monthly(years, assumptions, inputs, startup_by_month)
    assert rows
    # 3.1.0: the eased canonical Year 1 has no profitable month (Year 2 still loses
    # money overall), so break-even is None; the call shape is what this pins.
    assert breakeven is None




def test_workers_comp_expense_in_annual():
    """Workers' comp expense (2% of payroll) is included in annual calculations."""
    from decimal import Decimal

    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    from engine.money import D

    inputs = Inputs(
        org_name="x", city="x", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10", share_y4="0.11", share_y5="0.12",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="300000",
    )
    res = compute(
        inputs, Assumptions(), DemandDrivers(),
        TradeArea(basis="city", households="31798"), overrides={},
    )
    y1 = res.annual[1]
    
    # Workers' comp should be 2% of payroll
    payroll = D(str(y1.expenses["Payroll"]))
    workers_comp = D(str(y1.expenses["Workers' comp expense"]))
    expected = payroll * Decimal("0.02")
    assert workers_comp == expected

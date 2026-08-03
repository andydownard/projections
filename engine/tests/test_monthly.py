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
from engine.monthly import _BLEND_MONTHS, _blend_then_flat, _year_slices


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
    # ENGINE_CONTRACT §5.2 three-stream split: Payroll AND Payroll taxes ride the
    # payroll hire-ramp (_PAYROLL_WEIGHTS, NOT the revenue S-curve); card fees /
    # marketing / supplies ride the revenue S-curve (_REVENUE_WEIGHTS); every other
    # (fixed) line spreads flat (_flat_monthly). Reconstruct the three streams with the
    # engine's own helpers and assert the per-month expense equals their sum, exactly.
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
    # Year-1 operating months only (fused monthly[] spans 60 months; the three-stream
    # split is a Year-1 property).
    ops = [m for m in canonical_result.monthly if m.kind == "operating"][:12]
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


# ------------------------------------------------ owner defect fix, 2026-07-05:
# "net should never fall month-over-month unless a startup expense forces it" — the
# instant flat-jump at each Year N -> N+1 seam (an artificial one-month cliff with no
# cost event behind it) is replaced by a multi-month glide (`_blend_then_flat`). A
# full "net never decreases" guarantee is NOT mathematically achievable while Year 1
# keeps its deliberate dramatic S-curve shape (in any non-decreasing 12-month
# sequence summing to a fixed annual total, the last month is always >= the flat
# average — Year 1's S-curve intentionally ends well above its own average, which a
# much-slower-growth following year cannot always sustain even at ITS OWN flat
# average). What these tests lock in is the part that IS fully fixed: no more
# INSTANT one-month cliff at a year seam, and no INTRA-year-2-5 dip untouched by the
# glide window.
@pytest.mark.parametrize("fixture_name", [
    "canonical_result", "design_parity_result", "aggressive_result",
    "grace_result", "nnn_gross_check_result",
])
def test_no_instant_flat_jump_at_a_year_seam(fixture_name, request):
    # The seam month (13, 25, 37, 49) must NOT equal the naive flat 1/12 average — it
    # sits partway through the glide from the prior year's exit toward the SOLVED
    # flat level (which generally differs from the naive average — see
    # _blend_then_flat's derivation).
    res = request.getfixturevalue(fixture_name)
    months = {m.index: m for m in res.monthly}
    for y in (2, 3, 4, 5):
        seam = 12 * (y - 1) + 1
        if seam not in months:
            continue
        flat_avg_net = D(str(res.annual[y].net)) / 12
        seam_net = D(str(months[seam].net))
        # A pure flat-jump design would land the seam month within a fraction of a
        # cent of the naive average; the glide instead starts near the PRIOR month.
        assert abs(seam_net - flat_avg_net) > Decimal("0.01"), (y, seam_net, flat_avg_net)


@pytest.mark.parametrize("fixture_name", [
    "canonical_result", "design_parity_result", "aggressive_result",
    "grace_result", "nnn_gross_check_result",
])
def test_no_month_over_month_drop_in_years_2_5_exceeds_the_old_seam_cliff(fixture_name, request):
    # CAUGHT IN REVIEW: an earlier version of this fix passed a test that only
    # checked the SEAM month, while a naive-average flat tail hid a SECOND, larger
    # cliff at the blend/flat boundary a few months later. Assert over EVERY
    # month-over-month step across the full Years 2-5 span (not just the seam): none
    # may exceed what the OLD instant flat-jump would have produced at that year's
    # own seam — the fix must never introduce a drop worse than the bug it replaces,
    # anywhere in the year, not just on day one.
    res = request.getfixturevalue(fixture_name)
    ops = [m for m in res.monthly if m.kind == "operating"]
    nets = [D(str(m.net)) for m in ops]
    old_seam_drops = []
    for y in (2, 3, 4, 5):
        seam_idx = 12 * (y - 1)  # 0-based index of the seam month among operating months
        if seam_idx <= 0 or seam_idx >= len(nets):
            continue
        old_flat_net = D(str(res.annual[y].net)) / 12
        old_seam_drops.append(max(Decimal("0"), nets[seam_idx - 1] - old_flat_net))
    if not old_seam_drops:
        return
    worst_old_drop = max(old_seam_drops)
    for i in range(len(nets) - 1):
        if 12 <= i < 48:  # scope to the Years 2-5 span this fix touches
            actual_drop = nets[i] - nets[i + 1]
            assert actual_drop <= worst_old_drop + Decimal("0.01"), (i, actual_drop, worst_old_drop)


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
    rev1, exp1, _ = _year_slices(aggressive_result.annual[1], 1)
    rev2, exp2, _ = _year_slices(
        aggressive_result.annual[2], 2, prev_rev_last=rev1[-1], prev_exp_last=exp1[-1],
    )
    rev3, exp3, _ = _year_slices(
        aggressive_result.annual[3], 3, prev_rev_last=rev2[-1], prev_exp_last=exp2[-1],
    )
    month25 = next(m for m in aggressive_result.monthly if m.index == 25)
    assert D(str(month25.revenue)) == rev3[0]
    assert D(str(month25.expenses)) == exp3[0]

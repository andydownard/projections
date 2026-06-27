"""RED first: monthly M0-M12 cash-flow (§5) + the penny-exact roll-up (§4.2/§13.4).

Year-1 annual P&L == sum of the 12 operating months, to the penny, for every line.
Cumulative cash, trough, and break-even month are derived from the monthly series.
"""
from decimal import Decimal

from engine.money import D


def test_twelve_operating_months(canonical_result):
    ops = [m for m in canonical_result.monthly if m.kind == "operating"]
    assert len(ops) == 12
    assert [m.index for m in ops] == list(range(1, 13))


def test_pre_open_month_present_when_pre_launch(canonical_result):
    # opening_status == "pre_launch" -> an M0 pre-open month exists.
    assert any(m.kind == "pre_open" for m in canonical_result.monthly)


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

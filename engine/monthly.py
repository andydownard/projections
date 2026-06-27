"""Monthly launch cash-flow model on a uniform pre-opening timeline (ENGINE_CONTRACT
§5 / Spec §6).

The timeline is project months ``1..N`` where ``opening_month_number`` (``G``) is a
milestone marker and ``N = G + 11`` (pre-opening + the 12 operating months). Months
``1..G-1`` are **pre-opening, first-class P&L months**: no operating revenue and no
operating expenses (the store is not open), so their P&L is exactly the scheduled
one-time costs landing that month (a real monthly loss). Months ``G..N`` carry the
12-month operating ramp **plus** any scheduled costs that land on them.

The model is monthly-first: the Year-1 annual totals are the *roll-up* of the 12
operating months, so the annual P&L and the monthly model can never disagree
(asserted to the penny by a golden test).

Implementation guarantee for the penny-exact roll-up: each Y1 annual line is
distributed across the 12 operating months by weights that sum to exactly 1, in
Decimal, with the **last operating month absorbing the rounding residual**. The
sum of monthly values is therefore bit-identical to the annual value.

Cash terms: cumulative cash starts at 0 and is decremented by timed one-time
startup outflows (which begin accumulating in pre-opening) on top of operating net,
so the trough reflects the real cash low point that sets the capital requirement.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from engine.money import D

# S-curve revenue ramp weights (relative; normalized internally). Calibration
# backlog (§12.5) — emitted with flags.ramp_low_confidence. Mirrors the prototype.
_REVENUE_WEIGHTS = [
    Decimal(w) for w in
    ("0.04", "0.05", "0.06", "0.065", "0.075", "0.085",
     "0.09", "0.095", "0.10", "0.105", "0.11", "0.125")
]
# Payroll ramps in earlier (hires precede full revenue).
_PAYROLL_WEIGHTS = [
    Decimal(w) for w in
    ("0.097", "0.095", "0.09", "0.086", "0.084", "0.08",
     "0.08", "0.079", "0.077", "0.077", "0.078", "0.077")
]


@dataclass
class MonthRow:
    index: int                 # project month number (1..N); G..N are operating
    kind: str                  # "pre_open" | "operating"
    revenue: Decimal
    expenses: Decimal          # operating expenses (excludes one-time startup)
    net: Decimal               # operating net = revenue - expenses
    startup_outflow: Decimal   # one-time cash outflow timed to this month
    cash_net: Decimal          # net - startup_outflow (the cash delta)
    cumulative_cash: Decimal


def _normalized(weights):
    total = sum(weights, Decimal("0"))
    return [w / total for w in weights]


def _distribute(total: Decimal, weights):
    """Split `total` across len(weights) buckets; last bucket absorbs residual."""
    norm = _normalized(weights)
    parts = [total * w for w in norm[:-1]]
    parts.append(total - sum(parts, Decimal("0")))
    return parts


def build_monthly(annual_y1, assumptions, opening_month_number, startup_by_month):
    """Return (rows, breakeven_month) over the project-month timeline 1..N.

    `annual_y1` is the AnnualYear for Year 1; the 12 operating months re-express it.
    `opening_month_number` (G) is the grand-opening milestone; ``N = G + 11``.
    `startup_by_month` maps a project-month int -> one-time outflow Decimal; the sum
    of its values is the total startup (placed by the schedule, never double-counted).

    `breakeven_month` is the first operating month (>= G) whose net >= 0 and stays
    non-negative thereafter, numbered in **project months** (None if never).

    The timeline runs to ``N = max(G + 11, last scheduled month)`` so a post-open
    support cost beyond the 12-month operating window is still placed on its month
    (the trough and startup total reconcile); those extra months carry the scheduled
    cost only — the operating ramp covers exactly the 12 months ``G..G+11``.
    """
    g = int(opening_month_number)
    # Grand opening is a project-month milestone >= 1 (Spec §5). A g <= 0 timeline has
    # no well-defined operating window and previously crashed the break-even loop with
    # an IndexError (-> HTTP 500); reject it cleanly as a ValueError (-> 422) so no
    # internal caller (seed, Penny tools, scenario re-runs) can take compute down (#184).
    if g < 1:
        raise ValueError("opening_month_number must be >= 1")
    last_scheduled = max(startup_by_month.keys(), default=0)
    n = max(g + 11, int(last_scheduled))

    total_rev = D(str(annual_y1.total_rev))
    total_exp = D(str(annual_y1.total_exp))

    # Split revenue by the S-curve; payroll by its own weights; everything else
    # (the remaining operating expense) tracks the revenue curve so variable-heavy
    # costs concentrate with revenue. Both sums equal the annual totals exactly.
    payroll_annual = D(str(annual_y1.expenses.get("Payroll", Decimal("0"))))
    other_exp_annual = total_exp - payroll_annual

    rev_parts = _distribute(total_rev, _REVENUE_WEIGHTS)
    payroll_parts = _distribute(payroll_annual, _PAYROLL_WEIGHTS)
    other_parts = _distribute(other_exp_annual, _REVENUE_WEIGHTS)

    rows = []
    cumulative = Decimal("0")
    op_nets = []  # operating-month nets, indexed 0..11 (project month = g + i)

    for month in range(1, n + 1):
        outflow = D(str(startup_by_month.get(month, Decimal("0"))))
        if month < g:
            # Pre-opening: a first-class P&L month with no operating activity; its
            # loss is exactly the scheduled costs landing this month.
            rev = Decimal("0")
            exp = Decimal("0")
            net = Decimal("0")
            kind = "pre_open"
        elif month <= g + 11:
            oi = month - g
            rev = rev_parts[oi]
            exp = payroll_parts[oi] + other_parts[oi]
            net = rev - exp
            op_nets.append(net)
            kind = "operating"
        else:
            # Beyond the 12-month operating ramp: the store is open but this month
            # carries only its scheduled cost (no modeled operating activity).
            rev = Decimal("0")
            exp = Decimal("0")
            net = Decimal("0")
            kind = "operating"
        cash_net = net - outflow
        cumulative += cash_net
        rows.append(MonthRow(
            index=month, kind=kind, revenue=rev, expenses=exp, net=net,
            startup_outflow=outflow, cash_net=cash_net, cumulative_cash=cumulative,
        ))

    # break-even month: first operating month with net>=0 that stays non-negative,
    # numbered in project months (g + offset). Iterate over the actual operating-net
    # count (always 12 for g>=1) rather than a hardcoded range(12) — defense in depth
    # so the loop can never index past op_nets (#184).
    breakeven = None
    for i in range(len(op_nets)):
        if op_nets[i] >= 0 and all(net_ >= 0 for net_ in op_nets[i:]):
            breakeven = g + i
            break

    return rows, breakeven

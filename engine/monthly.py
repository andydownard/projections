"""Monthly launch cash-flow model M0-M12 (ENGINE_CONTRACT §5).

The model is monthly-first: Year-1 annual totals are the *roll-up* of the 12
operating months, so the annual P&L and the monthly model can never disagree
(asserted to the penny by a golden test).

Implementation guarantee for the penny-exact roll-up: each Y1 annual line is
distributed across the 12 operating months by weights that sum to exactly 1, in
Decimal, with the **last operating month absorbing the rounding residual**. The
sum of monthly values is therefore bit-identical to the annual value.

Cash terms: cumulative cash starts at 0 and is decremented by timed one-time
startup outflows (pre-opening costs in M0/M1, the remaining build-out spread into
the opening month) on top of operating net, so the trough reflects the real cash
low point that sets the capital requirement.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

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
    index: int                 # 0 for pre-open, 1..12 for operating
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


def build_monthly(annual_y1, occupancy_y1, startup_total, assumptions, opening_status):
    """Return (rows, breakeven_month).

    `annual_y1` is the AnnualYear for Year 1; the monthly series re-expresses it.
    `breakeven_month` is the first operating month whose net >= 0 and stays
    non-negative thereafter (None if never within the 12 months).
    """
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

    # Timed one-time startup outflow: model it as fully spent before/at opening.
    # Place the entire startup_total at the pre-open month (M0) when pre_launch,
    # else at the first operating month. This sets the cash trough deterministically.
    rows = []
    cumulative = Decimal("0")

    pre_launch = opening_status == "pre_launch"
    if pre_launch:
        cumulative -= D(str(startup_total))
        rows.append(MonthRow(
            index=0, kind="pre_open", revenue=Decimal("0"), expenses=Decimal("0"),
            net=Decimal("0"), startup_outflow=D(str(startup_total)),
            cash_net=-D(str(startup_total)), cumulative_cash=cumulative,
        ))

    breakeven = None
    op_nets = []
    for i in range(12):
        rev = rev_parts[i]
        exp = payroll_parts[i] + other_parts[i]
        net = rev - exp
        op_nets.append(net)
        startup_outflow = Decimal("0")
        if not pre_launch and i == 0:
            startup_outflow = D(str(startup_total))
        cash_net = net - startup_outflow
        cumulative += cash_net
        rows.append(MonthRow(
            index=i + 1, kind="operating", revenue=rev, expenses=exp, net=net,
            startup_outflow=startup_outflow, cash_net=cash_net,
            cumulative_cash=cumulative,
        ))

    # break-even month: first month with net>=0 that stays non-negative.
    for i in range(12):
        if op_nets[i] >= 0 and all(n >= 0 for n in op_nets[i:]):
            breakeven = i + 1
            break

    return rows, breakeven

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
from decimal import ROUND_HALF_UP, Decimal

from engine.money import D

_CENT = Decimal("0.01")

# S-curve revenue ramp weights (relative; normalized internally). Calibration
# backlog (§12.5) — emitted with flags.ramp_low_confidence. Mirrors the prototype.
_REVENUE_WEIGHTS = [
    Decimal(w) for w in
    ("0.04", "0.05", "0.06", "0.065", "0.075", "0.085",
     "0.09", "0.095", "0.10", "0.105", "0.11", "0.125")
]
# Payroll ramps in earlier (hires precede full revenue). Payroll taxes ride this
# same ramp (they are a fixed % OF payroll, so they track payroll, not revenue).
_PAYROLL_WEIGHTS = [
    Decimal(w) for w in
    ("0.097", "0.095", "0.09", "0.086", "0.084", "0.08",
     "0.08", "0.079", "0.077", "0.077", "0.078", "0.077")
]
# The only expense lines that scale with revenue month-to-month (ENGINE_CONTRACT §5.2).
# Payroll/Payroll taxes are deliberately EXCLUDED (payroll ramp); everything else is
# fixed. Classifying by label keeps the streams honest as new lines are added.
_PCT_OF_REVENUE_LABELS = frozenset({
    "Credit card fees",
    "Marketing & outreach",
    "Supplies & processing",
})


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


def _flat_monthly(total: Decimal, months: int = 12):
    """Spread `total` FLAT across `months` operating months, to the cent, with the
    last month absorbing the residual (penny-exact: the parts sum to exactly `total`).

    Fixed annual lines (rent, utilities, insurance, …) are lease/contract obligations
    paid in equal monthly installments — flat, NOT revenue-weighted. Quantizing each
    equal installment to the cent (rather than the non-terminating full-precision
    1/12) keeps every monthly value low-precision, so the combined monthly expense and
    net still roll up to the annual totals EXACTLY at the 28-digit Decimal precision
    (Regression #15) — a full-precision 1/12 stream overflows that precision when the
    12 combined months are re-summed and drifts the roll-up by ~1e-22."""
    each = (total / months).quantize(_CENT, rounding=ROUND_HALF_UP)
    parts = [each] * (months - 1)
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

    # Three expense streams (ENGINE_CONTRACT §5.2), each distributed by its own weights:
    #  - %-of-revenue lines (card fees, marketing, supplies) ride the revenue S-curve;
    #  - Payroll AND Payroll taxes ride the payroll hire-ramp (payroll taxes are a fixed
    #    % OF payroll, so they track payroll month-to-month, never the revenue curve);
    #  - every other (fixed annual) line — Rent, Utilities/trash, FIXED_ANNUAL — is a
    #    lease/contract obligation that does not ramp, so it spreads FLAT.
    # ``fixed`` is the residual (total_exp minus the two classified streams) so a newly
    # added expense label is treated as fixed by default, never silently dropped.
    exp_by_label = annual_y1.expenses
    pct_annual = sum((D(str(v)) for k, v in exp_by_label.items()
                      if k in _PCT_OF_REVENUE_LABELS), Decimal("0"))
    payroll_annual = sum((D(str(exp_by_label.get(k, Decimal("0"))))
                          for k in ("Payroll", "Payroll taxes")), Decimal("0"))
    fixed_annual = total_exp - pct_annual - payroll_annual

    rev_parts = _distribute(total_rev, _REVENUE_WEIGHTS)
    pct_parts = _distribute(pct_annual, _REVENUE_WEIGHTS)
    payroll_parts = _distribute(payroll_annual, _PAYROLL_WEIGHTS)
    fixed_parts = _flat_monthly(fixed_annual)

    # Combined operating expense per month. Every stream is penny-exact and low-
    # precision, so the 12 combined months roll up to total_exp (and, with rev_parts,
    # to net) EXACTLY at the 28-digit Decimal precision (Regression #15) — no residual
    # correction needed.
    exp_parts = [pct_parts[i] + payroll_parts[i] + fixed_parts[i] for i in range(12)]

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
            exp = exp_parts[oi]
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

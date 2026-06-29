"""Monthly launch cash-flow model on a uniform pre-opening timeline (ENGINE_CONTRACT
§5 / Spec §6).

The timeline is project months ``1..N`` where ``opening_month_number`` (``G``) is a
milestone marker and ``N = G + 59`` (pre-opening + the **60 operating months** of the
full 5-year horizon). Months ``1..G-1`` are **pre-opening, first-class P&L months**: no
operating revenue and no operating expenses (the store is not open), so their P&L is
exactly the scheduled one-time costs landing that month (a real monthly loss). Months
``G..N`` carry the operating ramp **plus** any scheduled costs that land on them.

Operating months map to years: offset ``oi = month - G`` (0..59) -> year ``oi // 12 +
1`` (1..5), within-year slice ``oi % 12``. Year 1 keeps the launch **S-curve** weights
byte-for-byte; Years 2-5 use a uniform (1/12) intra-year split (steady state, not a
seasonality claim) — the intra-year shape for Years 2-5 affects only the EXACT payback
month by a few positions, never the annual totals, capital, break-even, or cash gap.

The model is monthly-first: for EVERY year, the annual totals are the *roll-up* of that
year's 12 operating months, so the annual P&L and the monthly model can never disagree
(asserted to the penny by a golden test). Each annual line is distributed across the 12
months by weights that sum to exactly 1, in Decimal, with the **last month absorbing the
rounding residual**, so the sum of monthly values is bit-identical to the annual value.

The 60-month horizon exists so PAYBACK (the first project-month where cumulative cash
returns to >= 0 after going negative) can resolve across years. The Year-1-anchored
metrics (capital, break-even, first-year cash gap) are scoped to the Year-1 window in
``engine.decision`` and are therefore byte-unchanged by the extension.

Cash terms: cumulative cash starts at 0 and is decremented by timed one-time startup
outflows (which begin accumulating in pre-opening) on top of operating net, so the
trough reflects the real cash low point that sets the capital requirement.
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


# Steady-state intra-year split for Years 2-5: uniform 1/12 (the launch S-curve is a
# Year-1 ramp only). Same `_distribute` path, last bucket absorbs the residual.
_UNIFORM_WEIGHTS = [Decimal("1")] * 12


def _year_slices(annual_year, year):
    """The 12 monthly (revenue, operating-expense, net) slices for one annual year.

    Every line's slices sum to that year's annual line to the penny (residual in the last
    bucket), so the per-year roll-up is exact in Decimal (Regression #15, now per year):
    revenue, operating expense, AND net each foot exactly, with ``net == revenue −
    expense`` holding month-by-month too (the xlsx Net column = B − C − D).

    Year 1 keeps the launch S-curve byte-for-byte: revenue + other expense on
    ``_REVENUE_WEIGHTS``, payroll on ``_PAYROLL_WEIGHTS``, ``net = revenue − expense`` per
    month. (Its per-element subtraction rolls up exactly for these weights — locked by the
    existing Year-1 roll-up tests + the golden fixtures, so it must not change.)

    Years 2-5 (steady state) distribute revenue AND operating expense independently on
    uniform 1/12 weights (each foots exactly via the last-bucket residual), then take
    ``net = revenue − expense`` for the first 11 months and let the 12th month absorb the
    net residual (``net[11] = annual_net − Σnet[:11]``). The uniform 1/12 weight is a
    non-terminating Decimal, so two independently-rounded splits would otherwise leave a
    ~1e-22 residual in the per-element ``net = rev − exp`` sum; absorbing it keeps ALL
    THREE lines footing EXACTLY. The 12th month's stored net then differs from its
    ``rev − exp`` by ~1e-22 — far below any tolerance, and the xlsx Net column recomputes
    it as ``=B−C−D`` anyway, so the workbook and the engine still reconcile.
    (Year 1's weight vectors sum to exactly 1.0, so its parts are exact finite decimals
    and ``net = rev − exp`` foots without any residual — that path is unchanged.)
    """
    total_rev = D(str(annual_year.total_rev))
    if year == 1:
        total_exp = D(str(annual_year.total_exp))
        payroll_annual = D(str(annual_year.expenses.get("Payroll", Decimal("0"))))
        other_exp_annual = total_exp - payroll_annual
        rev_parts = _distribute(total_rev, _REVENUE_WEIGHTS)
        payroll_parts = _distribute(payroll_annual, _PAYROLL_WEIGHTS)
        other_parts = _distribute(other_exp_annual, _REVENUE_WEIGHTS)
        exp_parts = [payroll_parts[i] + other_parts[i] for i in range(12)]
        net_parts = [rev_parts[i] - exp_parts[i] for i in range(12)]
        return rev_parts, exp_parts, net_parts
    total_exp = D(str(annual_year.total_exp))
    net_annual = D(str(annual_year.net))
    rev_parts = _distribute(total_rev, _UNIFORM_WEIGHTS)
    exp_parts = _distribute(total_exp, _UNIFORM_WEIGHTS)
    net_parts = [rev_parts[i] - exp_parts[i] for i in range(11)]
    net_parts.append(net_annual - sum(net_parts, Decimal("0")))
    return rev_parts, exp_parts, net_parts


def build_monthly(annual, assumptions, opening_month_number, startup_by_month):
    """Return (rows, breakeven_month) over the project-month timeline 1..N.

    `annual` is the full ``{1..5}`` AnnualYear dict; the 60 operating months re-express
    each year's P&L (Year 1 = the launch S-curve, Years 2-5 = a uniform intra-year
    split). `opening_month_number` (G) is the grand-opening milestone; ``N = G + 59``.
    `startup_by_month` maps a project-month int -> one-time outflow Decimal; the sum of
    its values is the total startup (placed by the schedule, never double-counted).

    `breakeven_month` is the first **Year-1** operating month (>= G) whose net >= 0 and
    stays non-negative through the Year-1 ramp, numbered in **project months** (None if
    never). It is computed over the Year-1 operating window ONLY, so it is byte-identical
    to the 12-month model and is unaffected by a later-year operating dip.

    The timeline runs to ``N = max(G + 59, last scheduled month)`` so a support cost
    beyond the 60-month operating window is still placed on its month (the trough and
    startup total reconcile); those extra months carry the scheduled cost only — the
    operating ramp covers exactly the 60 months ``G..G+59``.
    """
    g = int(opening_month_number)
    # Grand opening is a project-month milestone >= 1 (Spec §5). A g <= 0 timeline has
    # no well-defined operating window and previously crashed the break-even loop with
    # an IndexError (-> HTTP 500); reject it cleanly as a ValueError (-> 422) so no
    # internal caller (seed, Penny tools, scenario re-runs) can take compute down (#184).
    if g < 1:
        raise ValueError("opening_month_number must be >= 1")
    last_scheduled = max(startup_by_month.keys(), default=0)
    n = max(g + 59, int(last_scheduled))

    # Per-year monthly slices (Year 1 S-curve byte-identical; Years 2-5 uniform).
    slices = {y: _year_slices(annual[y], y) for y in (1, 2, 3, 4, 5)}

    rows = []
    cumulative = Decimal("0")
    y1_op_nets = []  # Year-1 operating nets (for break-even; byte-identical to today)

    for month in range(1, n + 1):
        outflow = D(str(startup_by_month.get(month, Decimal("0"))))
        if month < g:
            # Pre-opening: a first-class P&L month with no operating activity; its
            # loss is exactly the scheduled costs landing this month.
            rev = Decimal("0")
            exp = Decimal("0")
            net = Decimal("0")
            kind = "pre_open"
        elif month <= g + 59:
            oi = month - g          # 0..59
            y = oi // 12 + 1        # 1..5
            wi = oi % 12            # 0..11
            rev_parts, exp_parts, net_parts = slices[y]
            rev = rev_parts[wi]
            exp = exp_parts[wi]
            net = net_parts[wi]
            kind = "operating"
            if y == 1:
                y1_op_nets.append(net)
        else:
            # Beyond the 60-month operating ramp: the store is open but this month
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

    # break-even month: first Year-1 operating month with net>=0 that stays non-negative
    # through the Year-1 ramp, numbered in project months (g + offset). Scoped to the
    # Year-1 window so a later-year operating dip can never erase a real Year-1 break-even
    # (and so the metric is byte-identical to the pre-60-month model).
    breakeven = None
    for i in range(len(y1_op_nets)):
        if y1_op_nets[i] >= 0 and all(net_ >= 0 for net_ in y1_op_nets[i:]):
            breakeven = g + i
            break

    return rows, breakeven

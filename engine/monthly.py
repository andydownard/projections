"""Monthly launch cash-flow model on a uniform pre-opening timeline (ENGINE_CONTRACT
§5 / Spec §6).

The timeline is project months ``1..N`` where ``opening_month_number`` (``G``) is a
milestone marker and ``N = G + 59`` (pre-opening + the **60 operating months** of the
full 5-year horizon). Months ``1..G-1`` are **pre-opening, first-class P&L months**: no
operating revenue and no operating expenses (the store is not open), so their P&L is
exactly the scheduled one-time costs landing that month (a real monthly loss). Months
``G..N`` carry the operating ramp **plus** any scheduled costs that land on them.

Operating months map to years: offset ``oi = month - G`` (0..59) -> year ``oi // 12 +
1`` (1..5), within-year slice ``oi % 12``. Year 1 starts from the launch **S-curve**
weights; Years 2-5 GLIDE from the prior year's own last month toward that year's
flat steady-state average over `_BLEND_MONTHS` months, then hold flat (owner defect
fix, 2026-07-05 — an instant flat-jump at the Year N -> N+1 seam read as an
unexplained one-month cliff on the chart) — the intra-year shape for Years 2-5 affects
only the EXACT payback month by a few positions, never the annual totals. From 3.1.0
(owner 2026-10-08) every year's shape is also EASED toward its own flat average just
enough that monthly Net and Revenue never drop while the annual totals grow (see
`_ease_weight`); that flattens Year 1 and so DOES move capital and break-even.

The model is monthly-first: for EVERY year, the annual totals are the *roll-up* of that
year's 12 operating months, so the annual P&L and the monthly model can never disagree
(asserted to the penny by a golden test). Each annual line is distributed across the 12
months by weights that sum to exactly 1, in Decimal, with the **last month absorbing the
rounding residual**, so the sum of monthly values is bit-identical to the annual value.

The 60-month horizon lets PAYBACK (the first project-month where cumulative cash
returns to >= 0 after going negative) resolve across years. Since 3.1.0 (owner
decision 2026-10-08, "Full 60 months") break-even and capital also read the whole
series; only the first-year cash gap stays scoped to the Year-1 window
(``engine.decision``).

Cash terms: cumulative cash starts at 0 and is decremented by timed one-time startup
outflows (which begin accumulating in pre-opening) on top of operating net, so the
trough reflects the real cash low point that sets the capital requirement.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal

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
    stations_staffed: Decimal  # production-station headcount this month (Task 1.2)


def _normalized(weights):
    total = sum(weights, Decimal("0"))
    return [w / total for w in weights]


def _distribute(total: Decimal, weights):
    """Split `total` across len(weights) buckets; last bucket absorbs residual."""
    norm = _normalized(weights)
    parts = [total * w for w in norm[:-1]]
    parts.append(total - sum(parts, Decimal("0")))
    return parts


def _linear_share_weights(share_m1: Decimal, share_m12: Decimal):
    """12 relative monthly weights linearly interpolated share_m1 -> share_m12.

    An optional alternative to the S-curve (`_REVENUE_WEIGHTS`) for Year-1 revenue
    (Task 1.3). Not required to sum to 1 — `_distribute`/`_normalized` renormalize
    internally, exactly as the fixed `_REVENUE_WEIGHTS` literal is normalized today.
    """
    return [share_m1 + (share_m12 - share_m1) * Decimal(m - 1) / Decimal(11)
            for m in range(1, 13)]


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


# Owner defect fix (2026-07-05): "net should never fall month-over-month unless a
# startup expense forces it" — the Year1->Year2 seam (and every later year boundary)
# used to jump INSTANTLY from Year N's S-curve/ramp exit rate to Year N+1's flat
# annual average, an artificial one-month cliff with no cost event behind it. The glide
# below removes the INSTANT jump; the 3.1.0 ease (`_ease_weight`, further down) then
# removes the remaining dip by keeping each year's exit at or below the next year's
# monthly average. Years 2-5 now GLIDE from
# the prior year's actual exit value over `_BLEND_MONTHS` months into a flat level
# held for the rest of the year, instead of snapping straight to the flat average in
# month one -- one smooth arithmetic progression, no second jump at the blend/flat
# boundary (see `_blend_then_flat`'s derivation of that flat level).
_BLEND_MONTHS = 3


def _blend_then_flat(total: Decimal, prev_last: Decimal, months: int = 12,
                      blend: int = _BLEND_MONTHS):
    """Distribute `total` across `months` as a `blend`-month linear glide from
    `prev_last` (the prior year's own last month) into a flat level `f` held for the
    remaining months — NOT the naive `total/months` average (that undercounts/
    overcounts what the glide months already delivered relative to a pure flat year,
    which left a hidden secondary cliff at the blend/flat boundary — caught in review).
    `f` is solved directly from the footing equation so the WHOLE vector, glide months
    included, sums to `total` exactly:
        Σ_{i=1..blend} [prev_last + i/(blend+1)*(f−prev_last)] + (months−blend)*f = total
        => f = (total − blend*prev_last/2) / (months − blend/2)
    A pleasant consequence: the step from the last blend month to `f` works out to
    exactly the SAME increment as every blend step (algebra: f − [prev_last +
    blend/(blend+1)*(f−prev_last)] = (f−prev_last)/(blend+1), identical to each blend
    step's own increment) — so `prev_last, step_1, .., step_blend, f, f, ..` is one
    single, perfectly smooth arithmetic progression into the flat tail, not a glide
    followed by a second jump. Feet to `total` exactly regardless of `blend`/`months`/
    `prev_last` (Regression #15) — the last bucket absorbs the Decimal rounding
    residual.
    """
    blend = min(blend, months)
    denom = Decimal(months) - Decimal(blend) / 2
    f = (total - Decimal(blend) * prev_last / 2) / denom
    parts = []
    for i in range(blend):
        frac = Decimal(i + 1) / Decimal(blend + 1)
        parts.append(prev_last + frac * (f - prev_last))
    remaining_months = months - blend
    if remaining_months > 0:
        parts.extend([f] * (remaining_months - 1))
        parts.append(total - sum(parts, Decimal("0")))
    else:
        parts[-1] = parts[-1] + (total - sum(parts, Decimal("0")))
    return parts


# Owner request (2026-10-08, model 3.1.0): "net income or revenue should only go up —
# no dip after Year 1." A rising path is only possible if each year's LAST month is no
# higher than the NEXT year's monthly average (the next year has to start at or above
# it and still sum to its own total). Year 1's S-curve, and the front-loaded payroll
# ramp, exit well above Year 2's average, so each year's shape is eased toward its own
# flat average by the smallest amount that brings its exit under that cap. The ease is
# a blend of two rising series (the year's own shape and a flat line), so the result
# still rises and still sums to the annual total. When the next year FALLS, no rising
# path exists; the shape is left alone and the dip is honest.
_EASE_STEP = Decimal("0.000001")


def _ease_weight(parts, total: Decimal, cap):
    """Share (0..1) of `parts`' own shape to keep so the eased last month is <= `cap`.

    1 means untouched: no cap (Year 5), the exit already fits, or the next year falls
    (`cap` below this year's own average). Rounded DOWN so the eased exit never
    overshoots the cap by a rounding hair.
    """
    if cap is None:
        return Decimal("1")
    avg = total / len(parts)
    last = parts[-1]
    if last <= cap or cap < avg:
        return Decimal("1")
    return ((cap - avg) / (last - avg)).quantize(_EASE_STEP, rounding=ROUND_DOWN)


def _ease(parts, total: Decimal, weight: Decimal, months: int = 12):
    """Blend `parts` toward the flat average: ``weight*part + (1-weight)*total/months``.

    The last month absorbs the Decimal residual, so the result sums to `total` exactly
    (Regression #15).
    """
    if weight == 1:
        return list(parts)
    avg = total / months
    out = [weight * parts[i] + (1 - weight) * avg for i in range(months - 1)]
    out.append(total - sum(out, Decimal("0")))
    return out


def _year_slices(annual_year, year, *, prev_rev_last=None, prev_net_last=None,
                 next_year=None, revenue_weights=None):
    """The 12 monthly (revenue, operating-expense, net) slices for one annual year.

    Every line's slices sum to that year's annual line to the penny (residual in the last
    bucket), so the per-year roll-up is exact in Decimal (Regression #15, per year):
    revenue, operating expense, AND net each foot exactly, with ``net == revenue −
    expense`` holding month-by-month too (the xlsx Net column = B − C − D).

    **Year 1 (FUSION) uses the 6.2 three-stream split** (ENGINE_CONTRACT §5.2), each
    stream distributed by its OWN weights so the launch cash-flow shape is honest and the
    Year-1 trough (→ capital / break-even) reflects it:
      - %-of-revenue lines (card fees, marketing, supplies) ride the revenue S-curve
        (``_REVENUE_WEIGHTS``) by default, or the caller-supplied ``revenue_weights``
        (Task 1.3's optional linear ``share_m1``->``share_m12`` ramp) when given — the
        %-of-revenue lines and revenue itself always ride the SAME curve, whichever it
        is, so the "expenses are a fixed % of revenue" invariant holds intra-year;
      - Payroll AND Payroll taxes ride the payroll hire-ramp (``_PAYROLL_WEIGHTS``) —
        payroll taxes are a fixed % OF payroll, so they track payroll, not revenue;
      - every other (fixed annual) line — Rent, Utilities/trash, FIXED_ANNUAL — is a
        lease/contract obligation that does not ramp, so it spreads FLAT (``_flat_monthly``).
    ``fixed`` is the residual (``total_exp`` minus the two classified streams) so a newly
    added expense label is treated as fixed by default, never silently dropped. Every
    stream is penny-exact and low-precision, so the 12 combined months roll up to
    ``total_exp`` (and, with ``rev_parts``, to net) EXACTLY at 28-digit Decimal precision
    (Regression #15) — no residual correction needed; ``net = rev − exp`` per month.

    Years 2-5 (owner defect fix, 2026-07-05) distribute revenue AND operating expense
    independently on a `_BLEND_MONTHS`-month GLIDE from the prior year's own last month
    toward the new flat steady-state average, then flat for the rest of the year
    (``_blend_then_flat``, replacing the old INSTANT flat-jump — each foots exactly via
    its own remaining-months residual), then take ``net = revenue − expense`` for the
    first 11 months and let the 12th month absorb the net residual (``net[11] =
    annual_net − Σnet[:11]``). Two independently-rounded splits leave a ~1e-22 residual
    in the per-element ``net = rev − exp`` sum; absorbing it keeps ALL THREE lines
    footing EXACTLY. The 12th month's stored net then differs from its ``rev − exp`` by
    ~1e-22 — far below any tolerance, and the xlsx Net column recomputes it as
    ``=B−C−D`` anyway, so the workbook and the engine still reconcile.
    """
    total_rev = D(str(annual_year.total_rev))
    total_exp = D(str(annual_year.total_exp))
    net_annual = D(str(annual_year.net))
    # Caps for the ease: the next year's monthly averages (None for Year 5).
    rev_cap = D(str(next_year.total_rev)) / 12 if next_year is not None else None
    net_cap = D(str(next_year.net)) / 12 if next_year is not None else None
    if year == 1:
        exp_by_label = annual_year.expenses
        pct_annual = sum((D(str(v)) for k, v in exp_by_label.items()
                          if k in _PCT_OF_REVENUE_LABELS), Decimal("0"))
        payroll_keys = ("Payroll", "Payroll taxes", "Workers' comp expense")
        payroll_annual = sum((D(str(exp_by_label.get(k, Decimal("0"))))
                              for k in payroll_keys), Decimal("0"))
        fixed_annual = total_exp - pct_annual - payroll_annual
        weights = revenue_weights if revenue_weights is not None else _REVENUE_WEIGHTS
        rev_parts = _distribute(total_rev, weights)
        pct_parts = _distribute(pct_annual, weights)
        payroll_parts = _distribute(payroll_annual, _PAYROLL_WEIGHTS)
        fixed_parts = _flat_monthly(fixed_annual)
        exp_parts = [pct_parts[i] + payroll_parts[i] + fixed_parts[i] for i in range(12)]
        net_parts = [rev_parts[i] - exp_parts[i] for i in range(12)]
        # ONE weight for the whole year, so revenue and expense ease together and the
        # eased net is exactly the same blend of the three-stream net.
        weight = min(_ease_weight(rev_parts, total_rev, rev_cap),
                     _ease_weight(net_parts, net_annual, net_cap))
        if weight == 1:
            return rev_parts, exp_parts, net_parts
        rev_parts = _ease(rev_parts, total_rev, weight)
        exp_parts = _ease(exp_parts, total_exp, weight)
    else:
        # Years 2-5: revenue and net each glide from the prior year's own last month
        # (`_blend_then_flat`), eased under the next year's cap; expense is what is
        # left (revenue - net), footed to the annual total in the last month.
        rev_parts = _blend_then_flat(total_rev, prev_rev_last)
        rev_parts = _ease(rev_parts, total_rev,
                          _ease_weight(rev_parts, total_rev, rev_cap))
        shaped_net = _blend_then_flat(net_annual, prev_net_last)
        shaped_net = _ease(shaped_net, net_annual,
                           _ease_weight(shaped_net, net_annual, net_cap))
        exp_parts = [rev_parts[i] - shaped_net[i] for i in range(11)]
        exp_parts.append(total_exp - sum(exp_parts, Decimal("0")))
    # Two independently footed splits leave a ~1e-22 residual in the per-month
    # ``rev - exp`` sum; the 12th month's net absorbs it so all three lines foot
    # EXACTLY (the xlsx Net column recomputes ``=B-C-D`` anyway).
    net_parts = [rev_parts[i] - exp_parts[i] for i in range(11)]
    net_parts.append(net_annual - sum(net_parts, Decimal("0")))
    return rev_parts, exp_parts, net_parts


def build_monthly(annual, assumptions, inputs, startup_by_month):
    """Return (rows, breakeven_month) over the project-month timeline 1..N.

    `annual` is the full ``{1..5}`` AnnualYear dict; the 60 operating months re-express
    each year's P&L (Year 1 = the launch S-curve, unchanged; Years 2-5 = a short glide
    from the prior year's own last month into the new flat steady-state, replacing an
    instant flat-jump at the seam — owner defect fix, 2026-07-05). `inputs.
    opening_month_number` (G) is the grand-opening milestone; ``N = G + 59``. `inputs`
    (not just the bare int, since Task 1.3) also carries the optional Year-1 linear
    revenue-share ramp (`share_m1`/`share_m12`) — both `None` (the default) reproduces
    today's S-curve byte-identically.
    `startup_by_month` maps a project-month int -> one-time outflow Decimal; the sum of
    its values is the total startup (placed by the schedule, never double-counted).

    `breakeven_month` is the first operating month (G..G+59) whose net >= 0 and stays
    non-negative through the end of the 60 operating months, numbered in **project
    months** (None if never, including when net slips back below zero later).

    The timeline runs to ``N = max(G + 59, last scheduled month)`` so a support cost
    beyond the 60-month operating window is still placed on its month (the trough and
    startup total reconcile); those extra months carry the scheduled cost only — the
    operating ramp covers exactly the 60 months ``G..G+59``.
    """
    g = int(inputs.opening_month_number)
    # Grand opening is a project-month milestone >= 1 (Spec §5). A g <= 0 timeline has
    # no well-defined operating window and previously crashed the break-even loop with
    # an IndexError (-> HTTP 500); reject it cleanly as a ValueError (-> 422) so no
    # internal caller (seed, Penny tools, scenario re-runs) can take compute down (#184).
    if g < 1:
        raise ValueError("opening_month_number must be >= 1")
    last_scheduled = max(startup_by_month.keys(), default=0)
    n = max(g + 59, int(last_scheduled))

    # Hoisted once (not per-month) — the production-station module (Task 1.2) rescales
    # monthly revenue back to monthly retail via the SAME constant salvage_pct that
    # holds for every year (total_rev = retail*(1+salv_pct) always), so
    # retail_month = revenue_month / (1+salv_pct) is an exact linear rescale of the
    # already footing-exact revenue split — no new distribution function needed.
    salv_pct = D(assumptions.salvage_pct)

    # Task 1.3: an optional linear alternative to the S-curve for Year-1 revenue (and
    # the %-of-revenue expense lines that ride the same curve). Both share_m1/share_m12
    # must be set to activate it; either None (the default) leaves revenue_weights=None,
    # so `_year_slices` falls back to `_REVENUE_WEIGHTS` unchanged.
    revenue_weights = (
        _linear_share_weights(D(inputs.share_m1), D(inputs.share_m12))
        if inputs.share_m1 is not None and inputs.share_m12 is not None else None
    )

    # Per-year monthly slices, computed SEQUENTIALLY so each of Years 2-5 can anchor
    # its glide on the prior year's own last month (Year 1 = the unchanged 6.2
    # three-stream split).
    slices = {1: _year_slices(annual[1], 1, next_year=annual[2],
                              revenue_weights=revenue_weights)}
    for y in (2, 3, 4, 5):
        prev_rev_last, prev_net_last = slices[y - 1][0][-1], slices[y - 1][2][-1]
        slices[y] = _year_slices(
            annual[y], y, prev_rev_last=prev_rev_last, prev_net_last=prev_net_last,
            next_year=annual.get(y + 1),
        )

    rows = []
    cumulative = Decimal("0")
    op_nets = []  # (project month, net) for the 60 operating months (break-even)

    for month in range(1, n + 1):
        outflow = D(str(startup_by_month.get(month, Decimal("0"))))
        if month < g:
            # Pre-opening: a first-class P&L month with no operating activity; its
            # loss is exactly the scheduled costs landing this month.
            rev = Decimal("0")
            exp = Decimal("0")
            net = Decimal("0")
            kind = "pre_open"
            stations_staffed = Decimal("0")
        elif month <= g + 59:
            oi = month - g          # 0..59
            y = oi // 12 + 1        # 1..5
            wi = oi % 12            # 0..11
            rev_parts, exp_parts, net_parts = slices[y]
            rev = rev_parts[wi]
            exp = exp_parts[wi]
            net = net_parts[wi]
            kind = "operating"
            op_nets.append((month, net))
            # Production-station module (Task 1.2): rescale this month's revenue
            # back to retail, then down the items-sold -> items-produced ->
            # production-hours -> stations-staffed chain, each zero-guarded.
            retail_m = (rev / (Decimal("1") + salv_pct)
                       if (Decimal("1") + salv_pct) != 0 else Decimal("0"))
            items_sold_m = (retail_m / D(assumptions.avg_item_price)
                            if D(assumptions.avg_item_price) != 0 else Decimal("0"))
            items_produced_m = (items_sold_m / D(assumptions.sell_through)
                                if D(assumptions.sell_through) != 0 else Decimal("0"))
            production_hours_m = (items_produced_m / D(assumptions.items_per_hour)
                                  if D(assumptions.items_per_hour) != 0 else Decimal("0"))
            stations_staffed = (
                production_hours_m / D(assumptions.productive_hours_per_station)
                if D(assumptions.productive_hours_per_station) != 0 else Decimal("0"))
        else:
            # Beyond the 60-month operating ramp: the store is open but this month
            # carries only its scheduled cost (no modeled operating activity).
            rev = Decimal("0")
            exp = Decimal("0")
            net = Decimal("0")
            kind = "operating"
            stations_staffed = Decimal("0")
        cash_net = net - outflow
        cumulative += cash_net
        rows.append(MonthRow(
            index=month, kind=kind, revenue=rev, expenses=exp, net=net,
            startup_outflow=outflow, cash_net=cash_net, cumulative_cash=cumulative,
            stations_staffed=stations_staffed,
        ))

    # break-even month (owner decision 2026-10-08, "Full 60 months"): the first
    # operating month whose net >= 0 AND stays >= 0 through the end of the 60-month
    # horizon, numbered in project months. With monthly net rising (3.1.0), a store that
    # turns profitable in Year 2-5 gets a real month; one that slips back into losses
    # later (e.g. a year whose total falls) is not "broken even".
    breakeven = None
    for i, (month_i, net_i) in enumerate(op_nets):
        if net_i >= 0 and all(net_ >= 0 for _, net_ in op_nets[i:]):
            breakeven = month_i
            break

    return rows, breakeven

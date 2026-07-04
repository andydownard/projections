"""Decision metrics, guardrails & recommendation (ENGINE_CONTRACT §6).

All computed in the core; all asserted by golden tests (not merely rendered).
Capital required = |peak cash shortfall| + reserve buffer. The monthly trough
already embeds the M0 startup outflow, so startup is NEVER added a second time.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from engine import model
from engine.money import D


@dataclass
class Decision:
    first_year_cash_gap: Decimal
    peak_cash_shortfall: Decimal
    startup_capital_required: Decimal
    cash_runway_months: int | None
    break_even_month: int | None
    break_even_revenue_annual: Decimal | None
    simple_payback_years: Decimal | None
    revenue_cagr: Decimal | None
    reco_tag: str
    reco_reasons: dict = field(default_factory=dict)
    sensitivity: dict = field(default_factory=dict)
    # Three milestones on the project-month timeline (Spec §8), all in project
    # months: grand_opening_month is the input G (always known); break_even_month is
    # the first sustained operating net >= 0; payback_month is the first month whose
    # cumulative operating profit since opening >= total startup (None when unreached
    # within the horizon — surfaced as N/A-with-reason in `flags`, never a 0).
    grand_opening_month: int = 1
    payback_month: int | None = None


def _scenario_net(inputs, assumptions, demand, trade, overrides, rent_mult, donation_mult):
    """Full re-run of the core with perturbed rent & donations -> (net, breakeven, capital).

    The rent stress (``rent_mult``) is applied to the **resolved** occupancy — the
    full annual rent the model actually charges, whether it was entered as an
    explicit ``occupancy_annual``, derived from ``rent_per_sqft × building_sqft``, or
    carries an ``nnn`` opex add-on. Pre-#181 the multiplier was applied ONLY to
    ``occupancy_annual`` (and never to ``nnn_opex``), so a ``rent_per_sqft``/``nnn``
    projection silently skipped the +25% rent shock — making the downside artificially
    rosier and flipping the go/no-go verdict on identical economics. Resolving to one
    quantity here makes the stress encoding-independent by construction (§6.2).
    """
    from engine.compute import (
        Inputs,
        _occupancy_y1,
        compute_annual,
        startup_outflows_by_month,
    )
    from engine.monthly import build_monthly

    # Resolve the full annual rent (incl. nnn opex), stress it, then collapse it back
    # into a single explicit ``occupancy_annual`` so compute() can't re-diverge by
    # encoding: clear rent_per_sqft and zero the (now folded-in) nnn opex.
    stressed_occ = _occupancy_y1(inputs) * D(str(rent_mult))
    # perturb shares (proxy for donations) and the resolved rent.
    new_inputs = Inputs(
        **{**inputs.__dict__,
           "share_y1": str(D(inputs.share_y1) * D(str(donation_mult))),
           "share_y2": str(D(inputs.share_y2) * D(str(donation_mult))),
           "share_y3": str(D(inputs.share_y3) * D(str(donation_mult))),
           "share_y4": str(D(inputs.share_y4) * D(str(donation_mult))),
           "share_y5": str(D(inputs.share_y5) * D(str(donation_mult))),
           "occupancy_annual": str(stressed_occ),
           "rent_per_sqft": None,
           "lease_type": "gross",
           "nnn_opex_annual": "0"}
    )
    years, startup, startup_total, occupancy = compute_annual(
        new_inputs, assumptions, demand, trade, overrides)
    startup_by_month = startup_outflows_by_month(new_inputs, assumptions, occupancy[1])
    rows, be = build_monthly(years[1], assumptions, new_inputs.opening_month_number,
                             startup_by_month)
    trough = min((D(str(m.cumulative_cash)) for m in rows), default=Decimal("0"))
    peak = abs(min(Decimal("0"), trough))
    # `peak` already embeds the timed startup outflow (monthly.py) — do NOT add
    # startup_total again (that double-count is the §6.1 capital bug).
    capital = peak + D(assumptions.reserve_buffer)
    return years[1].net, be, capital


def _cash_runway(monthly):
    """Months of non-negative cumulative cash before it first goes negative (§6.1).

    Counts from the first month with any cash activity (cumulative != 0) up to — but
    not including — the first month cumulative cash goes negative. Leading zero-cost
    pre-opening months carry ``cumulative_cash == 0``; they are dead time, not runway,
    so they DO NOT count (pre-#184 they made runway trivially ``1`` on any pre-opening
    timeline even as cash later plunged deeply negative). Returns ``None`` (N/A) when
    cash never goes negative within the horizon — there is no runway constraint then.
    """
    cum = [(m.index, D(str(m.cumulative_cash))) for m in monthly]
    first_negative = next((i for i, c in cum if c < 0), None)
    if first_negative is None:
        return None
    first_active = next((i for i, c in cum if c != 0), first_negative)
    return max(0, first_negative - first_active)


def build_decision(result, inputs, assumptions, demand, trade, overrides, flags):
    annual = result.annual
    monthly = result.monthly
    g = int(inputs.opening_month_number)

    # Capital required: peak cumulative cash deficit across the WHOLE timeline
    # (it begins accumulating in pre-opening). The trough already embeds the timed
    # startup outflows, so startup_total is NEVER added again (the ~$518k-vs-$277,990
    # §6.1 double-count bug).
    cumulative_all = [D(str(m.cumulative_cash)) for m in monthly]
    trough = min(cumulative_all) if cumulative_all else Decimal("0")
    peak_shortfall = abs(min(Decimal("0"), trough))
    capital = peak_shortfall + D(assumptions.reserve_buffer)

    # First-year cash gap: the most-negative cumulative cash over the operating
    # Year-1 window (strictly G..G+11). The opening month's cumulative has already
    # absorbed every pre-opening outflow, so this captures the worst operating-window
    # position. Scope it by month INDEX, not by ``kind == "operating"`` — the latter
    # also tags post-window extension months (a scheduled cost beyond G+11), letting a
    # later-year cost leak its deeper trough into the FIRST-year headline (#182).
    op_cumulative = [D(str(m.cumulative_cash)) for m in monthly if g <= m.index <= g + 11]
    cash_gap = min(op_cumulative) if op_cumulative else Decimal("0")

    runway = _cash_runway(monthly)
    break_even_month = result.monthly_breakeven
    if break_even_month is None:
        flags.setdefault(
            "break_even_month",
            "N/A — operating net never turns sustainably positive within the horizon")

    # Payback milestone: first operating month where cumulative operating profit
    # since opening >= total startup costs (the investment is recovered). Project-
    # month numbered; N/A-with-reason when unreached within the horizon (never a 0).
    payback_month = None
    cum_op_profit = Decimal("0")
    startup_total_d = D(str(result.startup_total))
    for m in monthly:
        if m.kind != "operating":
            continue
        cum_op_profit += D(str(m.net))
        if cum_op_profit >= startup_total_d:
            payback_month = m.index
            break
    if payback_month is None:
        flags.setdefault(
            "payback_month",
            "N/A — startup costs are not recovered within the projection horizon")

    # break-even revenue (annual): revenue at which net == 0 holding the cost
    # structure. fixed = non-%-of-revenue cost; var_rate = sum of %-of-revenue rates.
    y1 = annual[1]
    var_rate = (D(assumptions.card_pct) + D(assumptions.marketing_pct)
                + D(assumptions.labor_pct) * (Decimal("1") + D(assumptions.payroll_tax_pct))
                + D(assumptions.supplies_pct))
    fixed = D(str(y1.total_exp)) - (D(str(y1.total_rev)) * var_rate)
    break_even_revenue = (fixed / (Decimal("1") - var_rate)) if var_rate != 1 else None

    # simple payback (years) — N/A when Y1 net <= 0.
    if D(str(y1.net)) > 0:
        payback = D(str(result.startup_total)) / D(str(y1.net))
    else:
        payback = None
        flags["payback"] = "N/A — no Year 1 profit"

    # revenue CAGR Y1->Y5 — N/A when Y1 rev == 0. Five-year horizon: 4 compounding
    # periods between Year 1 and Year 5, so the exponent is 1/4.
    r1 = D(str(y1.total_rev))
    r5 = D(str(annual[5].total_rev))
    if r1 != 0:
        cagr = (r5 / r1) ** (Decimal("1") / Decimal("4")) - Decimal("1")
    else:
        cagr = None
        flags["cagr"] = "N/A"

    # sensitivity: base / downside / upside, full re-runs (§6.2). The ± stress reads
    # assumptions.sensitivity_delta (model.SENSITIVITY_DELTA is its default and single
    # source) — downside stresses rent ×(1+delta) / donations ×(1-delta), upside the
    # reverse. Default delta 0.25 reproduces the prior 1.25/0.75 literals byte-for-byte.
    delta = D(assumptions.sensitivity_delta)
    up_mult = str(Decimal("1") + delta)      # 1.25 at the 0.25 default
    down_mult = str(Decimal("1") - delta)    # 0.75 at the 0.25 default
    base_net, base_be, base_cap = _scenario_net(
        inputs, assumptions, demand, trade, overrides, "1.0", "1.0")
    down_net, down_be, down_cap = _scenario_net(
        inputs, assumptions, demand, trade, overrides, up_mult, down_mult)
    up_net, up_be, up_cap = _scenario_net(
        inputs, assumptions, demand, trade, overrides, down_mult, up_mult)
    sensitivity = {
        "base": {"net": base_net, "breakeven": base_be, "capital": base_cap},
        "downside": {"net": down_net, "breakeven": down_be, "capital": down_cap},
        "upside": {"net": up_net, "breakeven": up_be, "capital": up_cap},
    }

    reco_tag, reasons = _recommend(
        result, capital, assumptions, inputs, flags, sensitivity, break_even_month)

    return Decision(
        first_year_cash_gap=cash_gap, peak_cash_shortfall=peak_shortfall,
        startup_capital_required=capital, cash_runway_months=runway,
        break_even_month=break_even_month, break_even_revenue_annual=break_even_revenue,
        simple_payback_years=payback, revenue_cagr=cagr,
        reco_tag=reco_tag, reco_reasons=reasons, sensitivity=sensitivity,
        grand_opening_month=g, payback_month=payback_month,
    )


def _recommend(result, capital, assumptions, inputs, flags, sensitivity, break_even_month):
    """Rules-based, explainable recommendation (§6.3). First match wins."""
    reasons = {}
    funds = D(inputs.source_of_funds)
    y1 = result.annual[1]
    horizon_reached_base = break_even_month is not None
    horizon_reached_down = sensitivity["downside"]["breakeven"] is not None

    if not horizon_reached_base or not horizon_reached_down:
        # do_not_proceed fires when EITHER the base OR the downside scenario never
        # reaches break-even. The reason must say WHICH so it can never contradict
        # the break-even metric on the same screen (#142) and a non-finance reader
        # sees WHY the verdict is "do not proceed" (#145).
        if not horizon_reached_base:
            reasons["breakeven"] = (
                "Break-even is not reached within the horizon under the base case "
                "(and the downside scenario fails as well) — the plan is not viable "
                "as configured."
            )
        else:
            # Base DOES break even (the headline Month-N metric is real); only the
            # downside (rent +25% / donations -25%) never does. Surface that so the
            # verdict reads as a robustness gap, not a flat "never breaks even".
            reasons["breakeven"] = (
                f"Base case reaches break-even at Month {break_even_month}, but the "
                "downside scenario (rent +25% / donations -25%) never does — the plan "
                "is not robust to a tougher market."
            )
        return "do_not_proceed", reasons

    if capital > funds:
        reasons["capital"] = "Capital required exceeds the stated source of funds."
        return "raise_cash", reasons

    occ_ratio = (D(str(y1.expenses["Rent"])) / D(str(y1.total_rev))
                 if y1.total_rev != 0 else Decimal("0"))
    if occ_ratio > D(model.OCCUPANCY_RATIO_BAND_MAX) and D(str(y1.net)) <= 0:
        reasons["rent"] = "Occupancy ratio is out of band and is the binding constraint."
        return "find_cheaper_rent", reasons

    if flags.get("net_margin_out_of_band") or flags.get("share_y1_out_of_band") \
            or D(str(y1.net)) <= 0:
        reasons["revise"] = "Outcome hinges on out-of-band inputs or a non-positive Year-1 result."
        return "revise", reasons

    reasons["proceed"] = (
        "Positive Year-1 cash trajectory; capital need within funds; ratios in band."
    )
    return "proceed", reasons


def build_flags(result, assumptions, demand):
    """Centralized N/A + guardrail flags (§8, §12.2)."""
    flags = {
        "model_upgrade_available": False,
        "ramp_low_confidence": True,
    }
    annual = result.annual
    y1 = annual[1]

    # share guardrail (§12.2). The advisory band (≤ ~8% donor market share) is anchored
    # on the early-store view; with the 5-year horizon the band-violation check extends
    # to Year 4 and Year 5 so an over-aggressive late-year donor-share assumption also
    # raises an advisory flag + justification note (a flag, NOT a math error). Year 1
    # keeps its own legacy flag key (read by the recommendation gate); Y4/Y5 get their
    # own additive keys so the existing share_y1 reco logic is unchanged.
    for y, key in ((1, "share_y1_out_of_band"), (4, "share_y4_out_of_band"),
                   (5, "share_y5_out_of_band")):
        share_y = D(str(annual[y].share))
        if share_y > D(model.SHARE_Y1_BAND_MAX):
            flags[key] = {"value": float(share_y), "band": "≤ ~8%", "requires_note": True}

    # net-margin guardrail (> ~30% unusual for a new store) — also checked on Y4/Y5.
    if y1.margin is not None and D(str(y1.margin)) > D(model.NET_MARGIN_FLAG_MAX):
        flags["net_margin_out_of_band"] = {
            "value": float(D(str(y1.margin))), "band": "≤ ~30%", "requires_note": True}
    for y, key in ((4, "net_margin_y4_out_of_band"), (5, "net_margin_y5_out_of_band")):
        margin_y = annual[y].margin
        if margin_y is not None and D(str(margin_y)) > D(model.NET_MARGIN_FLAG_MAX):
            flags[key] = {
                "value": float(D(str(margin_y))), "band": "≤ ~30%", "requires_note": True}

    # revenue == 0 -> margin/per-unit KPIs null
    if y1.total_rev == 0:
        flags["margin"] = "N/A — no revenue"

    return flags

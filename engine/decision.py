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


def _scenario_net(inputs, assumptions, demand, trade, overrides, rent_mult, donation_mult):
    """Full re-run of the core with perturbed rent & donations -> (net, breakeven, capital)."""
    from engine.compute import Inputs, compute_annual
    from engine.monthly import build_monthly

    # perturb shares (proxy for donations) and occupancy.
    new_inputs = Inputs(
        **{**inputs.__dict__,
           "share_y1": str(D(inputs.share_y1) * D(str(donation_mult))),
           "share_y2": str(D(inputs.share_y2) * D(str(donation_mult))),
           "share_y3": str(D(inputs.share_y3) * D(str(donation_mult)))}
    )
    occ = inputs.occupancy_annual
    if occ is not None:
        new_inputs = Inputs(**{**new_inputs.__dict__,
                               "occupancy_annual": str(D(occ) * D(str(rent_mult)))})
    years, startup, startup_total, occupancy = compute_annual(
        new_inputs, assumptions, demand, trade, overrides)
    rows, be = build_monthly(years[1], occupancy[1], startup_total, assumptions,
                             inputs.opening_status)
    trough = min((D(str(m.cumulative_cash)) for m in rows), default=Decimal("0"))
    peak = abs(min(Decimal("0"), trough))
    # `peak` already embeds the M0 startup outflow (monthly.py) — do NOT add
    # startup_total again (that double-count is the §6.1 capital bug).
    capital = peak + D(assumptions.reserve_buffer)
    return years[1].net, be, capital


def build_decision(result, inputs, assumptions, demand, trade, overrides, flags):
    annual = result.annual
    monthly = result.monthly

    cumulative = [D(str(m.cumulative_cash)) for m in monthly]
    cash_gap = min(cumulative) if cumulative else Decimal("0")
    peak_shortfall = abs(min(Decimal("0"), cash_gap))
    # The monthly trough already embeds the full startup outflow (spent at M0 in
    # monthly.py), so |peak shortfall| IS the cash hole *including* startup. Adding
    # result.startup_total again double-counts it (the ~$518k-vs-$277,990 bug).
    capital = peak_shortfall + D(assumptions.reserve_buffer)

    runway = next((m.index for m in monthly if D(str(m.cumulative_cash)) >= 0), None)
    break_even_month = result.monthly_breakeven

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

    # revenue CAGR Y1->Y3 — N/A when Y1 rev == 0.
    r1 = D(str(y1.total_rev))
    r3 = D(str(annual[3].total_rev))
    if r1 != 0:
        cagr = (r3 / r1) ** (Decimal("1") / Decimal("2")) - Decimal("1")
    else:
        cagr = None
        flags["cagr"] = "N/A"

    # sensitivity: base / downside / upside, full re-runs (§6.2).
    base_net, base_be, base_cap = _scenario_net(
        inputs, assumptions, demand, trade, overrides, "1.0", "1.0")
    down_net, down_be, down_cap = _scenario_net(
        inputs, assumptions, demand, trade, overrides, "1.25", "0.75")
    up_net, up_be, up_cap = _scenario_net(
        inputs, assumptions, demand, trade, overrides, "0.75", "1.25")
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
    )


def _recommend(result, capital, assumptions, inputs, flags, sensitivity, break_even_month):
    """Rules-based, explainable recommendation (§6.3). First match wins."""
    reasons = {}
    funds = D(inputs.source_of_funds)
    y1 = result.annual[1]
    horizon_reached_base = break_even_month is not None
    horizon_reached_down = sensitivity["downside"]["breakeven"] is not None

    if not horizon_reached_base or not horizon_reached_down:
        reasons["breakeven"] = (
            "Break-even is not reached within the first year under base or downside."
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
    y1 = result.annual[1]

    # share guardrail (Y1 donor market share <= ~8%)
    share_y1 = D(str(y1.share))
    if share_y1 > D(model.SHARE_Y1_BAND_MAX):
        flags["share_y1_out_of_band"] = {
            "value": float(share_y1), "band": "≤ ~8%", "requires_note": True}

    # net-margin guardrail (> ~30% unusual for a new store)
    if y1.margin is not None and D(str(y1.margin)) > D(model.NET_MARGIN_FLAG_MAX):
        flags["net_margin_out_of_band"] = {
            "value": float(D(str(y1.margin))), "band": "≤ ~30%", "requires_note": True}

    # revenue == 0 -> margin/per-unit KPIs null
    if y1.total_rev == 0:
        flags["margin"] = "N/A — no revenue"

    return flags

"""Appendix-D view-model — the engine's native, JSON-serializable output (§9).

The SAME structure the React frontend renders and the .xlsx/packet builders
consume, so there is no second math/format surface. Money/percent values are
dual-value ``{raw, display}`` (engine.money is the single formatting authority).
The API never returns hex: ``reco.tag`` is the semantic enum; the client maps
enum -> color/token (§9.3).
"""
from __future__ import annotations

from decimal import Decimal

from engine import dag
from engine.money import D, money_view, na_view, number_view, pct_view

_RECO_HEADLINES = {
    "proceed": (
        "Proceed.",
        "Positive Year-1 cash trajectory; capital need within funds; ratios in band.",
    ),
    "revise": (
        "Revise.",
        "The outcome hinges on out-of-band inputs or a non-positive Year-1 result.",
    ),
    "find_cheaper_rent": (
        "Find cheaper rent.",
        "Occupancy is the binding constraint on viability.",
    ),
    "raise_cash": ("Raise cash.", "Capital required exceeds your committed funds."),
    "delay": ("Delay.", "The chosen opening month is cash-infeasible given the ramp."),
    "do_not_proceed": (
        "Do not proceed.",
        "Break-even is not reached within the horizon under base or downside.",
    ),
}

# Rows that are component (pinnable / editable) vs derived (computed, never editable).
# (All six expense labels are already in PINNABLE_NODES — dag is the source of truth.)
_EDITABLE_ROWS = frozenset(dag.PINNABLE_NODES)


def _row_class(label, year_keys_pinned):
    if label in year_keys_pinned:
        return "overridden"
    if label in _EDITABLE_ROWS:
        return "input"
    return "computed"


def _money_or_na(value):
    return na_view() if value is None else money_view(value)


def _pct_or_na(value):
    return na_view() if value is None else pct_view(value)


def _milestone(month, flags, flag_key, opening_month=None):
    """A timeline milestone as ``{raw, display}`` (§8 / #117).

    ``month`` is the project month the milestone lands on, or ``None`` when it is
    never reached within the horizon. The engine is the single formatting authority,
    so the display string ("Month 6") is built here, never on the client. When a
    milestone is unreached the value is the explicit N/A sentinel carrying the
    engine's ``flags`` reason (N/A-with-reason), never a misleading 0. For payback,
    ``opening_month`` adds a plain-language duration display ("25 months") measured
    from grand opening to recovery (inclusive).
    """
    if month is None:
        out = na_view()
        reason = flags.get(flag_key)
        if reason:
            out["reason"] = reason
        return out
    out = {"raw": month, "display": f"Month {month}"}
    if opening_month is not None:
        n = month - opening_month + 1
        out["duration"] = f"{n} {'month' if n == 1 else 'months'}"
    return out


def to_view_model(result):
    annual = result.annual
    dec = result.decision
    overrides = result.overrides_applied

    pinned_by_label = set()
    for key in overrides:
        node, _year = dag.parse_key(key)
        pinned_by_label.add(node)

    # ---- reco
    headline, sub = _RECO_HEADLINES.get(dec.reco_tag, ("", ""))
    reco = {"tag": dec.reco_tag, "headline": headline, "sub": sub}

    # ---- three milestones (§8 / #117): grand opening, break-even, payback — each
    # {raw, display}; N/A-with-reason (from the engine flags) when unreached.
    g = dec.grand_opening_month
    milestones = {
        "grandOpening": _milestone(g, result.flags, "grand_opening_month"),
        "breakEven": _milestone(dec.break_even_month, result.flags, "break_even_month"),
        "payback": _milestone(dec.payback_month, result.flags, "payback_month",
                              opening_month=g),
    }

    # ---- metrics + reasons
    metrics = {
        "capital": money_view(dec.startup_capital_required),
        "cashGap": money_view(dec.first_year_cash_gap),
        "breakeven": ({"raw": dec.break_even_month,
                       "display": f"Month {dec.break_even_month}"}
                      if dec.break_even_month is not None else na_view()),
        "reasonCapital": dec.reco_reasons.get("capital",
            "Worst-case cumulative cash trough (already includes one-time startup) plus reserve."),
        "reasonGap": dec.reco_reasons.get("gap",
            "Most-negative cumulative cash across the first year."),
        "reasonBreakeven": dec.reco_reasons.get("breakeven",
            "First month operating net turns and stays non-negative."),
    }

    # ---- KPIs
    y1 = annual[1]
    # Operating-efficiency ratios derived from existing engine outputs (no new
    # math); N/A-guarded so a 0-revenue / 0-salesfloor case never divides by zero.
    rev1 = D(str(y1.total_rev))
    salesfloor_sqft = D(result.inputs.building_sqft) * D(result.inputs.salesfloor_pct)
    # N/A on 0 revenue too (ENGINE_CONTRACT §12.4) — consistent with margin/occ/labor.
    sales_per_sqft = (rev1 / salesfloor_sqft) if (salesfloor_sqft != 0 and rev1 != 0) else None
    occ_ratio = (D(str(y1.expenses.get("Rent", 0))) / rev1) if rev1 != 0 else None
    labor_ratio = (D(str(y1.expenses.get("Payroll", 0))) / rev1) if rev1 != 0 else None
    kpis = [
        {"label": "Total revenue", "value": money_view(y1.total_rev), "sub": "Year 1",
         "color": "text"},
        {"label": "Net profit", "value": money_view(y1.net), "sub": "Year 1", "color": "text"},
        {"label": "Net margin", "value": _pct_or_na(y1.margin), "sub": "Year 1", "color": "text"},
        {"label": "Sales / sq ft", "value": _money_or_na(sales_per_sqft),
         "sub": "Year 1", "color": "text"},
        {"label": "Capital required", "value": money_view(dec.startup_capital_required),
         "sub": "incl. reserve", "color": "text"},
        {"label": "Break-even month",
         "value": ({"raw": dec.break_even_month, "display": f"Month {dec.break_even_month}"}
                   if dec.break_even_month is not None else na_view()),
         "sub": "operating net", "color": "text"},
        {"label": "Payback period", "value": milestones["payback"],
         "sub": "to recover startup", "color": "text"},
        {"label": "Occupancy ratio", "value": _pct_or_na(occ_ratio),
         "sub": "rent / revenue", "color": "text"},
        {"label": "Labor ratio", "value": _pct_or_na(labor_ratio),
         "sub": "payroll / revenue", "color": "text"},
        {"label": "Revenue CAGR", "value": _pct_or_na(dec.revenue_cagr),
         "sub": "Y1->Y3", "color": "text"},
    ]

    # ---- 3-year rows
    rows = []
    rows.append(_driver_row("Donor market share", annual, "share", pct=True, group="drivers"))
    rows.append(
        _driver_row("Donating households", annual, "donating_hh", num=True, group="drivers")
    )
    rows.append(_driver_row("Annual donations", annual, "donations", num=True, group="drivers"))
    rows.append(
        _driver_row("Customers", annual, "customers", num=True, group="drivers", computed=True)
    )
    rows.append(_driver_row("Retail Sales", annual, "retail", group="revenue"))
    rows.append(_driver_row("Salvage Sales", annual, "salvage", group="revenue", computed=True))
    rows.append(_driver_row("Total Revenue", annual, "total_rev", group="revenue", computed=True))
    # expense component rows (stable order from year 1)
    for label in y1.expenses:
        rows.append({
            "label": label, "group": "expenses",
            "y1": money_view(annual[1].expenses[label]),
            "y2": money_view(annual[2].expenses[label]),
            "y3": money_view(annual[3].expenses[label]),
            "class": _row_class(label, pinned_by_label),
            "editable": label in _EDITABLE_ROWS and label not in pinned_by_label,
        })
    rows.append(_driver_row("Total Expenses", annual, "total_exp", group="expenses", computed=True))
    rows.append(_driver_row("Net profit", annual, "net", group="expenses", computed=True))
    rows.append({
        "label": "Net margin", "group": "expenses",
        "y1": _pct_or_na(annual[1].margin), "y2": _pct_or_na(annual[2].margin),
        "y3": _pct_or_na(annual[3].margin), "class": "computed", "editable": False,
    })

    # ---- monthly (project months 1..N; the SAME columns the .xlsx tab renders, so
    # there is no second math surface). Net = revenue - operating expenses -
    # scheduled one-time costs (= the xlsx Net column), so a pre-opening month reads
    # as a real monthly loss and cumulativeCash is the running sum of net from M1.
    monthly = [{
        "month": m.index,
        "revenue": money_view(m.revenue),
        "expenses": money_view(m.expenses),
        "scheduledCosts": money_view(m.startup_outflow),
        "net": money_view(m.cash_net),
        "cumulativeCash": money_view(m.cumulative_cash),
    } for m in result.monthly]

    # ---- overrides list (Override Inspector: calc-vs-override + affected rows)
    calc_unpinned = _unpinned_annual(result)
    ov_list = []
    for key, pin in overrides.items():
        node, year = dag.parse_key(key)
        calc = calc_unpinned.get((node, year)) if calc_unpinned else None
        is_pct = node == "share"
        ov_list.append({
            "node": node, "year": year,
            "calculated": (_pct_or_na(calc) if is_pct else _money_or_na(calc)),
            "value": (pct_view(D(pin["value"])) if is_pct else money_view(D(pin["value"]))),
            "note": pin.get("note", ""),
            "pinnedDate": pin.get("ts", ""),
            "affected": dag.affected_rows(node),
        })

    # ---- settings (raw scalars for sliders)
    a = result.assumptions
    settings = {
        "laborPct": float(D(a.labor_pct)),
        "marketingPct": float(D(a.marketing_pct)),
        "suppliesPct": float(D(a.supplies_pct)),
        "cardPct": float(D(a.card_pct)),
        "payrollTaxPct": float(D(a.payroll_tax_pct)),
        "salvagePct": float(D(a.salvage_pct)),
        "escalator": float(D(a.escalator)),
        "basket": float(D(a.basket)),
        "donationsPerHh": a.donations_per_hh,
        "shareY1": float(D(result.inputs.share_y1)),
        "shareY2": float(D(result.inputs.share_y2)),
        "shareY3": float(D(result.inputs.share_y3)),
        "reserveBuffer": a.reserve_buffer,
        "leaseType": result.inputs.lease_type,
        "salesfloorSqft": float(D(result.inputs.building_sqft) * D(result.inputs.salesfloor_pct)),
    }

    return {
        "reco": reco,
        "metrics": metrics,
        "milestones": milestones,
        "kpis": kpis,
        "monthly": monthly,
        "breakevenMonth": result.monthly_breakeven,
        "rows": rows,
        "overrides": ov_list,
        "settings": settings,
        "evidence": [],
        "flags": _jsonable(result.flags),
        "staleNodes": list(result.stale_nodes),
        "version": result.model_version,
        "model_version": result.model_version,
        "compute_schema_version": result.compute_schema_version,
    }


def _unpinned_annual(result):
    """Recompute the annual chain with NO overrides -> {(node, year): Decimal}.

    Gives the Override Inspector's ``calculated`` value (what the engine derives
    for a pinned node when the pin is absent), without back-solving anything. Pure
    and deterministic; reuses compute_annual so the calc matches the live formula.
    """
    if not result.overrides_applied:
        return {}
    from engine.compute import compute_annual
    years, _startup, _st, _occ = compute_annual(
        result.inputs, result.assumptions, None, result.trade_area, {})
    out = {}
    for y in (1, 2, 3):
        yr = years[y]
        out[("share", y)] = yr.share
        for label, val in yr.expenses.items():
            out[(label, y)] = val
    return out


def _driver_row(label, annual, attr, group, pct=False, num=False, computed=False):
    def cell(y):
        v = getattr(annual[y], attr)
        if pct:
            return pct_view(v)
        if num:
            return number_view(v)
        return money_view(v)
    return {
        "label": label, "group": group,
        "y1": cell(1), "y2": cell(2), "y3": cell(3),
        "class": "computed" if computed else "input",
        "editable": (not computed) and attr == "share",
    }


def _jsonable(obj):
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, Decimal):
        return float(obj)
    return obj

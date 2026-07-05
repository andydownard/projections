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
from engine.compute import cash_margin, cash_net
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
    # RESERVED (documented enum, PRD reco tags): `engine.decision._recommend` does
    # NOT currently emit "delay" — no opening-month cash-infeasibility branch exists
    # yet. Kept as a forward-compatible contract value so the client enum->color map
    # stays complete; if a producing branch is added it MUST land with a RED test
    # that asserts reco_tag == "delay" before this headline is treated as live.
    "delay": ("Delay.", "The chosen opening month is cash-infeasible given the ramp."),
    "do_not_proceed": (
        "Do not proceed.",
        # Fallback only — for do_not_proceed the sub is replaced by the engine's
        # precise break-even reason (base vs downside), so it never contradicts the
        # break-even metric on the same screen (#142). See to_view_model().
        "Break-even is not robust across the base and downside scenarios.",
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


def _month_view(month):
    """A project-month value as ``{raw, display}`` ("Month 6"), or N/A when unreached.

    The engine is the single formatting authority, so the "Month N" display string is
    built here once and reused by every break-even / milestone surface — never copied
    inline and never re-derived on the client (§9).
    """
    return na_view() if month is None else {"raw": month, "display": f"Month {month}"}


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
    out = _month_view(month)
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
    # For do_not_proceed the verdict sub must name WHICH scenario fails (the base
    # case vs only the downside) so it can never contradict the break-even metric
    # shown alongside it (#142) and surfaces the downside driver to a non-finance
    # reader (#145). The engine's break-even reason is the single source of truth.
    if dec.reco_tag == "do_not_proceed":
        sub = dec.reco_reasons.get("breakeven", sub)
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
        "breakeven": _month_view(dec.break_even_month),
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
        # Net income + Net margin are CASH-based (epic #321): Year 1 includes the
        # one-time startup hit; both displayed numbers agree (one congruent margin).
        {"label": "Net income", "value": money_view(cash_net(result, 1)), "sub": "Year 1",
         "color": "text"},
        {"label": "Net margin", "value": _pct_or_na(cash_margin(result, 1)), "sub": "Year 1",
         "color": "text"},
        {"label": "Sales / sq ft", "value": _money_or_na(sales_per_sqft),
         "sub": "Year 1", "color": "text"},
        {"label": "Capital required", "value": money_view(dec.startup_capital_required),
         "sub": "incl. reserve", "color": "text"},
        {"label": "Break-even month",
         "value": _month_view(dec.break_even_month),
         "sub": "operating net", "color": "text"},
        {"label": "Payback period", "value": milestones["payback"],
         "sub": "to recover startup", "color": "text"},
        {"label": "Occupancy ratio", "value": _pct_or_na(occ_ratio),
         "sub": "rent / revenue", "color": "text"},
        {"label": "Labor ratio", "value": _pct_or_na(labor_ratio),
         "sub": "payroll / revenue", "color": "text"},
        {"label": "Revenue CAGR", "value": _pct_or_na(dec.revenue_cagr),
         "sub": "Y1->Y5", "color": "text"},
    ]

    # ---- 5-year rows (each annual line carries y1..y5)
    rows = []
    rows.append(_driver_row("Donor market share", annual, "share", pct=True, group="drivers"))
    # Donating households / Annual donations / Retail Sales are each derived by
    # multiplying the row above by another driver (households x share, then x
    # donations/hh/yr, then x donation value) — they are NOT raw inputs, so they
    # get computed=True (the neutral "computed" tint), leaving Donor market share
    # as the only true input/pinnable cell in this chain. The "Customers" row
    # (retail / basket, i.e. transaction count) is intentionally NOT surfaced
    # here — it's KPI-strip territory, not a driver-chain row (owner feedback).
    rows.append(
        _driver_row(
            "Donating households", annual, "donating_hh", num=True, group="drivers", computed=True
        )
    )
    rows.append(
        _driver_row(
            "Annual donations", annual, "donations", num=True, group="drivers", computed=True
        )
    )
    rows.append(_driver_row("Retail Sales", annual, "retail", group="revenue", computed=True))
    rows.append(_driver_row("Salvage Sales", annual, "salvage", group="revenue", computed=True))
    rows.append(_driver_row("Total Revenue", annual, "total_rev", group="revenue", computed=True))
    # expense component rows (stable order from year 1)
    for label in y1.expenses:
        rows.append({
            "label": label, "group": "expenses",
            "y1": money_view(annual[1].expenses[label]),
            "y2": money_view(annual[2].expenses[label]),
            "y3": money_view(annual[3].expenses[label]),
            "y4": money_view(annual[4].expenses[label]),
            "y5": money_view(annual[5].expenses[label]),
            "class": _row_class(label, pinned_by_label),
            # I3 (#322): a pinnable component row stays editable even when pinned, so
            # the owner can re-edit the pin in place (the cell is the override entry
            # point). The "overridden" class drives the orange highlight; editability
            # is independent of the pin. Goldens are override-free, so this is a no-op
            # for them (nothing is in `pinned_by_label`).
            "editable": label in _EDITABLE_ROWS,
        })
    rows.append(_driver_row("Total Expenses", annual, "total_exp", group="expenses", computed=True))
    # Net income + Net margin rows are CASH-based (epic #321). The label stays "Net
    # income" / "Net margin" — only the NUMBERS are cash-based (Year-1 subtracts the
    # one-time startup; Years 2-5 are operating, == cash). The two are congruent by
    # construction (margin == net / revenue), so the board never sees a second margin.
    rows.append({
        "label": "Net income", "group": "expenses",
        "y1": money_view(cash_net(result, 1)), "y2": money_view(cash_net(result, 2)),
        "y3": money_view(cash_net(result, 3)), "y4": money_view(cash_net(result, 4)),
        "y5": money_view(cash_net(result, 5)), "class": "computed", "editable": False,
    })
    rows.append({
        "label": "Net margin", "group": "expenses",
        "y1": _pct_or_na(cash_margin(result, 1)), "y2": _pct_or_na(cash_margin(result, 2)),
        "y3": _pct_or_na(cash_margin(result, 3)), "y4": _pct_or_na(cash_margin(result, 4)),
        "y5": _pct_or_na(cash_margin(result, 5)), "class": "computed", "editable": False,
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
        "utilitiesPerSqft": float(D(a.utilities_per_sqft)),
        "rentPerSqft": (
            float(D(result.inputs.rent_per_sqft))
            if result.inputs.rent_per_sqft is not None else None
        ),
        "basket": float(D(a.basket)),
        "donationsPerHh": a.donations_per_hh,
        # Editable donation drivers (E2). donationValue (Inputs.donation_value) and
        # donationsPerHouseholdPerYear (the donations/hh/yr driver) join the already
        # exposed basket so the wizard/settings can edit retail = donations × value
        # and customers = retail / basket. donationsPerHh is retained as an alias.
        "donationValue": float(D(result.inputs.donation_value)),
        "donationsPerHouseholdPerYear": a.donations_per_hh,
        "shareY1": float(D(result.inputs.share_y1)),
        "shareY2": float(D(result.inputs.share_y2)),
        "shareY3": float(D(result.inputs.share_y3)),
        "shareY4": float(D(result.inputs.share_y4)),
        "shareY5": float(D(result.inputs.share_y5)),
        "reserveBuffer": a.reserve_buffer,
        "leaseType": result.inputs.lease_type,
        "salesfloorSqft": float(D(result.inputs.building_sqft) * D(result.inputs.salesfloor_pct)),
        # 1.6.0: the remaining editable knobs the view-model previously dropped (audit
        # P0) — the ± stress fraction, the fixed-annual operating map, the NNN opex
        # add-on, and the building/salesfloor geometry the sq-ft-scaled lines derive from.
        "sensitivityDelta": float(D(a.sensitivity_delta)),
        "fixedAnnual": {label: float(v) for label, v in a.fixed_annual.items()},
        "nnnOpexAnnual": float(D(result.inputs.nnn_opex_annual)),
        "buildingSqft": float(D(result.inputs.building_sqft)),
        "salesfloorPct": float(D(result.inputs.salesfloor_pct)),
    }

    # ---- annual net-income series Y1..Y5 ({raw,display}) — feeds the list/detail
    # sparkline. CASH-based (epic #321): Year 1 includes the one-time startup hit, Years
    # 2-5 are operating net (== cash). The engine/server is the single format authority,
    # so the client renders these display strings and never re-derives the trend line.
    income_series = [money_view(cash_net(result, y)) for y in (1, 2, 3, 4, 5)]

    # ---- one-time startup costs (schema 1.5.0) — the per-category line items + the
    # total, surfaced as {raw,display} so the Board Packet .docx (EPIC DOCX) renders a
    # grounded startup-costs table from the SAME format authority. result.startup
    # already includes the computed "Lease Deposit + First Month Rent" line; order is
    # preserved so the table reads the way the engine assembled it.
    startup_costs = [
        {"category": label, "amount": money_view(amount)}
        for label, amount in result.startup.items()
    ]

    # ---- sensitivity scenarios (schema 1.6.0) — the §12.2 ±stress base/downside/upside
    # runs decision.py already computes, serialized verbatim (no second math surface):
    # net + capital as {raw,display} money views, break-even as a plain project-month
    # int (or None when never reached), and the ± fraction delta. The client renders the
    # robustness view from these; it never re-runs the stress.
    sensitivity = {
        scenario: {
            "net": money_view(vals["net"]),
            "breakeven": vals["breakeven"],
            "capital": money_view(vals["capital"]),
        }
        for scenario, vals in (
            ("base", dec.sensitivity["base"]),
            ("downside", dec.sensitivity["downside"]),
            ("upside", dec.sensitivity["upside"]),
        )
    }
    sensitivity["delta"] = float(D(a.sensitivity_delta))

    # ---- confidence (schema 1.6.0) — the ramp low-confidence flag build_flags sets,
    # surfaced as a label the client can render next to the ramp-dependent metrics
    # (audit P0: the flag was computed but never reached the view-model).
    confidence = {"ramp": "low" if result.flags.get("ramp_low_confidence") else "high"}

    return {
        "reco": reco,
        "metrics": metrics,
        "milestones": milestones,
        "kpis": kpis,
        "monthly": monthly,
        "breakevenMonth": result.monthly_breakeven,
        "incomeSeries": income_series,
        "year5Income": money_view(cash_net(result, 5)),
        "startupCosts": startup_costs,
        "startupTotal": money_view(result.startup_total),
        "rows": rows,
        "overrides": ov_list,
        "settings": settings,
        "sensitivity": sensitivity,
        "confidence": confidence,
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
    from engine.compute import unpinned_node_values
    return unpinned_node_values(
        result.inputs, result.assumptions, None, result.trade_area)


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
        "y1": cell(1), "y2": cell(2), "y3": cell(3), "y4": cell(4), "y5": cell(5),
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

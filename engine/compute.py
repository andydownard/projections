"""engine/compute.py — THE pure compute core (ENGINE_CONTRACT §4, §9).

PURE, deterministic, side-effect-free. NO openpyxl / python-docx / network /
filesystem / clock imports (asserted by the import-guard test M1-IMPORTGUARD).

M0 scaffold scope: this lands the pure annual driver chain (the EXISTS rows of the
Engine Gap Table — methodology lines 8–15) and the expense lines, emitting the
Appendix-D view-model NATIVELY with the {raw, display} dual-value convention and
the model_version / compute_schema_version stamps. The monthly cash-flow (monthly.py),
decision metrics (decision.py), and override DAG (dag.py) are M1 and land with their
own RED golden tests; their result keys are present here as explicit nulls so the
view-model SHAPE is stable from commit one.

Math is in Decimal; rounding happens only at display (ENGINE_CONTRACT §6.5).
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from engine import model

YEARS = (1, 2, 3)


def _money_display(value: Decimal) -> str:
    """Whole-dollars, negatives in parentheses (ENGINE_CONTRACT §6.5 / §8)."""
    whole = value.quantize(Decimal(1), rounding=ROUND_HALF_UP)
    if whole < 0:
        return f"(${-whole:,.0f})"
    return f"${whole:,.0f}"


def _pct_display(value: Decimal) -> str:
    """Percent to 0.1pp."""
    pct = (value * 100).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    return f"{pct}%"


def money(value: Decimal) -> dict[str, Any]:
    return {"raw": float(value), "display": _money_display(value)}


def pct(value: Decimal | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return {"raw": float(value), "display": _pct_display(value)}


def _D(x: Any) -> Decimal:
    return Decimal(str(x))


def compute(
    inputs: dict[str, Any],
    assumptions: dict[str, Any] | None = None,
    demand_drivers: dict[str, Any] | None = None,
    trade_area: dict[str, Any] | None = None,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Pure annual compute. Returns the Appendix-D view-model dict.

    `inputs` carries households (H), explicit share_y1/y2/y3, donation_value.
    `assumptions` overrides any named default in engine.model. Defaults are used
    when a key is absent — NO formula hard-codes a literal.
    """
    a = dict(assumptions or {})
    H = _D(trade_area.get("households") if trade_area else inputs["households"])
    shares = [
        _D(inputs["share_y1"]),
        _D(inputs.get("share_y2", inputs["share_y1"])),
        _D(inputs["share_y3"]),
    ]
    freq = _D(a.get("donations_per_hh", model.DONATIONS_PER_HH_PER_YEAR))
    donation_value = _D(inputs["donation_value"])
    salvage_pct = _D(a.get("salvage_pct", model.SALVAGE_PCT_OF_RETAIL))
    basket = _D(a.get("basket", model.AVG_BASKET_VALUE))

    labor_pct = _D(a.get("labor_pct", model.LABOR_PCT_OF_REVENUE))
    marketing_pct = _D(a.get("marketing_pct", model.MARKETING_PCT_OF_REVENUE))
    supplies_pct = _D(a.get("supplies_pct", model.SUPPLIES_PCT_OF_REVENUE))
    card_pct = _D(a.get("card_pct", model.CARD_FEES_PCT_OF_REVENUE))
    payroll_tax_pct = _D(a.get("payroll_tax_pct", model.PAYROLL_TAX_PCT_OF_PAYROLL))
    escalator = _D(a.get("escalator", model.RENT_ESCALATOR))

    # Occupancy: annual $ OR sqft x rate; escalated Y2–Y3 (ENGINE_CONTRACT §4.2).
    occ_annual = a.get("occupancy_annual")
    if occ_annual is None:
        occ_y1 = _D(inputs["building_sqft"]) * _D(a.get("rent_per_sqft", 0))
    else:
        occ_y1 = _D(occ_annual)

    per_year: dict[str, list[Decimal]] = {
        "total_rev": [], "net": [], "margin": [], "payroll": [], "occupancy": [],
    }

    for idx, y in enumerate(YEARS):
        share = shares[idx]
        donating_hh = H * share
        donations = donating_hh * freq
        retail = donations * donation_value
        salvage = retail * salvage_pct
        total_rev = retail + salvage

        occupancy = occ_y1 * (Decimal(1) + escalator) ** (y - 1)
        payroll = total_rev * labor_pct
        payroll_tax = payroll * payroll_tax_pct
        marketing = total_rev * marketing_pct
        supplies = total_rev * supplies_pct
        card_fees = total_rev * card_pct
        fixed_total = sum((_D(v) for v in model.FIXED_ANNUAL.values()), Decimal(0))

        total_exp = (
            payroll + payroll_tax + marketing + supplies + card_fees
            + occupancy + fixed_total
        )
        net = total_rev - total_exp
        margin = (net / total_rev) if total_rev != 0 else None

        per_year["total_rev"].append(total_rev)
        per_year["net"].append(net)
        per_year["margin"].append(margin)  # type: ignore[arg-type]
        per_year["payroll"].append(payroll)
        per_year["occupancy"].append(occupancy)

    def _row(label: str, group: str, values: list[Decimal], node: str,
             cls: str = "computed", fmt=money) -> dict:
        return {
            "label": label, "group": group, "node": node, "class": cls,
            "editable": cls == "input",
            "y1": fmt(values[0]), "y2": fmt(values[1]), "y3": fmt(values[2]),
        }

    rows = [
        _row("Total revenue", "totals", per_year["total_rev"], "total_revenue"),
        _row("Payroll", "expenses", per_year["payroll"], "Payroll"),
        _row("Net profit", "totals", per_year["net"], "net_profit"),
    ]

    # Y1 net margin flag (N/A path — ENGINE_CONTRACT §8).
    flags: dict[str, Any] = {
        "model_upgrade_available": False,
        "margin": "N/A — no revenue" if per_year["total_rev"][0] == 0 else "ok",
        "payback": None if per_year["net"][0] <= 0 else "ok",
        "ramp_low_confidence": True,  # monthly ramp uncalibrated (§12.5)
        "stale_upstream": [],
    }

    return {
        "model_version": model.MODEL_VERSION,
        "compute_schema_version": model.COMPUTE_SCHEMA_VERSION,
        # reco / metrics / monthly are M1 (decision.py + monthly.py); shape-stable nulls.
        "reco": None,
        "metrics": {"capital": None, "cashGap": None, "breakeven": None},
        "kpis": [],
        "monthly": [],
        "breakevenMonth": None,
        "rows": rows,
        "overrides": [],
        "evidence": [],
        "settings": {
            "laborPct": float(labor_pct),
            "marketingPct": float(marketing_pct),
            "suppliesPct": float(supplies_pct),
            "cardPct": float(card_pct),
            "payrollTaxPct": float(payroll_tax_pct),
            "escalator": float(escalator),
            "basket": float(basket),
            "donationsPerHh": float(freq),
            "shareY1": float(shares[0]),
            "shareY2": float(shares[1]),
            "shareY3": float(shares[2]),
        },
        "flags": flags,
        # Internal raw Decimals for the golden reconcile (not part of the public view-model).
        "_raw": {
            "total_rev": [float(v) for v in per_year["total_rev"]],
            "net": [float(v) for v in per_year["net"]],
            "margin": [float(v) if v is not None else None for v in per_year["margin"]],
        },
    }

"""The pure, deterministic compute core (ENGINE_CONTRACT §4, §9).

`compute()` is side-effect-free: no openpyxl / python-docx / network / filesystem
/ clock imports. Same inputs -> byte-identical result. All math is in Decimal;
rounding happens only at the view-model / compare boundary (engine/money.py).

This module owns the annual driver chain + the %-of-revenue cost structure + the
rent escalator + the one-time startup block. The monthly cash-flow (engine/monthly),
decision metrics (engine/decision), override resolution (engine/dag) and the
Appendix-D view-model (engine/viewmodel) are layered on top; `compute()` assembles
them into a single `ComputeResult`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from engine import model
from engine.money import D

# ---- expense line ordering (stable; drives Excel rows + roll-ups)
PCT_OF_REVENUE_LINES = (
    "Credit card fees",
    "Marketing & outreach",
    "Payroll",
    "Supplies & processing",
)
# Payroll taxes derive from Payroll; Rent from occupancy. Fixed lines from model.
EXPENSE_ORDER = (
    "Credit card fees",
    "Insurance liability",
    "Internet, Phones",
    "Marketing & outreach",
    "Payroll",
    "Payroll taxes",
    "Pest control",
    "Rent",
    "Repairs/maintenance",
    "Security system",
    "Supplies & processing",
    "Utilities/trash service",
)


# --------------------------------------------------------------------------- IO
@dataclass(frozen=True)
class Inputs:
    org_name: str
    city: str
    opening_status: str            # "pre_launch" | "operating"
    share_y1: str
    share_y2: str
    share_y3: str
    share_y4: str
    share_y5: str
    donation_value: str
    building_sqft: str
    salesfloor_pct: str
    source_of_funds: str
    occupancy_annual: str | None = None     # explicit annual occupancy $ (preferred)
    rent_per_sqft: str | None = None        # OR sqft x rate
    lease_type: str = "gross"                  # "gross" | "nnn"
    nnn_opex_annual: str = "0"                 # added to occupancy if nnn
    # Opening anchor + timed cost schedule (Spec §5/§6). `opening_month_number` (G)
    # is the project month grand opening lands on (a milestone marker, >= 1).
    # `cost_schedule` is an iterable of {category, month, amount} rows; when empty
    # the legacy single-lump-at-opening default applies (reproduces today's numbers).
    opening_month_number: int = 1
    cost_schedule: tuple = ()


@dataclass(frozen=True)
class Assumptions:
    labor_pct: str = model.LABOR_PCT_OF_REVENUE
    marketing_pct: str = model.MARKETING_PCT_OF_REVENUE
    supplies_pct: str = model.SUPPLIES_PCT_OF_REVENUE
    card_pct: str = model.CARD_FEES_PCT_OF_REVENUE
    payroll_tax_pct: str = model.PAYROLL_TAX_PCT_OF_PAYROLL
    salvage_pct: str = model.SALVAGE_PCT_OF_RETAIL
    escalator: str = model.RENT_ESCALATOR
    utilities_per_sqft: str = model.UTILITIES_PER_SQFT
    basket: str = model.AVG_BASKET_VALUE
    donations_per_hh: int = model.DONATIONS_PER_HH_PER_YEAR
    reserve_buffer: int = model.CASH_RESERVE_BUFFER
    fixed_annual: dict = field(default_factory=lambda: dict(model.FIXED_ANNUAL))
    startup: dict = field(default_factory=lambda: dict(model.STARTUP))


@dataclass(frozen=True)
class DemandDrivers:
    confidence: str = "medium"
    seasonality: tuple | None = None        # 12 monthly weights or None


@dataclass(frozen=True)
class TradeArea:
    basis: str = "city"                        # city | county | manual
    households: str = "0"
    acs_vintage: str | None = None


# ------------------------------------------------------------------ result rows
@dataclass
class AnnualYear:
    year: int
    share: Decimal
    donating_hh: Decimal
    donations: Decimal
    retail: Decimal
    customers: Decimal
    salvage: Decimal
    total_rev: Decimal
    expenses: dict           # label -> Decimal
    total_exp: Decimal
    net: Decimal
    margin: Decimal | None  # None when total_rev == 0 (§8)


@dataclass
class ComputeResult:
    annual: dict             # {1: AnnualYear, 2: ..., 5: AnnualYear} (5-year horizon)
    startup: dict            # label -> Decimal
    startup_total: Decimal
    occupancy: dict          # {1: Decimal, ..., 5: Decimal} resolved occupancy per year
    inputs: Inputs
    assumptions: Assumptions
    trade_area: TradeArea
    monthly: list = field(default_factory=list)   # filled by monthly model
    monthly_breakeven: int | None = None       # first sustained net>=0 month
    decision: object = None                       # filled by decision model
    overrides_applied: dict = field(default_factory=dict)
    stale_nodes: list = field(default_factory=list)
    flags: dict = field(default_factory=dict)
    view_model: dict = field(default_factory=dict)
    model_version: str = model.MODEL_VERSION
    compute_schema_version: str = model.COMPUTE_SCHEMA_VERSION


# --------------------------------------------------------------------- helpers
def _occupancy_y1(inputs: Inputs) -> Decimal:
    if inputs.occupancy_annual is not None:
        base = D(inputs.occupancy_annual)
    elif inputs.rent_per_sqft is not None:
        base = D(inputs.building_sqft) * D(inputs.rent_per_sqft)
    else:
        raise ValueError("occupancy requires occupancy_annual or rent_per_sqft")
    if inputs.lease_type == "nnn":
        base = base + D(inputs.nnn_opex_annual)
    return base


def _resolve_get(overrides, node, year, computed: Decimal) -> Decimal:
    """A pinned component uses its value; else the computed value (§7.3).

    This is the minimal pin lookup used during annual assembly; the full
    topological DAG lives in engine/dag.py and is exercised by compute() via
    the overrides it forwards here. Keys are "{node}#{year}".
    """
    key = f"{node}#{year}"
    pin = overrides.get(key) if overrides else None
    if pin is not None:
        return D(pin["value"])
    return computed


# ---------------------------------------------------------------------- public
def compute_annual(inputs, assumptions, demand_drivers, trade_area, overrides):
    H = D(trade_area.households)
    freq = D(assumptions.donations_per_hh)
    dv = D(inputs.donation_value)
    basket = D(assumptions.basket)
    salv_pct = D(assumptions.salvage_pct)
    escalator = D(assumptions.escalator)

    occ1 = _occupancy_y1(inputs)
    shares = {
        1: D(inputs.share_y1), 2: D(inputs.share_y2), 3: D(inputs.share_y3),
        4: D(inputs.share_y4), 5: D(inputs.share_y5),
    }

    # 5-year horizon: the rent escalator compounds through Year 5 with the SAME
    # formula occ1*(1+e)^(y-1) — no special-casing (ENGINE_CONTRACT §3/§5).
    occupancy = {y: occ1 * (Decimal("1") + escalator) ** (y - 1) for y in (1, 2, 3, 4, 5)}

    years = {}
    for y in (1, 2, 3, 4, 5):
        share = _resolve_get(overrides, "share", y, shares[y])
        donating_hh = H * share
        donations = donating_hh * freq
        retail = donations * dv
        customers = retail / basket if basket != 0 else Decimal("0")
        salvage = retail * salv_pct
        total_rev = retail + salvage

        exp = {}
        exp["Credit card fees"] = _resolve_get(
            overrides, "Credit card fees", y, total_rev * D(assumptions.card_pct))
        exp["Marketing & outreach"] = _resolve_get(
            overrides, "Marketing & outreach", y, total_rev * D(assumptions.marketing_pct))
        payroll = _resolve_get(
            overrides, "Payroll", y, total_rev * D(assumptions.labor_pct))
        exp["Payroll"] = payroll
        exp["Payroll taxes"] = _resolve_get(
            overrides, "Payroll taxes", y, payroll * D(assumptions.payroll_tax_pct))
        exp["Supplies & processing"] = _resolve_get(
            overrides, "Supplies & processing", y, total_rev * D(assumptions.supplies_pct))
        exp["Rent"] = _resolve_get(overrides, "Rent", y, occupancy[y])
        # Utilities/trash service is the SAME pinnable component line + slot as before,
        # now DERIVED as UTILITIES_PER_SQFT × building_sqft (feature #245). Anchored so
        # 10,000 sq ft == today's $22,300. Not a new DAG node / xlsx row.
        exp["Utilities/trash service"] = _resolve_get(
            overrides, "Utilities/trash service", y,
            D(inputs.building_sqft) * D(assumptions.utilities_per_sqft))
        for label, val in assumptions.fixed_annual.items():
            exp[label] = _resolve_get(overrides, label, y, D(val))

        # stable order
        ordered = {k: exp[k] for k in EXPENSE_ORDER if k in exp}
        for k in exp:  # any extra fixed lines not in EXPENSE_ORDER
            ordered.setdefault(k, exp[k])

        total_exp = sum(ordered.values(), Decimal("0"))
        net = total_rev - total_exp
        margin = (net / total_rev) if total_rev != 0 else None

        years[y] = AnnualYear(
            year=y, share=share, donating_hh=donating_hh, donations=donations,
            retail=retail, customers=customers, salvage=salvage, total_rev=total_rev,
            expenses=ordered, total_exp=total_exp, net=net, margin=margin,
        )

    # one-time startup. A user cost_schedule (Spec §5) supersedes the legacy STARTUP
    # lump: the per-category breakdown is the schedule aggregated by category. The
    # lease deposit is always computed from rent_y1 (un-escalated) and added on top.
    if inputs.cost_schedule:
        startup: dict = {}
        for item in inputs.cost_schedule:
            cat = item["category"]
            startup[cat] = startup.get(cat, Decimal("0")) + D(str(item["amount"]))
    else:
        startup = {k: D(v) for k, v in assumptions.startup.items()}
    startup["Lease Deposit + First Month Rent"] = occ1 / 12 * 3
    startup_total = sum(startup.values(), Decimal("0"))

    return years, startup, startup_total, occupancy


def unpinned_node_values(inputs, assumptions, demand_drivers, trade_area) -> dict:
    """Every pinnable (node, year) cell's calculated value with NO overrides.

    Maps ``("share", y)`` and each expense label to its Decimal from a pure
    recompute of the annual chain (no back-solve). The single source of "what the
    engine derives when the pin is absent", shared by the router's
    auto-clear-on-equal check and the Override Inspector's ``calculated`` column,
    so the two can never drift in which cells they expose.
    """
    years, _startup, _startup_total, _occupancy = compute_annual(
        inputs, assumptions, demand_drivers, trade_area, {})
    out: dict = {}
    for y in (1, 2, 3, 4, 5):
        yr = years[y]
        out[("share", y)] = yr.share
        for label, val in yr.expenses.items():
            out[(label, y)] = val
    return out


def startup_outflows_by_month(inputs, assumptions, occupancy_y1) -> dict:
    """Map project-month int -> one-time startup cash outflow Decimal (Spec §5/§6).

    Scheduled costs land on their own month numbers (before or after opening); when
    no schedule is given the whole legacy lump lands on the opening month. The lease
    deposit + first month rent always lands at the opening month. The sum of this map
    equals ``startup_total`` (no double counting, no dropped startup).
    """
    g = inputs.opening_month_number
    lease_deposit = occupancy_y1 / 12 * 3
    by_month: dict = {}
    if inputs.cost_schedule:
        for item in inputs.cost_schedule:
            m = int(item["month"])
            by_month[m] = by_month.get(m, Decimal("0")) + D(str(item["amount"]))
    else:
        lump = sum((D(v) for v in assumptions.startup.values()), Decimal("0"))
        by_month[g] = by_month.get(g, Decimal("0")) + lump
    by_month[g] = by_month.get(g, Decimal("0")) + lease_deposit
    return by_month


def cost_schedule_totals(cost_schedule, *, building_sqft=None) -> dict:
    """Aggregate flat ``{category, month, amount}`` cost rows for the startup grid.

    A pure, read-only helper (decision #15): it never mutates the model and never
    persists. The engine stays the ONE cost-aggregation authority — this reuses the
    exact ``D(str(amount))`` Decimal idiom that ``compute_annual`` (per-category) and
    ``startup_outflows_by_month`` (per-month) already use, so the pre-Generate grid
    preview can never become a second math authority. Returns exact ``Decimal``
    aggregates; the server formats them with ``engine.money`` (the one format
    authority) as ``{raw, display}`` so the client renders but never sums.

    Returns a dict with:

    - ``by_category``: per-category row totals, insertion order preserved (grid rows).
    - ``by_month``: per-month column totals, ascending by month (grid columns).
    - ``grand_total``: sum of every amount.

    When ``cost_schedule`` is empty the seeded default schedule
    (``model.default_cost_schedule(building_sqft)``) is used so a no-rows preview
    shows the seeded startup grid; ``building_sqft`` ONLY scales that default
    fallback (it never alters caller-supplied rows) and defaults to the example's
    10,000 sq ft basis.
    """
    rows = list(cost_schedule)
    if not rows:
        sqft = model.EXAMPLE_BUILDING_SQFT if building_sqft is None else building_sqft
        rows = model.default_cost_schedule(sqft)

    by_category: dict = {}
    by_month: dict = {}
    grand = Decimal("0")
    for item in rows:
        amount = D(str(item["amount"]))
        category = item["category"]
        month = int(item["month"])
        by_category[category] = by_category.get(category, Decimal("0")) + amount
        by_month[month] = by_month.get(month, Decimal("0")) + amount
        grand += amount
    return {
        "by_category": by_category,
        "by_month": dict(sorted(by_month.items())),
        "grand_total": grand,
    }


def compute(inputs, assumptions=None, demand_drivers=None, trade_area=None, overrides=None):
    assumptions = assumptions or Assumptions()
    demand_drivers = demand_drivers or DemandDrivers()
    trade_area = trade_area or TradeArea()
    overrides = overrides or {}

    from engine import dag

    dag.validate_all(overrides)  # reject non-pinnable/derived/total/KPI pins server-side
    stale_nodes = sorted(dag.stale_upstream(overrides))

    years, startup, startup_total, occupancy = compute_annual(
        inputs, assumptions, demand_drivers, trade_area, overrides)

    from engine.monthly import build_monthly

    startup_by_month = startup_outflows_by_month(inputs, assumptions, occupancy[1])
    monthly_rows, breakeven = build_monthly(
        years[1], assumptions, inputs.opening_month_number, startup_by_month)

    result = ComputeResult(
        annual=years, startup=startup, startup_total=startup_total,
        occupancy=occupancy, inputs=inputs, assumptions=assumptions,
        trade_area=trade_area, overrides_applied=dict(overrides),
        monthly=monthly_rows, monthly_breakeven=breakeven,
        stale_nodes=stale_nodes,
    )

    from engine.decision import build_decision, build_flags

    result.flags = build_flags(result, assumptions, demand_drivers)
    result.decision = build_decision(
        result, inputs, assumptions, demand_drivers, trade_area, overrides, result.flags)

    from engine.viewmodel import to_view_model

    result.view_model = to_view_model(result)
    return result

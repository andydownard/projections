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

import math
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
    "Workers' comp expense",
    "Pest control",
    "POS platform",
    "Production software",
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
    # Model v3 — optional flat contributions revenue
    contributions_annual: str = model.CONTRIBUTIONS_ANNUAL
    # Optional within-year Year-1 revenue-share ramp (Task 1.3): a linear alternative
    # to the default S-curve (`_REVENUE_WEIGHTS`). Both must be set to activate it;
    # either left `None` (the default) reproduces today's S-curve, byte-identical.
    share_m1: str | None = None
    share_m12: str | None = None
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
    card_share: str = model.CARD_SHARE
    card_rate: str = model.CARD_RATE
    card_per_tx_fee: str = model.CARD_PER_TX_FEE
    payroll_tax_pct: str = model.PAYROLL_TAX_PCT_OF_PAYROLL
    workers_comp_pct: str = model.WORKERS_COMP_PCT_OF_PAYROLL
    salvage_pct: str = model.SALVAGE_PCT_OF_RETAIL
    escalator: str = model.RENT_ESCALATOR
    utilities_per_sqft: str = model.UTILITIES_PER_SQFT
    basket: str = model.AVG_BASKET_VALUE
    donations_per_hh: int = model.DONATIONS_PER_HH_PER_YEAR
    reserve_buffer: int = model.CASH_RESERVE_BUFFER
    # ± stress applied by the sensitivity scenarios (decision.py): downside stresses
    # rent ×(1+delta) / donations ×(1-delta), upside the reverse. Default 0.25 (§12.2)
    # reproduces the prior hard-coded 1.25/0.75 literals byte-for-byte.
    sensitivity_delta: str = model.SENSITIVITY_DELTA
    fixed_annual: dict = field(default_factory=lambda: dict(model.FIXED_ANNUAL))
    startup: dict = field(default_factory=lambda: dict(model.STARTUP))
    # --- production-station module (Model v3)
    avg_item_price: str = model.AVG_ITEM_PRICE
    sell_through: str = model.SELL_THROUGH
    items_per_hour: int = model.ITEMS_PER_HOUR
    productive_hours_per_station: int = model.PRODUCTIVE_HOURS_PER_STATION
    # --- labor_mode: pct | coverage (Model v3)
    labor_mode: str = model.LABOR_MODE
    open_hours_per_week: str = model.OPEN_HOURS_PER_WEEK
    cashier_tx_per_hour: str = model.CASHIER_TX_PER_HOUR
    min_staffed_lanes: str = model.MIN_STAFFED_LANES
    door_dedicated: str = model.DOOR_DEDICATED
    door_peak: str = model.DOOR_PEAK
    runners: str = model.RUNNERS
    wage: str = model.WAGE
    mgr_salary: str = model.MGR_SALARY
    am_salary: str = model.AM_SALARY
    am_count: int = model.AM_COUNT


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
    contributions: Decimal
    total_rev: Decimal
    expenses: dict           # label -> Decimal
    total_exp: Decimal
    net: Decimal
    margin: Decimal | None  # None when total_rev == 0 (§8)
    # --- production-station module (Model v3) — read-only derived metrics
    items_sold: Decimal
    items_produced: Decimal
    production_hours: Decimal


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
    stations_installed: int = 0     # ceil of the peak monthly stations_staffed


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


def _row_treatment(item) -> str:
    """Normalized cost-schedule row treatment (Model v3 Phase 2, Task 2.2).

    Absent/None/unrecognized -> ``"included"`` — the backward-compat anchor
    (every legacy row + every ``default_cost_schedule()`` row has no "treatment"
    key at all, so they keep counting toward capital exactly as today) that also
    fails SAFE for a live financial engine: a garbage value never silently drops
    a cost out of the capital-required total the way misclassifying it as
    "separate"/"contingent" would.
    """
    t = item.get("treatment")
    return t if t in model.COST_SCHEDULE_TREATMENTS else model.COST_SCHEDULE_DEFAULT_TREATMENT


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
        contributions = D(inputs.contributions_annual)
        total_rev = retail + salvage + contributions

        # --- production-station module (Model v3): read-only physical throughput
        # metrics, each explicitly zero-guarded (never a ZeroDivisionError).
        items_sold = (retail / D(assumptions.avg_item_price)
                      if D(assumptions.avg_item_price) != 0 else Decimal("0"))
        items_produced = (items_sold / D(assumptions.sell_through)
                          if D(assumptions.sell_through) != 0 else Decimal("0"))
        production_hours = (items_produced / D(assumptions.items_per_hour)
                            if D(assumptions.items_per_hour) != 0 else Decimal("0"))

        exp = {}
        exp["Credit card fees"] = _resolve_get(
            overrides, "Credit card fees", y,
            D(assumptions.card_share) * (
                D(assumptions.card_rate) * retail + D(assumptions.card_per_tx_fee) * customers))
        exp["Marketing & outreach"] = _resolve_get(
            overrides, "Marketing & outreach", y, total_rev * D(assumptions.marketing_pct))
        # labor_mode: pct (default, byte-unchanged) | coverage (headcount/wage-driven).
        # Coverage mode uses the YEAR'S AVERAGE MONTH (production_hours/12,
        # customers/12) — not the actual monthly-weighted ramp, since compute_annual
        # runs before build_monthly and depending on the real monthly ramp would be
        # circular (docs/plans/2026-08-03-model-v3-session-learnings.md Design Review).
        if assumptions.labor_mode == "coverage":
            open_hours_per_month = D(assumptions.open_hours_per_week) * 52 / 12
            production_hours_month = production_hours / 12
            transactions_month = customers / 12
            cashier_hours = max(
                transactions_month / D(assumptions.cashier_tx_per_hour)
                if D(assumptions.cashier_tx_per_hour) != 0 else Decimal("0"),
                D(assumptions.min_staffed_lanes) * open_hours_per_month,
            )
            door_hours = (
                (D(assumptions.door_dedicated) + D(assumptions.door_peak))
                * open_hours_per_month
            )
            runner_hours = D(assumptions.runners) * open_hours_per_month
            hourly_hours_month = (
                production_hours_month + cashier_hours + door_hours + runner_hours
            )
            salaries = (
                D(assumptions.mgr_salary)
                + D(str(assumptions.am_count)) * D(assumptions.am_salary)
            )
            payroll_calculated = (
                hourly_hours_month * D(assumptions.wage) * 12 + salaries
            )
        else:
            payroll_calculated = total_rev * D(assumptions.labor_pct)
        payroll = _resolve_get(overrides, "Payroll", y, payroll_calculated)
        exp["Payroll"] = payroll
        exp["Payroll taxes"] = _resolve_get(
            overrides, "Payroll taxes", y, payroll * D(assumptions.payroll_tax_pct))
        exp["Workers' comp expense"] = _resolve_get(
            overrides, "Workers' comp expense", y, payroll * D(assumptions.workers_comp_pct))
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
            retail=retail, customers=customers, salvage=salvage,
            contributions=contributions, total_rev=total_rev,
            expenses=ordered, total_exp=total_exp, net=net, margin=margin,
            items_sold=items_sold, items_produced=items_produced,
            production_hours=production_hours,
        )

    # one-time startup. A user cost_schedule (Spec §5) supersedes the legacy STARTUP
    # lump: the per-category breakdown is the schedule aggregated by category. The
    # lease deposit is always computed from rent_y1 (un-escalated) and added on top.
    if inputs.cost_schedule:
        startup: dict = {}
        for item in inputs.cost_schedule:
            # Model v3 Phase 2 (Task 2.2): only "included" rows count toward the
            # capital-required total — "separate"/"contingent" rows are funded
            # outside it (see engine.viewmodel's startupCostsSeparate/Contingent
            # and engine.xlsx's always-visible labeled sections for where they DO
            # surface).
            if _row_treatment(item) != "included":
                continue
            cat = item["category"]
            startup[cat] = startup.get(cat, Decimal("0")) + D(str(item["amount"]))
    else:
        startup = {k: D(v) for k, v in assumptions.startup.items()}
    # 3 months of monthly occupancy. Multiply-before-divide (occ1*3/12) keeps the
    # Decimal exact — occ1/12*3 divides first and yields e.g. 4712.4999… for occ1=18850
    # where the exact value is 4712.5 (2.7.0 numeric-discipline fix; property 4).
    startup["Lease Deposit + First Month Rent"] = occ1 * 3 / 12
    startup_total = sum(startup.values(), Decimal("0"))

    return years, startup, startup_total, occupancy


def cash_net(result, year: int) -> Decimal:
    """Displayed CASH net income for a year (epic #321 — the projection is cash-based).

    The one-time startup is a CASH outflow that hits when paid (Year 1): the displayed
    Year-1 net subtracts the whole ``startup_total``; Years 2-5 are operating net. This
    is the ONE definition every income-display surface (the 5-year row, the KPI, the
    incomeSeries, the card y1_net, the ``.xlsx`` Net-income Year-1 cell) sources from, so
    the displayed net and margin can never diverge. The INTERNAL operating net
    (``AnnualYear.net``) is unchanged and still drives the go/no-go verdict.
    """
    net = D(str(result.annual[year].net))
    return net - D(str(result.startup_total)) if year == 1 else net


def cash_margin(result, year: int) -> Decimal | None:
    """Displayed CASH net margin = ``cash_net / total_rev`` (congruent with cash_net).

    Both displayed numbers are cash-based and therefore AGREE — there is no second
    (operating) margin and no footnote. ``None`` (N/A) when revenue is 0 (§8 guard).
    """
    rev = D(str(result.annual[year].total_rev))
    return (cash_net(result, year) / rev) if rev != 0 else None


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
    lease_deposit = occupancy_y1 * 3 / 12  # exact: multiply-before-divide (2.7.0)
    by_month: dict = {}
    if inputs.cost_schedule:
        for item in inputs.cost_schedule:
            # Model v3 Phase 2 (Task 2.2): same included-only filter as
            # compute_annual's startup dict — a "separate"/"contingent" row never
            # lands in the monthly cash-flow trough either, so capital/cashGap
            # (which are derived from this map) stay excluded consistently.
            if _row_treatment(item) != "included":
                continue
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
    - ``separate`` / ``contingent`` (Model v3 Phase 2, Task 2.2): the SAME shape
      (``{by_category, grand_total}``, no ``by_month`` — these rows fund nothing
      in the monthly cash-flow grid) but aggregated from the rows EXCLUDED from
      the three keys above, so the always-visible "funded separately"/"contingent"
      sections have something to render. ``by_category``/``by_month``/
      ``grand_total`` above are "included"-only — this is the SAME filter
      ``compute_annual``/``startup_outflows_by_month`` apply, so this helper's
      idea of "capital-required" never drifts from the engine's.

    A row's ``treatment`` (absent/None/unrecognized -> "included") is read via
    ``_row_treatment`` — the ONE normalization every treatment-aware function in
    this module shares.

    When ``cost_schedule`` is empty the seeded default schedule
    (``model.default_cost_schedule(building_sqft)``) is used so a no-rows preview
    shows the seeded startup grid; ``building_sqft`` ONLY scales that default
    fallback (it never alters caller-supplied rows) and defaults to the example's
    10,000 sq ft basis. That legacy fallback schedule carries no "treatment" key
    on any row, so it is entirely "included" and the separate/contingent
    aggregates are empty in the no-rows case.
    """
    rows = list(cost_schedule)
    if not rows:
        sqft = model.EXAMPLE_BUILDING_SQFT if building_sqft is None else building_sqft
        rows = model.default_cost_schedule(sqft)

    by_category: dict = {}
    by_month: dict = {}
    grand = Decimal("0")
    separate_by_category: dict = {}
    separate_grand = Decimal("0")
    contingent_by_category: dict = {}
    contingent_grand = Decimal("0")
    for item in rows:
        amount = D(str(item["amount"]))
        category = item["category"]
        month = int(item["month"])
        treatment = _row_treatment(item)
        if treatment == "separate":
            separate_by_category[category] = (
                separate_by_category.get(category, Decimal("0")) + amount)
            separate_grand += amount
            continue
        if treatment == "contingent":
            contingent_by_category[category] = (
                contingent_by_category.get(category, Decimal("0")) + amount)
            contingent_grand += amount
            continue
        by_category[category] = by_category.get(category, Decimal("0")) + amount
        by_month[month] = by_month.get(month, Decimal("0")) + amount
        grand += amount
    return {
        "by_category": by_category,
        "by_month": dict(sorted(by_month.items())),
        "grand_total": grand,
        "separate": {"by_category": separate_by_category, "grand_total": separate_grand},
        "contingent": {"by_category": contingent_by_category, "grand_total": contingent_grand},
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
        years, assumptions, inputs, startup_by_month)

    # Peak production-station headcount across the WHOLE horizon (pre-open and
    # beyond-60-month extension rows are already stations_staffed=0, so they never
    # affect the max) — the ceiling of the peak monthly stations_staffed (Task 1.2).
    peak_staffed = max((row.stations_staffed for row in monthly_rows), default=Decimal("0"))
    stations_installed = math.ceil(peak_staffed) if peak_staffed > 0 else 0

    result = ComputeResult(
        annual=years, startup=startup, startup_total=startup_total,
        occupancy=occupancy, inputs=inputs, assumptions=assumptions,
        trade_area=trade_area, overrides_applied=dict(overrides),
        monthly=monthly_rows, monthly_breakeven=breakeven,
        stale_nodes=stale_nodes, stations_installed=stations_installed,
    )

    from engine.decision import build_decision, build_flags

    result.flags = build_flags(result, assumptions, demand_drivers)
    result.decision = build_decision(
        result, inputs, assumptions, demand_drivers, trade_area, overrides, result.flags)

    from engine.viewmodel import to_view_model

    result.view_model = to_view_model(result)
    return result

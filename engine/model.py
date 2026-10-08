"""Named constants — the single source of default values (ENGINE_CONTRACT §2).

No formula in the engine may hard-code a literal; it must reference a named
constant here. Money/percent literals are kept as strings or exact Decimals at
the point of use; these module constants name the *default* assumption values.
"""
from __future__ import annotations

MODEL_VERSION = "3.1.0"          # math change => bump. 3.1.0 (owner 2026-10-08): monthly
# Net and Revenue never drop after opening while the annual totals grow. Each year's
# monthly shape (Year 1's S-curve or linear share ramp + payroll ramp; Years 2-5's
# glide) is eased toward its own flat average by the smallest amount that keeps its
# LAST month at or below the NEXT year's monthly average (`engine.monthly._ease_weight`),
# which makes a rising path possible. Annual totals are unchanged; Year 1's monthly
# shape is flatter, so capital / break-even / first-year cash gap move. Years 2-5 now
# shape Net directly; monthly expense = revenue - net. (Built as 2.10.0 on the 2.9.0
# engine, rebased onto 3.0.0 before it shipped.)
#
# 3.0.0 = MODEL V3 (owner
# session 2026-08-03): four Year-1-affecting cost/revenue formula replacements plus
# three new lines, bundled under one bump. (1) Credit card fees moves from a flat
# 2%-of-revenue line to a two-term formula: card_share x (card_rate x retail +
# card_per_tx_fee x transactions) — CARD_SHARE/CARD_RATE/CARD_PER_TX_FEE replace the
# deleted CARD_FEES_PCT_OF_REVENUE constant. (2) A new production-station module adds
# read-only derived metrics (items_sold -> items_produced -> production_hours ->
# stations_staffed (monthly) -> stations_installed) bridging retail $ to a
# staffing/space count; non-pinnable, do not feed total_rev/total_exp. (3) Year-1
# monthly revenue can optionally ride a linear share_m1->share_m12 ramp instead of the
# default S-curve (Inputs.share_m1/share_m12, both None by default => byte-identical).
# (4) labor_mode: "pct" (default, today's total_rev x labor_pct formula, byte-
# unchanged) or "coverage" (headcount/wage-driven: hourly production+cashier+door+
# runner hours x wage, plus flat manager/assistant-manager salaries; uses the year's
# average month since compute_annual runs before build_monthly); break_even_revenue's
# var_rate drops the labor term under coverage mode so it isn't double-modeled. Three
# new lines, always on: POS platform ($400/mo) + Production software ($100/mo) join
# FIXED_ANNUAL; Workers' comp expense (2% of payroll) rides the payroll ramp
# (_PAYROLL_WEIGHTS), not the flat fixed residual; Contributions revenue is an
# optional flat annual add to total_rev (default 0 => byte-unchanged). All five golden
# fixtures move because card fees, POS platform, Production software, and Workers'
# comp are always-on; production-station/share-ramp/labor_mode are additive-with-
# defaults and do not move any fixture on their own. See
# docs/plans/2026-08-03-model-v3-session-learnings.md and DECISIONS.md 3.0.0 entry.
#
# 2.9.0 fixes an owner defect
# (2026-07-05): Years 2-5 of monthly[] used to jump INSTANTLY from the prior year's
# S-curve/ramp exit rate to the new year's flat annual average — an artificial
# one-month "cliff" in the Net line with no cost event behind it. Years 2-5 now GLIDE
# from the prior year's own last month toward the new flat average over
# `engine.monthly._BLEND_MONTHS` months before holding flat (`_blend_then_flat`,
# replacing the old uniform-1/12 `_distribute` call) — annual totals, capital,
# break-even, and Year 1 itself are all BYTE-UNCHANGED (only the Years 2-5 intra-year
# shape moved); see engine/monthly.py module docstring for why a full "net never
# decreases" guarantee isn't mathematically achievable while Year 1 keeps its S-curve.
# 2.8.0 = THE FUSION of two
# independently-stamped 2.7.0 engines (see the both-lineages block below). Composition:
# the DISPLAY layer is CASH-BASED (lineage A) and the OPERATING layer uses this branch's
# 6.2 Year-1 monthly split (lineage B). The DISPLAYED Net income AND Net margin subtract the
# one-time Year-1 startup and are congruent (cash_net[1]=operating_net[1]−startup_total,
# cash_net[y>=2]=operating_net[y], net_margin[y]=cash_net[y]/total_rev[y]); the INTERNAL
# operating net (AnnualYear.net) is UNCHANGED and still drives the verdict (_recommend gates,
# simple_payback, sensitivity re-runs, monthly operating roll-up). monthly[] spans the full
# 60-month horizon; Year-1 uses the 6.2 three-stream split (fixed flat 1/12, payroll+taxes on
# the payroll ramp, %-of-revenue on revenue weights), Years 2–5 uniform 1/12; every year rolls
# up to the penny. capital / break-even / first-year cash gap are Year-1-anchored and computed
# ON the 6.2 distribution. payback = first project-month cumulative cash >= 0 after going
# negative ("Month N") over the 60-month series. The §12.2 net-margin guardrail runs on the
# DISPLAYED (cash) margin. 990-grounded constants (PAYROLL_TAX_PCT_OF_PAYROLL 8%, Insurance
# $10k), the 6.3 advisory flags + break_even_revenue guard (OPERATING-layer), money_view
# single-rounding-authority, exact lease-deposit arithmetic, and the conservative NNN
# resolved-occupancy reading all carry over. The .xlsx Year-1 Net-income cell subtracts the
# Total Startup Costs cell; the "Simple payback (years)" cell is removed (payback rides the
# MILESTONES Month-N row).
#
# --- 2.7.0-A (DEPLOYED to prod as "2.7.0", epic #321): the projection is CASH-BASED — no
# amortization, no capitalization. The one-time startup is a CASH outflow that hits when paid
# (Year 1, at/around opening). The DISPLAYED Net income and Net margin are BOTH cash-based and
# congruent. The INTERNAL operating net drives the verdict. The monthly model spans the full
# 60-month horizon so PAYBACK resolves across years. The §12.2 net-margin guardrail runs on
# the DISPLAYED (cash) margin. The .xlsx Year-1 Net-income cell subtracts Total Startup Costs;
# the "Simple payback (years)" cell is removed (payback via the MILESTONES Month-N row).
#
# --- 2.7.0-B (this branch's pre-fusion state, NEVER deployed, also stamped "2.7.0"): the
# Wave-6 close-out carrying every output-moving change across Tasks 6.1–6.4: (6.1) advisory-flag
# scaffolding; (6.2) the monthly cash-flow SPLIT — fixed operating costs charged flat across the
# 12 operating months, payroll taxes on the payroll ramp — reshaping the Year-1 trough → capital
# / break-even; (6.3) override-aware occupancy/labor/sales-per-sqft advisory flags + the
# break_even_revenue "N/A — variable-cost rate ≥ 100%" guard; (6.4) 990-grounded constants
# (PAYROLL_TAX_PCT_OF_PAYROLL 7.5%->8%, FIXED_ANNUAL Insurance $2,000->$10,000), the money_view
# single-rounding-authority, the exact lease-deposit arithmetic (occ1*3/12), and NNN resolved to
# the resolved occupancy INCLUDING nnn_opex_annual (conservative reading; DECISIONS.md).
#
# 2.6.0: the ANNUAL P&L
# extends from a 3-year to a 5-year horizon — Year 4 / Year 5 are driven by their own
# explicit donor-share inputs (share_y4 / share_y5) through the SAME driver chain and
# the existing compounding rent escalator; the revenue CAGR is now Y1->Y5 and the
# §12.2 share/net-margin guardrails also check Y4/Y5. The monthly S-curve cash-flow
# and the decision metrics (capital, break-even month, first-year cash gap) stay
# Year-1-anchored and are byte-unchanged. The "Net profit" row/KPI/xlsx line is
# renamed "Net income" everywhere. The donation drivers (donationValue, basket,
# donationsPerHouseholdPerYear) are surfaced as editable settings;
# 2.5.0: the Utilities/
# trash service line stops being a flat fixed-$ and is DERIVED as UTILITIES_PER_SQFT ×
# building_sqft (feature #245) — same existing pinnable line/slot, now sq-ft-scaled;
# the default cost-schedule seed scales Equipment & Fixtures + Build-out per sq ft.
# Both are ANCHORED so 10,000 sq ft reproduces today's literals byte-for-byte;
# 2.4.0: first_year_cash_gap is scoped STRICTLY to the operating Year-1 window G..G+11,
# so a scheduled cost beyond G+11 no longer leaks its deeper trough into the first-year
# headline (#182); cash_runway_months ignores leading zero-cost pre-opening months
# instead of trivially reporting 1 (#184); 2.3.0: downside sensitivity rent stress is
# applied to the RESOLVED occupancy — rent_per_sqft and nnn opex are now stressed too,
# not just occupancy_annual (#181); 2.2.0: multi-month pre-opening timeline + scheduled
# costs + recomputed metrics + 3 milestones)
# view-model shape changes => bump (1.1.0: +sales/sqft, occupancy & labor ratio
# KPIs; 1.2.0: +milestones{grandOpening,breakEven,payback} {raw,display}, payback-
# period KPI replaces simple-payback-years, monthly[]+scheduledCosts; 1.3.0:
# +settings.utilitiesPerSqft + settings.rentPerSqft (additive scalars, feature #245);
# 1.4.0: every annual row carries y4/y5 cells; settings gain shareY4/shareY5 plus the
# editable donation drivers donationValue/basket/donationsPerHouseholdPerYear; the KPI
# strip + xlsx line read "Net income" (was "Net profit"); +incomeSeries (annual net
# income Y1..Y5 {raw,display}) and +year5Income for the list/detail sparkline;
# 1.5.0: +startupCosts (one-time startup line items as [{category, amount{raw,display}}])
# and +startupTotal {raw,display} for the Board Packet .docx startup-costs table (EPIC
# DOCX) — additive shape change, no math change (MODEL_VERSION stays 2.6.0);
# 1.7.0: THE FUSION — the union of both 1.6.0 lineages:
#   1.6.0-B (this branch): +sensitivity{base,downside,upside}{net{raw,display}, breakeven
#     int|None, capital{raw,display}} + sensitivity.delta and +confidence{ramp} — surfacing the
#     §12.2 ±stress scenarios and the ramp low-confidence flag decision.py already computes but
#     the view-model previously dropped (audit P0); settings gain the full editable knob set
#     sensitivityDelta, fixedAnnual (label->annual-$), nnnOpexAnnual, buildingSqft, salesfloorPct.
#   1.6.0-A (deployed): the displayed Net income (row + KPI + incomeSeries[0] + year5Income +
#     card y1_net) and Net margin (row + KPI) are CASH-based (Year-1 subtracts the one-time
#     startup total); monthly[] grows from 12 to 60 rows (full horizon) so the cash-flow series
#     spans the payback crossing; payback is the Month-N cash-recovery milestone.
# The NUMBERS move with model 2.8.0, so this rides the single fusion regeneration.)
# 1.9.0: Model v3 Phase 2, Task 2.2 — cost-schedule rows gain a "treatment"
# (included|separate|contingent) + "note" field. Math filtering: compute_annual's
# startup aggregation, startup_outflows_by_month, and cost_schedule_totals now all
# skip non-"included" rows (absent/None treatment defaults to "included" — every
# existing projection's cost_schedule either has no rows or rows with no
# "treatment" key at all, so startup/startup_total/capital/first_year_cash_gap are
# BYTE-IDENTICAL). View-model gains +startupCostsSeparate/+startupCostsContingent
# (same [{category, amount{raw,display}, note}] shape as startupCosts), always
# present (empty list when nothing is marked non-included) so a reader never
# wonders whether a section was silently dropped. cost_schedule_totals gains
# +"separate"/+"contingent" aggregate keys ({by_category, grand_total}) alongside
# the existing included-only by_category/by_month/grand_total. MODEL_VERSION stays
# 3.0.0 (settings/shape-only, matching the sensitivity_delta/utilitiesPerSqft
# precedent).
# 1.8.0: Model v3 (see MODEL_VERSION 3.0.0 above) — new settings keys (card_share/
# card_rate/card_per_tx_fee, avg_item_price/sell_through/items_per_hour/
# productive_hours_per_station, share_m1/share_m12, labor_mode + coverage-mode
# fields, workers_comp_pct, contributions_annual) and new view-model rows/fields
# (Items sold/Items produced/Production hours rows, stationsInstalled, Contributions
# row, leadership_coverage_advisory flag).
COMPUTE_SCHEMA_VERSION = "1.9.0"

# --- export trust copy (#192). Single source for the "planning estimates, not
# advice" disclaimer + AI-narrative disclosure that the terms gate exists to
# protect. Lives in the engine (the format authority) so BOTH the server-rendered
# Board Packet (app/packet.py) and the formula-driven .xlsx (engine/xlsx.py) stamp
# the SAME words — the caveat can never be stripped from the artifact a board reads.
TERMS_VERSION = "1.0"             # app/terms.py re-exports this (one version source)
EXPORT_DISCLAIMER = (
    "These figures are planning estimates, not financial, legal, or investment "
    "advice. They are model projections built from assumptions that may not hold; "
    "verify independently before making funding or lease commitments."
)
AI_NARRATIVE_DISCLOSURE = (
    "Narrative drafted with AI assistance; every figure is grounded in the model."
)
# Model v3 Phase 3 (Task 3.1): the client-copy export variant's disclaimer — plain,
# neutral, and DELIBERATELY not EXPORT_DISCLAIMER's wording (that string reads as an
# internal legal caveat; this one reads as an ordinary planning note a board/funder
# reads without a second thought). Single source for BOTH the client-copy `.xlsx`
# (engine/xlsx.py) and the client-copy packet (app/packet.py) so the two artifacts
# never drift on the exact wording.
CLIENT_COPY_DISCLAIMER = (
    "Planning estimates based on currently available information and operating "
    "benchmarks; amounts will be refined as actual costs are confirmed."
)

# --- demand engine
DONATIONS_PER_HH_PER_YEAR = 3        # §7.3
AVG_BASKET_VALUE = "17.08"           # §7.3 (resolved §1) -> customers
SALVAGE_PCT_OF_RETAIL = "0.008"      # §7.3 (0.8%)
# Methodology seed for the average donated-goods value per donation — NOT observable
# in the six-EIN 990 sample (docs/2026-07-03-owner-deliverables.md §2 marks the demand
# chain "not observable"; the $74 is a 2013-dollar literature value — CPI vintage-
# stamping is backlog item 4 there). The single source the E2E seed + engine-parity FE
# draft reference. The wizard's user-facing default is a deliberately-conservative $50
# (Owner Decision 4 / W15), distinct from this constant.
DEFAULT_DONATION_VALUE = "74"

# --- cost structure (% of total revenue unless noted)
LABOR_PCT_OF_REVENUE = "0.60"        # §7.3 owner decision (DECISIONS.md) — band 0.25–0.60
MARKETING_PCT_OF_REVENUE = "0.0375"  # §7.3 — NEW line
SUPPLIES_PCT_OF_REVENUE = "0.05"     # §7.3 — REPLACES fixed "Store/office supplies"
# Card-processor formula (Model v3 — card fees, owner session 2026-08-03):
# fees = card_share × (card_rate × retail + per_tx_fee × transactions)
CARD_SHARE = "0.65"                  # % of retail sales processed via card (vs. cash)
CARD_RATE = "0.026"                  # effective rate on card volume (2.6%)
CARD_PER_TX_FEE = "0.10"             # per-transaction fee ($0.10)
PAYROLL_TAX_PCT_OF_PAYROLL = "0.08"  # §7.3; 990-grounded (6.4) — employer payroll-tax
# load across the six-EIN sample (docs/2026-07-03-owner-deliverables.md); was 7.5%.

# --- production-station module (Model v3, owner session 2026-08-03). Physical
# throughput chain bridging retail $ to a staffing/space count: items_sold (retail /
# avg_item_price) -> items_produced (items_sold / sell_through, the fraction of
# processed goods that actually sell) -> production_hours (items_produced /
# items_per_hour) -> stations_staffed (production_hours / productive_hours_per_station,
# monthly) -> stations_installed (ceil of the peak monthly stations_staffed). Read-only
# derived metrics; they do not feed back into total_rev/total_exp in this task.
WORKERS_COMP_PCT_OF_PAYROLL = "0.02" # Model v3 — workers' comp as % of payroll
AVG_ITEM_PRICE = "5.00"              # $ per item sold at retail
SELL_THROUGH = "0.50"                # fraction of produced/processed items that sell
ITEMS_PER_HOUR = 75                  # items processed per production labor-hour
PRODUCTIVE_HOURS_PER_STATION = 160   # productive hours one production station covers/mo

# --- labor_mode: pct | coverage (Model v3, owner session 2026-08-03). "pct" (the
# default) is today's total_rev × labor_pct formula, byte-unchanged. "coverage" is a
# headcount/wage-driven alternative: hourly staff (production + cashier + door +
# runner hours, each a max()/sum() of coverage-band terms) × wage, plus flat manager +
# assistant-manager salaries. Uses the YEAR'S AVERAGE MONTH (annual/12) for
# production_hours/customers, not the actual monthly-weighted ramp — compute_annual
# runs before build_monthly, so depending on the real monthly ramp would be circular
# (see docs/plans/2026-08-03-model-v3-session-learnings.md Design Review). The
# existing Payroll-ramp monthly split (_PAYROLL_WEIGHTS) is unchanged either way.
LABOR_MODE = "pct"
OPEN_HOURS_PER_WEEK = "60"           # store open hours/week (coverage mode)
CASHIER_TX_PER_HOUR = "22"           # transactions one cashier can process/hour
MIN_STAFFED_LANES = "1.5"            # minimum staffed checkout lanes at all times
DOOR_DEDICATED = "1.0"               # dedicated donation-door staff (FTE-equivalent)
DOOR_PEAK = "0.25"                   # additional peak-hours donation-door coverage
RUNNERS = "1.5"                      # floor/backroom runners (FTE-equivalent)
WAGE = "15.00"                       # hourly wage, coverage mode
MGR_SALARY = "55000"                 # store manager annual salary
AM_SALARY = "42000"                  # assistant manager annual salary
AM_COUNT = 2                         # assistant manager headcount

# --- occupancy
# --- revenue (optional additions)
CONTRIBUTIONS_ANNUAL = "0"            # optional annual contributions (Model v3)

RENT_ESCALATOR = "0.03"              # §7.3 — compound, Y2–Y3 (resolved §1)

# --- sq-ft scaling basis (feature #245). The example store is 10,000 sq ft; the
# per-sq-ft constants below are the example's literal dollar figures divided by it,
# so each one × EXAMPLE_BUILDING_SQFT reproduces today's literal EXACTLY (the anchor
# invariant that keeps every 10k golden byte-identical). No engine formula hard-codes
# the literal; it references these named constants.
EXAMPLE_BUILDING_SQFT = 10000        # reference/.../house_of_hope.json sqft
UTILITIES_PER_SQFT = "2.23"          # 22,300 / 10,000  (utilities/trash, $/sqft/yr)
FIXTURES_PER_SQFT = "4.50"           # 45,000 / 10,000  (Equipment & Fixtures, $/sqft)
BUILDOUT_PER_SQFT = "5.00"           # 50,000 / 10,000  (Build-out / Renovations / TI)
DEFAULT_RENT_PER_SQFT = "12.00"      # AI-off manual default — 120,000 / 10,000 (golden parity)

# --- fixed annual operating $ (not %-based); "Store/office supplies" REMOVED, and
# "Utilities/trash service" is NO LONGER here — it is derived from UTILITIES_PER_SQFT
# × building_sqft in compute (feature #245), keeping its same pinnable line + slot.
FIXED_ANNUAL = {
    "Insurance liability": 10000,  # 990-grounded (6.4) — six-EIN sample; was $2,000
    "Internet, Phones": 3000,
    "Pest control": 300,
    "POS platform": 4800,          # $400/mo (Model v3)
    "Production software": 1200,   # $100/mo (Model v3)
    "Repairs/maintenance": 1600,
    "Security system": 900,
}

# --- one-time startup (Year 0). Lease deposit is computed, not a literal. Equipment
# & Fixtures / Build-out are the per-sq-ft anchor source: at EXAMPLE_BUILDING_SQFT they
# equal FIXTURES_PER_SQFT/BUILDOUT_PER_SQFT × sqft (the default cost-schedule seed scales
# them; this no-schedule lump stays at the example basis).
STARTUP = {
    "Thrift Store Consultant": 100000,
    "Equipment & Fixtures": 45000,
    "Build-out / Renovations / Tenant Improvements": 50000,
    "Legal, Permits, Insurance Setup, Signage": 13500,
}

# --- timed cost schedule + opening anchor (Spec §5/§7; epic:wizard W1)
# The opening anchor: the project month (>=1) grand opening lands on. The default
# anchor (and the legacy/seeded backfill) is month 1 — grand opening at month 1
# with the whole startup lump on month 1 means no pre-opening months, reproducing
# today's numbers exactly (NOT a special engine mode, just where the rows land).
DEFAULT_OPENING_MONTH_NUMBER = 1


def _scaled_dollars(per_sqft: str, building_sqft) -> int | float:
    """``per_sqft × building_sqft`` as a whole-dollar int when integral, else float.

    Whole-dollar seeds stay ``int`` so the no-arg (10,000 sq ft) default is
    byte-identical to the frozen migration literal (``"amount": 45000``, not
    ``45000.0``) and ``json.dumps`` of the default matches it.
    """
    from decimal import Decimal

    amt = Decimal(str(per_sqft)) * Decimal(str(building_sqft))
    return int(amt) if amt == amt.to_integral_value() else float(amt)


def default_cost_schedule(building_sqft=EXAMPLE_BUILDING_SQFT) -> list[dict]:
    """The legacy/migration-default timed cost schedule (feature #245).

    Places every line at month 1 — a single lump at opening — the backfill for
    projections without a schedule (legacy rows + the seeded example). Equipment &
    Fixtures and Build-out scale with ``building_sqft`` (``FIXTURES_PER_SQFT`` /
    ``BUILDOUT_PER_SQFT`` × sqft); the Consultant + Legal lines stay flat. The
    default ``building_sqft`` is the example's 10,000 sq ft so a no-arg call (the
    legacy/migration backfill) reproduces today's literals EXACTLY and never drifts.
    """
    amounts = {
        "Thrift Store Consultant": STARTUP["Thrift Store Consultant"],
        "Equipment & Fixtures": _scaled_dollars(FIXTURES_PER_SQFT, building_sqft),
        "Build-out / Renovations / Tenant Improvements": _scaled_dollars(
            BUILDOUT_PER_SQFT, building_sqft),
        "Legal, Permits, Insurance Setup, Signage": STARTUP[
            "Legal, Permits, Insurance Setup, Signage"],
    }
    return [
        {"category": category, "month": DEFAULT_OPENING_MONTH_NUMBER, "amount": amount}
        for category, amount in amounts.items()
    ]


# --- Model v3 — cost-schedule lines (Phase 2, startup-cost generator)
POS_LANE_COST = 3000                    # per-lane POS hardware/setup
POS_LANE_COUNT_DEFAULT = 4              # default lane count for startup
PRODUCTION_STATION_COST = 2500          # per-station production-area equipment
PRE_OPENING_HIRING_TRAINING_PAYROLL = 20000  # pre-opening labor costs
UTILITIES_SECURITY_DEPOSITS_SETUP = 3000    # utility deposits + security system setup


def default_cost_schedule_v3(
    building_sqft=EXAMPLE_BUILDING_SQFT, stations_installed=0
) -> list[dict]:
    """The NEW-PROJECTION-ONLY default cost schedule (Model v3, Phase 2).

    Distinct from `default_cost_schedule()` (the untouched legacy/migration anchor —
    NEVER call this function from a recompute/PATCH/restore/Penny-edit path on an
    EXISTING projection; only from genuinely-new-projection creation). Same 4 legacy
    rows (Consultant reclassified to "separate") plus 4 new Model-v3 rows, every row
    carrying a "treatment" key.
    """
    return [
        {
            "category": "Thrift Store Consultant",
            "month": DEFAULT_OPENING_MONTH_NUMBER,
            "amount": STARTUP["Thrift Store Consultant"],
            "treatment": "separate",
            "note": (
                "Handled under a separate consulting agreement — attach the signed "
                "proposal for the actual figure once available."
            ),
        },
        {
            "category": "Equipment & Fixtures",
            "month": DEFAULT_OPENING_MONTH_NUMBER,
            "amount": _scaled_dollars(FIXTURES_PER_SQFT, building_sqft),
            "treatment": "included",
        },
        {
            "category": "Build-out / Renovations / Tenant Improvements",
            "month": DEFAULT_OPENING_MONTH_NUMBER,
            "amount": _scaled_dollars(BUILDOUT_PER_SQFT, building_sqft),
            "treatment": "included",
        },
        {
            "category": "Legal, Permits, Insurance Setup, Signage",
            "month": DEFAULT_OPENING_MONTH_NUMBER,
            "amount": STARTUP["Legal, Permits, Insurance Setup, Signage"],
            "treatment": "included",
        },
        {
            "category": "POS checkout lanes",
            "month": DEFAULT_OPENING_MONTH_NUMBER,
            "amount": POS_LANE_COST * POS_LANE_COUNT_DEFAULT,
            "treatment": "included",
        },
        {
            "category": "Production stations",
            "month": DEFAULT_OPENING_MONTH_NUMBER,
            "amount": PRODUCTION_STATION_COST * stations_installed,
            "treatment": "included",
        },
        {
            "category": "Pre-opening hiring & training payroll",
            "month": DEFAULT_OPENING_MONTH_NUMBER,
            "amount": PRE_OPENING_HIRING_TRAINING_PAYROLL,
            "treatment": "included",
        },
        {
            "category": "Utilities/security deposits & setup",
            "month": DEFAULT_OPENING_MONTH_NUMBER,
            "amount": UTILITIES_SECURITY_DEPOSITS_SETUP,
            "treatment": "included",
        },
    ]


# --- Model v3 Phase 2, Task 2.2: the cost-schedule row "treatment" enum. The ONE
# source of truth for the value set — the app layer (CostScheduleItemIn) and the
# engine (compute_annual / startup_outflows_by_month / cost_schedule_totals) both
# import this rather than re-declaring the 3 strings. A row whose "treatment" key
# is absent/None (every legacy row + every default_cost_schedule() row) defaults to
# "included" for filtering purposes — see COST_SCHEDULE_DEFAULT_TREATMENT.
COST_SCHEDULE_TREATMENTS = frozenset({"included", "separate", "contingent"})
COST_SCHEDULE_DEFAULT_TREATMENT = "included"


# --- capital & cash
CASH_RESERVE_BUFFER = 25000          # §7.3 / §12.1
# §12.2 ±25% stress on rent & donations. Single source: it is the default of
# Assumptions.sensitivity_delta, and decision.py derives the downside/upside
# multipliers ((1±delta)) from it — no longer a dead constant shadowed by hard-coded
# 1.25/0.75 literals (the "documents a value nothing reads" docstring violation).
SENSITIVITY_DELTA = "0.25"

# --- guardrail advisory bands (§12.2)
SHARE_Y1_BAND_MAX = "0.08"           # donor market share ≤ ~8% for a new store
NET_MARGIN_FLAG_MAX = "0.30"         # flag > ~30% as unusual for a new store
OCCUPANCY_RATIO_BAND_MAX = "0.20"
# labor (payroll/revenue) advisory band — mirrors the LABOR_PCT_OF_REVENUE comment
# above ("band 0.25-0.60"); Task 6.3 turns that documented band into a real flag.
LABOR_RATIO_BAND_MIN = "0.25"
LABOR_RATIO_BAND_MAX = "0.60"
SALES_PER_SQFT_MIN = 50              # advisory band, Year-1 revenue / salesfloor sqft
SALES_PER_SQFT_MAX = 300

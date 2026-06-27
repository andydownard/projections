"""Named constants — the single source of default values (ENGINE_CONTRACT §2).

No formula in the engine may hard-code a literal; it must reference a named
constant here. Money/percent literals are kept as strings or exact Decimals at
the point of use; these module constants name the *default* assumption values.
"""

MODEL_VERSION = "2.3.0"          # math/shape change => bump (2.3.0: downside
# sensitivity rent stress is applied to the RESOLVED occupancy — rent_per_sqft and
# nnn opex are now stressed too, not just occupancy_annual (#181); 2.2.0: multi-month
# pre-opening timeline + scheduled costs + recomputed metrics + 3 milestones)
# view-model shape changes => bump (1.1.0: +sales/sqft, occupancy & labor ratio
# KPIs; 1.2.0: +milestones{grandOpening,breakEven,payback} {raw,display}, payback-
# period KPI replaces simple-payback-years, monthly[]+scheduledCosts)
COMPUTE_SCHEMA_VERSION = "1.2.0"

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

# --- demand engine
DONATIONS_PER_HH_PER_YEAR = 3        # §7.3
AVG_BASKET_VALUE = "17.08"           # §7.3 (resolved §1) -> customers
SALVAGE_PCT_OF_RETAIL = "0.008"      # §7.3 (0.8%)

# --- cost structure (% of total revenue unless noted)
LABOR_PCT_OF_REVENUE = "0.60"        # §7.3 owner decision (DECISIONS.md) — band 0.25–0.60
MARKETING_PCT_OF_REVENUE = "0.0375"  # §7.3 — NEW line
SUPPLIES_PCT_OF_REVENUE = "0.05"     # §7.3 — REPLACES fixed "Store/office supplies"
CARD_FEES_PCT_OF_REVENUE = "0.02"    # §7.3
PAYROLL_TAX_PCT_OF_PAYROLL = "0.075"  # §7.3

# --- occupancy
RENT_ESCALATOR = "0.03"              # §7.3 — compound, Y2–Y3 (resolved §1)

# --- fixed annual operating $ (not %-based); "Store/office supplies" REMOVED.
FIXED_ANNUAL = {
    "Insurance liability": 2000,
    "Internet, Phones": 3000,
    "Pest control": 300,
    "Repairs/maintenance": 1600,
    "Security system": 900,
    "Utilities/trash service": 22300,
}

# --- one-time startup (Year 0). Lease deposit is computed, not a literal.
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


def default_cost_schedule() -> list[dict]:
    """The legacy/migration-default timed cost schedule, derived from ``STARTUP``.

    Places every fixed ``STARTUP`` line at month 1 — a single lump at opening. This
    is the backfill for projections without a schedule (legacy rows + the seeded
    example) and reproduces today's numbers exactly (Spec §7). Derived from
    ``STARTUP`` so the migration backfill and the engine default never drift.
    """
    return [
        {"category": category, "month": DEFAULT_OPENING_MONTH_NUMBER, "amount": amount}
        for category, amount in STARTUP.items()
    ]


# --- capital & cash
CASH_RESERVE_BUFFER = 25000          # §7.3 / §12.1
SENSITIVITY_DELTA = "0.25"           # §12.2 ±25% on rent & donations

# --- guardrail advisory bands (§12.2)
SHARE_Y1_BAND_MAX = "0.08"           # donor market share ≤ ~8% for a new store
NET_MARGIN_FLAG_MAX = "0.30"         # flag > ~30% as unusual for a new store
OCCUPANCY_RATIO_BAND_MAX = "0.20"

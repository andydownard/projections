"""Named constants — the single source of default values (ENGINE_CONTRACT §2).

No formula in the engine may hard-code a literal; it must reference a named
constant here. Money/percent literals are kept as strings or exact Decimals at
the point of use; these module constants name the *default* assumption values.
"""

MODEL_VERSION = "2.1.0"          # math changes => bump (2.1.0: capital double-count fix)
COMPUTE_SCHEMA_VERSION = "1.1.0"  # view-model shape changes => bump (1.1.0: +sales/sqft, occupancy & labor ratio KPIs)

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

# --- capital & cash
CASH_RESERVE_BUFFER = 25000          # §7.3 / §12.1
SENSITIVITY_DELTA = "0.25"           # §12.2 ±25% on rent & donations

# --- monthly ramp (calibration backlog — low-confidence, §12.5)
RAMP_MONTHS = 5
RAMP_CURVE = "logistic"
DONATION_TO_REVENUE_LAG_MONTHS = 1

# --- guardrail advisory bands (§12.2)
SHARE_Y1_BAND_MAX = "0.08"           # donor market share ≤ ~8% for a new store
NET_MARGIN_FLAG_MAX = "0.30"         # flag > ~30% as unusual for a new store
LABOR_RATIO_BAND = ("0.25", "0.60")
OCCUPANCY_RATIO_BAND_MAX = "0.20"

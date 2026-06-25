"""engine/model.py — named constants + version stamps (ENGINE_CONTRACT §2/§3).

PURE module: no openpyxl / python-docx / network / filesystem / clock imports.
This is the single source of the resolved-default constants. No formula elsewhere
may hard-code a literal; it must reference a named constant here.

Labor is pinned to 0.60 by owner decision (DECISIONS.md / ENGINE_CONTRACT §1).
The 40% design-parity fixture lives alongside the 60% canonical golden; moving the
DEFAULT is a NEW model_version with regenerated goldens in the same change.
"""
from __future__ import annotations

MODEL_VERSION = "2.0.0"           # math changes => bump
COMPUTE_SCHEMA_VERSION = "1.0.0"  # view-model shape changes => bump

# --- demand engine
DONATIONS_PER_HH_PER_YEAR = 3       # §7.3
AVG_BASKET_VALUE = 17.08            # §7.3 (resolved §1)
SALVAGE_PCT_OF_RETAIL = 0.008       # §7.3 (0.8%)

# --- cost structure (% of total revenue unless noted)
LABOR_PCT_OF_REVENUE = 0.60         # owner decision (DECISIONS.md) — band 0.25–0.60
MARKETING_PCT_OF_REVENUE = 0.0375   # NEW line
SUPPLIES_PCT_OF_REVENUE = 0.05      # REPLACES fixed "Store/office supplies"
CARD_FEES_PCT_OF_REVENUE = 0.02
PAYROLL_TAX_PCT_OF_PAYROLL = 0.075

# --- occupancy
RENT_ESCALATOR = 0.03               # compound, Y2–Y3 (resolved §1)

# --- fixed annual operating $ (not %-based); "Store/office supplies" REMOVED
FIXED_ANNUAL = {
    "Insurance liability": 2000,
    "Internet, Phones": 3000,
    "Pest control": 300,
    "Repairs/maintenance": 1600,
    "Security system": 900,
    "Utilities/trash service": 22300,
}

# --- one-time startup (Year 0); lease deposit computed from rent, not a literal
STARTUP = {
    "Thrift Store Consultant": 100000,
    "Equipment & Fixtures": 45000,
    "Build-out / Renovations / Tenant Improvements": 50000,
    "Legal, Permits, Insurance Setup, Signage": 13500,
}

# --- capital & cash
CASH_RESERVE_BUFFER = 25000         # §7.3 / §12.1
SENSITIVITY_DELTA = 0.25            # §12.2 ±25% on rent & donations

# --- monthly ramp (calibration backlog — emitted low-confidence, §12.5)
RAMP_MONTHS = 5
RAMP_CURVE = "logistic"
DONATION_TO_REVENUE_LAG_MONTHS = 1

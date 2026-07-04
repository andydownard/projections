"""RED first: named constants for the engine (ENGINE_CONTRACT §2)."""
from decimal import Decimal

from engine import model


def test_model_versions_stamped():
    # 2.8.0 = THE FUSION of two 2.7.0 lineages: DISPLAY layer cash-based (2.7.0-A, deployed —
    # displayed Net income + Net margin subtract the one-time Year-1 startup and are congruent;
    # monthly[] spans the full 60-month horizon; payback = Month-N cash recovery; the §12.2
    # guardrail runs on the cash margin) × OPERATING layer params/gaps (2.7.0-B, this branch —
    # 990-grounded constants payroll tax 8% + Insurance $10k, the 6.2 monthly three-stream
    # split, the 6.3 advisory flags, money_view single-rounding-authority + exact lease-deposit
    # arithmetic). The internal operating net still drives the verdict; capital / break-even /
    # first-year cash gap are Year-1-anchored on the 6.2 distribution. Both move OUTPUTS, so
    # MODEL_VERSION bumps to the fused 2.8.0.
    assert model.MODEL_VERSION == "2.8.0"
    # 1.7.0 = the union of both 1.6.0 lineages: cash income/margin surfaces + monthly[] 60 rows
    # + Month-N milestone (A) and +sensitivity{base,downside,upside}+delta +confidence{ramp} +
    # the full editable settings knob set (B). The NUMBERS change with model 2.8.0.
    assert model.COMPUTE_SCHEMA_VERSION == "1.7.0"


def test_demand_constants():
    assert model.DONATIONS_PER_HH_PER_YEAR == 3
    assert Decimal(str(model.AVG_BASKET_VALUE)) == Decimal("17.08")
    assert Decimal(str(model.SALVAGE_PCT_OF_RETAIL)) == Decimal("0.008")


def test_cost_structure_constants_canonical_labor_60():
    # Owner decision: canonical labor = 60% (DECISIONS.md owner override).
    assert Decimal(str(model.LABOR_PCT_OF_REVENUE)) == Decimal("0.60")
    assert Decimal(str(model.MARKETING_PCT_OF_REVENUE)) == Decimal("0.0375")
    assert Decimal(str(model.SUPPLIES_PCT_OF_REVENUE)) == Decimal("0.05")
    assert Decimal(str(model.CARD_FEES_PCT_OF_REVENUE)) == Decimal("0.02")
    # 6.4: 990-grounded — the six-EIN sample's employer payroll-tax load is ~8%.
    assert Decimal(str(model.PAYROLL_TAX_PCT_OF_PAYROLL)) == Decimal("0.08")


def test_default_donation_value_single_source():
    # 6.4: the methodology-seed average donation value ($74, 2013-dollar literature
    # value — NOT observable in the six-EIN 990 sample) — the single source the seed +
    # engine-parity FE draft reference. (The wizard's user-facing default is a
    # deliberately-conservative $50 per Owner Decision 4 / W15, distinct from this
    # constant.)
    assert Decimal(str(model.DEFAULT_DONATION_VALUE)) == Decimal("74")


def test_occupancy_and_capital_constants():
    assert Decimal(str(model.RENT_ESCALATOR)) == Decimal("0.03")
    assert model.CASH_RESERVE_BUFFER == 25000
    assert Decimal(str(model.SENSITIVITY_DELTA)) == Decimal("0.25")


def test_sensitivity_delta_is_the_assumptions_default():
    # SENSITIVITY_DELTA is the single source for the ± stress: the Assumptions default
    # reads it, so decision.py derives the downside/upside multipliers from it instead
    # of the old dead-constant hard-coded 1.25/0.75 literals.
    from engine.compute import Assumptions

    assert Assumptions().sensitivity_delta == model.SENSITIVITY_DELTA
    assert Decimal(str(Assumptions().sensitivity_delta)) == Decimal("0.25")


def test_fixed_annual_excludes_supplies_and_utilities():
    # Supplies became a %-line (REMOVED); utilities became a sq-ft-derived line so it
    # is no longer a flat fixed-$ entry either (feature #245).
    assert "Store/office supplies" not in model.FIXED_ANNUAL
    assert "Utilities/trash service" not in model.FIXED_ANNUAL
    # 6.4: Insurance liability re-based to the 990-grounded $10k (was $2k).
    assert model.FIXED_ANNUAL["Insurance liability"] == 10000
    assert sum(model.FIXED_ANNUAL.values()) == 10000 + 3000 + 300 + 1600 + 900


def test_per_sqft_constants_present_and_anchored():
    from decimal import Decimal
    sqft = Decimal(str(model.EXAMPLE_BUILDING_SQFT))
    assert Decimal(model.UTILITIES_PER_SQFT) * sqft == Decimal("22300")
    assert Decimal(model.FIXTURES_PER_SQFT) * sqft == Decimal("45000")
    assert Decimal(model.BUILDOUT_PER_SQFT) * sqft == Decimal("50000")
    assert Decimal(model.DEFAULT_RENT_PER_SQFT) == Decimal("12.00")


def test_startup_lines():
    assert model.STARTUP["Thrift Store Consultant"] == 100000
    assert model.STARTUP["Equipment & Fixtures"] == 45000
    assert "Lease Deposit + First Month Rent" not in model.STARTUP  # computed, not literal

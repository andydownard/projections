"""RED first: named constants for the engine (ENGINE_CONTRACT §2)."""
from decimal import Decimal

from engine import model


def test_model_versions_stamped():
    # 2.7.0 (Task 6.4 + the 6.1/6.2/6.3 outputs that deferred their single regen to
    # here): 990-grounded constants (payroll tax 7.5%->8%, Insurance liability
    # $2k->$10k), the monthly-split cash-flow distribution (6.2), the occupancy/labor/
    # sales-per-sqft advisory flags (6.3), and the money_view single-rounding-authority
    # + exact lease-deposit arithmetic (6.4/commit-1). All move engine OUTPUTS, so
    # MODEL_VERSION bumps (not just the schema).
    assert model.MODEL_VERSION == "2.7.0"
    # 1.6.0: +sensitivity{base,downside,upside} scenarios + delta, +confidence{ramp}
    # (surfacing the already-computed §12.2 ±stress + the ramp low-confidence flag the
    # view-model previously dropped, audit P0); settings gain sensitivityDelta,
    # fixedAnnual, nnnOpexAnnual, buildingSqft, salesfloorPct. 1.5.0 had added
    # startupCosts/startupTotal. Additive shape change, no math change.
    assert model.COMPUTE_SCHEMA_VERSION == "1.6.0"


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


def test_default_donation_value_is_990_grounded():
    # 6.4: the research-grounded default average donation value ($74) — the single
    # source the seed + engine-parity FE draft reference. (The wizard's user-facing
    # default is a deliberately-conservative $50 per Owner Decision 4 / W15, distinct
    # from this research constant.)
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

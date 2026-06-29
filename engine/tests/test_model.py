"""RED first: named constants for the engine (ENGINE_CONTRACT §2)."""
from decimal import Decimal

from engine import model


def test_model_versions_stamped():
    # 2.7.0: the projection is CASH-based — the displayed Net income + Net margin are
    # cash-based and congruent (Year-1 subtracts the one-time startup); the monthly model
    # spans the full 60-month horizon so payback resolves across years as a Month-N cash
    # recovery. Internal operating net (and the verdict it drives) is unchanged; capital,
    # break-even and first-year cash gap stay Year-1-anchored.
    assert model.MODEL_VERSION == "2.7.0"
    # 1.6.0: the income/margin display surfaces are cash-based and monthly[] grows 12->60;
    # same field shapes, the NUMBERS change with model 2.7.0.
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
    assert Decimal(str(model.PAYROLL_TAX_PCT_OF_PAYROLL)) == Decimal("0.075")


def test_occupancy_and_capital_constants():
    assert Decimal(str(model.RENT_ESCALATOR)) == Decimal("0.03")
    assert model.CASH_RESERVE_BUFFER == 25000
    assert Decimal(str(model.SENSITIVITY_DELTA)) == Decimal("0.25")


def test_fixed_annual_excludes_supplies_and_utilities():
    # Supplies became a %-line (REMOVED); utilities became a sq-ft-derived line so it
    # is no longer a flat fixed-$ entry either (feature #245).
    assert "Store/office supplies" not in model.FIXED_ANNUAL
    assert "Utilities/trash service" not in model.FIXED_ANNUAL
    assert model.FIXED_ANNUAL["Insurance liability"] == 2000
    assert sum(model.FIXED_ANNUAL.values()) == 2000 + 3000 + 300 + 1600 + 900


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

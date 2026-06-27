"""RED first: named constants for the engine (ENGINE_CONTRACT §2)."""
from decimal import Decimal

from engine import model


def test_model_versions_stamped():
    assert model.MODEL_VERSION == "2.2.0"
    assert model.COMPUTE_SCHEMA_VERSION == "1.1.0"


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


def test_fixed_annual_excludes_supplies():
    # Supplies became a %-line; the fixed $3,700 supplies entry is REMOVED.
    assert "Store/office supplies" not in model.FIXED_ANNUAL
    assert model.FIXED_ANNUAL["Insurance liability"] == 2000
    assert model.FIXED_ANNUAL["Utilities/trash service"] == 22300
    assert sum(model.FIXED_ANNUAL.values()) == 2000 + 3000 + 300 + 1600 + 900 + 22300


def test_startup_lines():
    assert model.STARTUP["Thrift Store Consultant"] == 100000
    assert model.STARTUP["Equipment & Fixtures"] == 45000
    assert "Lease Deposit + First Month Rent" not in model.STARTUP  # computed, not literal

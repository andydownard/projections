"""RED first: named constants for the engine (ENGINE_CONTRACT §2)."""
from decimal import Decimal

from engine import model


def test_model_versions_stamped():
    # 3.0.0 = Model v3 (owner session 2026-08-03): card fees' two-term formula, the
    # production-station module, the optional linear share ramp, labor_mode coverage,
    # and three new lines (POS platform, Production software, Workers' comp,
    # Contributions revenue) — bundled under one bump. See model.py's history comment
    # and DECISIONS.md's 3.0.0 entry.
    assert model.MODEL_VERSION == "3.0.0"
    # 1.8.0: new settings keys + new view-model rows/fields for Model v3 (see
    # model.py's COMPUTE_SCHEMA_VERSION history comment for the full list).
    assert model.COMPUTE_SCHEMA_VERSION == "1.8.0"


def test_demand_constants():
    assert model.DONATIONS_PER_HH_PER_YEAR == 3
    assert Decimal(str(model.AVG_BASKET_VALUE)) == Decimal("17.08")
    assert Decimal(str(model.SALVAGE_PCT_OF_RETAIL)) == Decimal("0.008")


def test_cost_structure_constants_canonical_labor_60():
    # Owner decision: canonical labor = 60% (DECISIONS.md owner override).
    assert Decimal(str(model.LABOR_PCT_OF_REVENUE)) == Decimal("0.60")
    assert Decimal(str(model.MARKETING_PCT_OF_REVENUE)) == Decimal("0.0375")
    assert Decimal(str(model.SUPPLIES_PCT_OF_REVENUE)) == Decimal("0.05")
    # Model v3: CARD_FEES_PCT_OF_REVENUE (flat 2%-of-revenue) is deleted, replaced by
    # the two-term card-processor formula (CARD_SHARE/CARD_RATE/CARD_PER_TX_FEE).
    assert Decimal(str(model.CARD_SHARE)) == Decimal("0.65")
    assert Decimal(str(model.CARD_RATE)) == Decimal("0.026")
    assert Decimal(str(model.CARD_PER_TX_FEE)) == Decimal("0.10")
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
    # Model v3: POS platform ($400/mo = $4,800/yr) + Production software ($100/mo =
    # $1,200/yr) join FIXED_ANNUAL as flat store-level fixed costs.
    assert sum(model.FIXED_ANNUAL.values()) == 10000 + 3000 + 300 + 4800 + 1200 + 1600 + 900


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


def test_default_cost_schedule_v3_new_lines_legacy_untouched():
    # Task 2.1 (redone): default_cost_schedule() is a live byte-identical
    # legacy/migration anchor (called at request time by duplicate/PATCH/restore/Penny
    # paths) and must NEVER gain a "treatment" key or new rows. default_cost_schedule_v3()
    # is the separate, new-projection-only function that carries the Model-v3 lines.
    v3 = model.default_cost_schedule_v3()
    assert len(v3) == 8
    by_category = {row["category"]: row for row in v3}

    consultant = by_category["Thrift Store Consultant"]
    assert consultant["amount"] == model.STARTUP["Thrift Store Consultant"]
    assert consultant["treatment"] == "separate"
    assert consultant["note"] == (
        "Handled under a separate consulting agreement — attach the signed "
        "proposal for the actual figure once available."
    )

    new_lines = {
        "Equipment & Fixtures",
        "Build-out / Renovations / Tenant Improvements",
        "Legal, Permits, Insurance Setup, Signage",
        "POS checkout lanes",
        "Production stations",
        "Pre-opening hiring & training payroll",
        "Utilities/security deposits & setup",
    }
    assert set(by_category) == new_lines | {"Thrift Store Consultant"}
    for category in new_lines:
        assert by_category[category]["treatment"] == "included"
        assert "note" not in by_category[category]

    assert by_category["POS checkout lanes"]["amount"] == (
        model.POS_LANE_COST * model.POS_LANE_COUNT_DEFAULT)
    assert by_category["Pre-opening hiring & training payroll"]["amount"] == (
        model.PRE_OPENING_HIRING_TRAINING_PAYROLL)
    assert by_category["Utilities/security deposits & setup"]["amount"] == (
        model.UTILITIES_SECURITY_DEPOSITS_SETUP)
    # Production stations scales with stations_installed; default arg is 0 → $0.
    assert by_category["Production stations"]["amount"] == 0
    v3_staffed = {row["category"]: row for row in model.default_cost_schedule_v3(
        stations_installed=3)}
    assert v3_staffed["Production stations"]["amount"] == model.PRODUCTION_STATION_COST * 3

    # The OLD function is completely unaffected: still exactly its original 4 rows,
    # no "treatment" key anywhere.
    legacy = model.default_cost_schedule()
    assert len(legacy) == 4
    legacy_categories = {row["category"] for row in legacy}
    assert legacy_categories == {
        "Thrift Store Consultant",
        "Equipment & Fixtures",
        "Build-out / Renovations / Tenant Improvements",
        "Legal, Permits, Insurance Setup, Signage",
    }
    for row in legacy:
        assert "treatment" not in row
        assert "note" not in row
        assert set(row) == {"category", "month", "amount"}

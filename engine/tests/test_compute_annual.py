"""RED first: the annual driver chain + %-cost lines + escalator (§4).

The Year-2 midpoint is DEAD: share_y2 is its own explicit input, never (y1+y3)/2.
Compute in Decimal; the canonical House of Hope @60% labor reproduces the
labor-independent Y1 revenue headline (~$426,911).
"""
from decimal import Decimal

from engine import model
from engine.money import D


def test_three_explicit_shares_not_midpoint(canonical_result):
    yr = canonical_result.annual
    assert D(str(yr[1].share)) == Decimal("0.06")
    # If the engine used the dead midpoint, Y2 would be (0.06+0.10)/2 = 0.08 too,
    # so prove Y2 tracks its own input by perturbing it (separate test below).
    assert D(str(yr[2].share)) == Decimal("0.08")
    assert D(str(yr[3].share)) == Decimal("0.10")


def test_year2_share_is_independent_input():
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute

    inputs = Inputs(
        org_name="x", city="x", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.099", share_y3="0.10",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="300000",
    )
    res = compute(
        inputs, Assumptions(), DemandDrivers(),
        TradeArea(basis="city", households="31798"), overrides={},
    )
    # 0.099 is NOT the midpoint of 0.06 and 0.10 (which would be 0.08).
    assert D(str(res.annual[2].share)) == Decimal("0.099")


def test_driver_chain_year1(canonical_result):
    y1 = canonical_result.annual[1]
    assert D(str(y1.donating_hh)) == Decimal("1907.88")
    assert D(str(y1.donations)) == Decimal("5723.64")
    assert D(str(y1.retail)) == Decimal("423549.36")
    assert D(str(y1.salvage)) == Decimal("3388.39488")
    assert D(str(y1.total_rev)) == Decimal("426937.75488")
    # customers = retail / basket
    assert abs(D(str(y1.customers)) - (Decimal("423549.36") / Decimal("17.08"))) < Decimal("0.01")


def test_y1_revenue_headline_holds(canonical_result):
    # ENGINE_CONTRACT §10: Y1 revenue ≈ $426,911 (labor-independent). Engine value
    # is $426,938 with basket $17.08; well within the spec's "~" headline.
    y1 = canonical_result.annual[1]
    assert abs(D(str(y1.total_rev)) - Decimal("426911")) < Decimal("50")


def test_y1_revenue_is_labor_independent(canonical_result, design_parity_result):
    assert canonical_result.annual[1].total_rev == design_parity_result.annual[1].total_rev


def test_pct_cost_lines_year1(canonical_result):
    y1 = canonical_result.annual[1]
    tr = D(str(y1.total_rev))
    assert D(str(y1.expenses["Credit card fees"])) == tr * Decimal("0.02")
    assert D(str(y1.expenses["Payroll"])) == tr * Decimal("0.60")
    assert D(str(y1.expenses["Payroll taxes"])) == tr * Decimal("0.60") * Decimal("0.075")
    assert D(str(y1.expenses["Marketing & outreach"])) == tr * Decimal("0.0375")
    assert D(str(y1.expenses["Supplies & processing"])) == tr * Decimal("0.05")


def test_fixed_annual_lines_present(canonical_result):
    y1 = canonical_result.annual[1]
    for label, val in model.FIXED_ANNUAL.items():
        assert D(str(y1.expenses[label])) == Decimal(str(val))
    assert "Store/office supplies" not in y1.expenses  # killed (now %-line)


def test_rent_escalator_compounds_y2_y3(canonical_result):
    occ1 = D(str(canonical_result.annual[1].expenses["Rent"]))
    occ2 = D(str(canonical_result.annual[2].expenses["Rent"]))
    occ3 = D(str(canonical_result.annual[3].expenses["Rent"]))
    assert occ1 == Decimal("120000")
    assert occ2 == Decimal("120000") * Decimal("1.03")
    assert occ3 == Decimal("120000") * Decimal("1.03") ** 2


def test_total_expenses_and_net_foot(canonical_result):
    y1 = canonical_result.annual[1]
    assert D(str(y1.total_exp)) == sum(D(str(v)) for v in y1.expenses.values())
    assert D(str(y1.net)) == D(str(y1.total_rev)) - D(str(y1.total_exp))


def test_margin_at_60_labor_is_a_loss_case(canonical_result):
    # At 60% labor the conservative sample is a slight-loss / "revise"-class case.
    y1 = canonical_result.annual[1]
    assert D(str(y1.net)) < 0
    assert D(str(y1.margin)) < 0


def test_startup_total_includes_computed_lease_deposit(canonical_result):
    su = canonical_result.startup
    # Lease deposit = occupancy_y1 / 12 * 3 (uses rent_y1, NOT escalated).
    assert D(str(su["Lease Deposit + First Month Rent"])) == Decimal("120000") / 12 * 3
    assert D(str(canonical_result.startup_total)) == sum(D(str(v)) for v in su.values())

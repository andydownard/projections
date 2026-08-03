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
        share_y1="0.06", share_y2="0.099", share_y3="0.10", share_y4="0.11", share_y5="0.12",
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
    assert D(str(y1.expenses["Payroll taxes"])) == tr * Decimal("0.60") * Decimal("0.08")
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


def _hoh(cost_schedule=(), opening_month_number=1):
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    inputs = Inputs(
        org_name="House of Hope", city="Longview, Texas", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10",
        share_y4="0.11", share_y5="0.12", donation_value="74",
        building_sqft="10000", salesfloor_pct="0.70", occupancy_annual="120000",
        lease_type="nnn", source_of_funds="300000",
        cost_schedule=cost_schedule, opening_month_number=opening_month_number,
    )
    return compute(inputs, Assumptions(labor_pct="0.60"), DemandDrivers(),
                   TradeArea(basis="city", households="31798"), overrides={})


def test_cost_schedule_supersedes_startup_lump():
    # A user schedule replaces the fixed STARTUP lump (Spec §5). Total startup =
    # sum(schedule) + the computed lease deposit (always added on top).
    schedule = (
        {"category": "Consultant", "month": 1, "amount": 60000},
        {"category": "Build-out", "month": 2, "amount": 40000},
    )
    res = _hoh(cost_schedule=schedule, opening_month_number=3)
    lease = Decimal("120000") / 12 * 3
    assert D(str(res.startup["Consultant"])) == Decimal("60000")
    assert D(str(res.startup["Build-out"])) == Decimal("40000")
    assert D(str(res.startup_total)) == Decimal("100000") + lease
    # The legacy STARTUP labels are gone when a schedule is supplied.
    assert "Thrift Store Consultant" not in res.startup


def test_month1_lump_opening_month_1_reproduces_legacy_numbers():
    # Parity (Spec §6/§7): placing the legacy STARTUP amounts at month 1 with
    # opening_month_number=1 reproduces the no-schedule default exactly.
    legacy = _hoh()  # no schedule -> month-1 lump default
    schedule = tuple(
        {"category": cat, "month": 1, "amount": amt}
        for cat, amt in model.STARTUP.items()
    )
    explicit = _hoh(cost_schedule=schedule, opening_month_number=1)
    assert D(str(explicit.startup_total)) == D(str(legacy.startup_total))
    assert (D(str(explicit.decision.startup_capital_required))
            == D(str(legacy.decision.startup_capital_required)))
    assert (D(str(explicit.decision.first_year_cash_gap))
            == D(str(legacy.decision.first_year_cash_gap)))
    # Monthly cash curve is identical month-for-month.
    assert [D(str(m.cumulative_cash)) for m in explicit.monthly] == \
        [D(str(m.cumulative_cash)) for m in legacy.monthly]


def test_migration_default_backfill_reproduces_legacy_view_model_byte_for_byte():
    # Backward-compat guard (#120): a legacy/seeded projection with NO schedule,
    # migrated to the month-1 lump via the SHIPPED migration backfill helper
    # (model.default_cost_schedule() at opening_month_number=1), must compute the
    # entire view-model byte-for-byte identical to the pre-change legacy default —
    # existing projections' numbers (annual P&L, decision metrics, monthly curve,
    # milestones) do not move.
    import json

    from engine.viewmodel import to_view_model
    legacy = _hoh()  # no schedule; opening_month_number defaults to 1
    migrated = _hoh(cost_schedule=tuple(model.default_cost_schedule()),
                    opening_month_number=model.DEFAULT_OPENING_MONTH_NUMBER)
    assert json.dumps(to_view_model(migrated), sort_keys=True) == \
        json.dumps(to_view_model(legacy), sort_keys=True)


def test_legacy_default_key_numbers_are_pinned():
    # Literal regression anchor for the migration default (#120): the legacy lump
    # numbers are frozen so a future engine change cannot silently move them.
    # Re-pinned at the 2.7.0 single regen (Task 6.4): the 990-grounded constants
    # (payroll tax 7.5%->8%, Insurance liability $2k->$10k) deepen the Y1 loss and the
    # cash trough, so Y1 net = -$53,713.72 (was -$44,432.91) and capital = $347,853.76
    # (was $342,403.21 at the 6.2 split / $321,939.73 pre-wave-6). Break-even stays
    # month 8. startup_total (one-time) is unchanged — insurance is an operating line.
    res = _hoh()  # canonical 60% labor, no schedule (the seeded legacy default)
    assert D(str(res.startup_total)) == Decimal("238500")
    assert D(str(res.annual[1].net)) == Decimal("-53713.718931840")
    assert D(str(res.decision.startup_capital_required)) == Decimal("347853.762082154880")
    assert res.decision.break_even_month == 8
    assert res.decision.payback_month is None  # never recovered in the horizon


def test_schedule_total_equals_sum_of_outflow_map():
    # The per-month outflow map sums to startup_total (no double count, none dropped).
    from engine.compute import Assumptions, startup_outflows_by_month
    schedule = (
        {"category": "A", "month": 1, "amount": 10000},
        {"category": "A", "month": 5, "amount": 5000},
        {"category": "B", "month": 14, "amount": 8000},
    )
    res = _hoh(cost_schedule=schedule, opening_month_number=4)
    by_month = startup_outflows_by_month(res.inputs, Assumptions(labor_pct="0.60"),
                                         Decimal("120000"))
    assert sum(by_month.values(), Decimal("0")) == D(str(res.startup_total))


def test_occupancy_requires_annual_or_per_sqft():
    # Neither occupancy_annual nor rent_per_sqft -> a clean ValueError (the §4
    # occupancy resolver has no rent to resolve), never an unguarded crash later.
    import pytest

    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    inputs = Inputs(
        org_name="No Rent", city="x", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10",
        share_y4="0.11", share_y5="0.12", donation_value="74",
        building_sqft="10000", salesfloor_pct="0.70", source_of_funds="300000",
        # occupancy_annual and rent_per_sqft both omitted (default None)
    )
    with pytest.raises(ValueError, match="occupancy requires"):
        compute(inputs, Assumptions(), DemandDrivers(),
                TradeArea(basis="city", households="31798"))


def test_card_fees_two_term_formula(canonical_result):
    # Card fees = card_share × (card_rate × retail + per_tx_fee × transactions).
    # Recompute expected from the same retail/customers values read off annual[1].
    y1 = canonical_result.annual[1]
    retail = D(str(y1.retail))
    customers = D(str(y1.customers))
    expected_fees = D("0.65") * (D("0.026") * retail + D("0.10") * customers)
    actual_fees = D(str(y1.expenses["Credit card fees"]))
    assert actual_fees == expected_fees


def test_card_fees_zero_at_zero_share():
    # When card_share = 0, credit card fees should be 0.
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    inputs = Inputs(
        org_name="House of Hope", city="Longview, Texas", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10",
        share_y4="0.11", share_y5="0.12", donation_value="74",
        building_sqft="10000", salesfloor_pct="0.70", occupancy_annual="120000",
        lease_type="nnn", source_of_funds="300000",
    )
    res = compute(inputs, Assumptions(card_share="0"), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides={})
    assert D(str(res.annual[1].expenses["Credit card fees"])) == Decimal("0")


# ------------------------------------------------- Task 1.2: production-station module
def test_items_sold_items_produced_production_hours(canonical_result):
    # items_sold = retail / avg_item_price; items_produced = items_sold / sell_through;
    # production_hours = items_produced / items_per_hour (all default-Assumptions).
    y1 = canonical_result.annual[1]
    retail = D(str(y1.retail))
    items_sold = D(str(y1.items_sold))
    items_produced = D(str(y1.items_produced))
    production_hours = D(str(y1.production_hours))
    assert items_sold == retail / D("5.00")
    assert items_produced == items_sold / D("0.50")
    assert production_hours == items_produced / D(75)


def test_production_metrics_zero_guarded():
    # avg_item_price = 0 must never raise ZeroDivisionError — items_sold (and
    # everything downstream of it) is explicitly 0, not a crash.
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    inputs = Inputs(
        org_name="House of Hope", city="Longview, Texas", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10",
        share_y4="0.11", share_y5="0.12", donation_value="74",
        building_sqft="10000", salesfloor_pct="0.70", occupancy_annual="120000",
        lease_type="nnn", source_of_funds="300000",
    )
    res = compute(inputs, Assumptions(avg_item_price="0"), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides={})
    assert D(str(res.annual[1].items_sold)) == Decimal("0")
    assert D(str(res.annual[1].items_produced)) == Decimal("0")
    assert D(str(res.annual[1].production_hours)) == Decimal("0")


# ------------------------------------------------- Task 1.4: labor_mode: pct | coverage
def test_labor_mode_pct_is_default_and_byte_unchanged(canonical_result):
    # Default Assumptions() -> labor_mode == "pct"; Payroll == total_rev * labor_pct,
    # today's formula, byte-unchanged.
    y1 = canonical_result.annual[1]
    assert canonical_result.assumptions.labor_mode == "pct"
    expected = D(str(y1.total_rev)) * D(canonical_result.assumptions.labor_pct)
    assert D(str(y1.expenses["Payroll"])) == expected


def test_labor_mode_coverage_formula():
    # Coverage mode: headcount/wage-driven Payroll, using the YEAR'S AVERAGE MONTH
    # (production_hours/12, customers/12) — not the actual monthly ramp (see Design
    # Review: compute_annual runs before build_monthly, so depending on the real
    # monthly ramp would be circular). Recompute expected from the SAME resolved
    # production_hours/customers the test reads off annual[1], not hand-typed dollars.
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    inputs = Inputs(
        org_name="House of Hope", city="Longview, Texas", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10",
        share_y4="0.11", share_y5="0.12", donation_value="74",
        building_sqft="10000", salesfloor_pct="0.70", occupancy_annual="120000",
        lease_type="nnn", source_of_funds="300000",
    )
    a = Assumptions(labor_pct="0.60", labor_mode="coverage")
    res = compute(inputs, a, DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides={})
    y1 = res.annual[1]
    production_hours = D(str(y1.production_hours))
    customers = D(str(y1.customers))

    open_hours_per_month = D(a.open_hours_per_week) * 52 / 12
    production_hours_month = production_hours / 12
    transactions_month = customers / 12
    cashier_hours = max(
        transactions_month / D(a.cashier_tx_per_hour),
        D(a.min_staffed_lanes) * open_hours_per_month,
    )
    door_hours = (D(a.door_dedicated) + D(a.door_peak)) * open_hours_per_month
    runner_hours = D(a.runners) * open_hours_per_month
    hourly_hours_month = production_hours_month + cashier_hours + door_hours + runner_hours
    salaries = D(a.mgr_salary) + D(str(a.am_count)) * D(a.am_salary)
    expected = hourly_hours_month * D(a.wage) * 12 + salaries

    assert D(str(y1.expenses["Payroll"])) == expected


def test_labor_mode_coverage_zero_guarded():
    # cashier_tx_per_hour = 0 must never raise ZeroDivisionError.
    from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
    inputs = Inputs(
        org_name="House of Hope", city="Longview, Texas", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10",
        share_y4="0.11", share_y5="0.12", donation_value="74",
        building_sqft="10000", salesfloor_pct="0.70", occupancy_annual="120000",
        lease_type="nnn", source_of_funds="300000",
    )
    res = compute(
        inputs, Assumptions(labor_mode="coverage", cashier_tx_per_hour="0"),
        DemandDrivers(), TradeArea(basis="city", households="31798"), overrides={})
    # No exception raised; Payroll resolves via the min_staffed_lanes floor term.
    assert D(str(res.annual[1].expenses["Payroll"])) > Decimal("0")

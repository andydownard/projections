"""RED first: read-only cost-schedule aggregation (decision #15, feature #263).

The pre-Generate startup-costs grid needs server-computed totals so the client
never sums (NO-CLIENT-MATH / SERVER). The engine — the one math authority — is
where the summing lives: ``cost_schedule_totals`` reuses the SAME ``D(str(amount))``
Decimal idiom that ``compute_annual`` (per-category) and ``startup_outflows_by_month``
(per-month) already use, so cost aggregation has no second authority.

Pure + read-only: it never mutates the model and never persists. These tests pin
the three aggregates (per-category row totals, per-month column totals, grand
total) and the empty-rows fallback to the seeded default schedule.
"""
from decimal import Decimal

from engine import model
from engine.compute import cost_schedule_totals


def test_rows_aggregate_by_category_month_and_grand_total():
    schedule = [
        {"category": "Equipment", "month": 1, "amount": 45000},
        {"category": "Build-out", "month": 2, "amount": 50000},
        # same category, a later month -> folds into ONE category row total.
        {"category": "Equipment", "month": 3, "amount": 5000},
        # same month as Build-out, a different category -> folds into the month col.
        {"category": "Legal", "month": 2, "amount": 10000},
    ]
    totals = cost_schedule_totals(schedule)

    # per-category row totals, insertion order preserved (grid row order).
    assert list(totals["by_category"].items()) == [
        ("Equipment", Decimal("50000")),
        ("Build-out", Decimal("50000")),
        ("Legal", Decimal("10000")),
    ]
    # per-month column totals, ascending by month (grid column order).
    assert list(totals["by_month"].items()) == [
        (1, Decimal("45000")),
        (2, Decimal("60000")),
        (3, Decimal("5000")),
    ]
    assert totals["grand_total"] == Decimal("110000")


def test_amount_accepts_numeric_strings_and_decimals_without_float_poison():
    schedule = [
        {"category": "A", "month": 1, "amount": "10000.50"},
        {"category": "A", "month": 1, "amount": 0.25},
    ]
    totals = cost_schedule_totals(schedule)
    assert totals["by_category"]["A"] == Decimal("10000.75")
    assert totals["grand_total"] == Decimal("10000.75")


def test_empty_rows_fall_back_to_the_seeded_default_schedule():
    # No rows + no sqft -> the legacy 10,000 sq ft default (byte-identical seed).
    totals = cost_schedule_totals([])
    assert totals["by_category"] == {
        "Thrift Store Consultant": Decimal("100000"),
        "Equipment & Fixtures": Decimal("45000"),
        "Build-out / Renovations / Tenant Improvements": Decimal("50000"),
        "Legal, Permits, Insurance Setup, Signage": Decimal("13500"),
    }
    # default schedule places every line at month 1 -> one column total.
    assert totals["by_month"] == {1: Decimal("208500")}
    assert totals["grand_total"] == Decimal("208500")


def test_empty_rows_with_building_sqft_scales_only_the_default_fallback():
    # building_sqft only feeds the empty-rows fallback (default_cost_schedule):
    # Equipment & Fixtures = 4.50 * 20000, Build-out = 5.00 * 20000.
    totals = cost_schedule_totals([], building_sqft=20000)
    assert totals["by_category"]["Equipment & Fixtures"] == Decimal("90000")
    assert totals["by_category"][
        "Build-out / Renovations / Tenant Improvements"] == Decimal("100000")
    assert totals["grand_total"] == Decimal("303500")


def test_building_sqft_is_ignored_when_rows_are_provided():
    schedule = [{"category": "Equipment", "month": 1, "amount": 1000}]
    totals = cost_schedule_totals(schedule, building_sqft=99999)
    assert totals["grand_total"] == Decimal("1000")


def test_no_arg_building_sqft_matches_example_basis_constant():
    # The None default resolves to the example's 10,000 sq ft basis.
    assert (
        cost_schedule_totals([], building_sqft=model.EXAMPLE_BUILDING_SQFT)
        == cost_schedule_totals([])
    )

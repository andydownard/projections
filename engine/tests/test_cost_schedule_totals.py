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


# ------------------------------------ treatment filtering (Model v3, Task 2.2)
def test_separate_and_contingent_aggregates_returned():
    # "separate"/"contingent" rows are aggregated SEPARATELY from the
    # included-only by_category/by_month/grand_total, so the always-visible
    # sections have something to render, independent of the capital math.
    schedule = [
        {"category": "Equipment", "month": 1, "amount": 45000, "treatment": "included"},
        {"category": "Consultant", "month": 1, "amount": 100000, "treatment": "separate"},
        {"category": "Contingency reserve", "month": 1, "amount": 20000,
         "treatment": "contingent"},
        # a second "separate" row in the SAME category -> folds into one total.
        {"category": "Consultant", "month": 2, "amount": 5000, "treatment": "separate"},
    ]
    totals = cost_schedule_totals(schedule)

    # included-only aggregates are unaffected by the non-included rows.
    assert totals["by_category"] == {"Equipment": Decimal("45000")}
    assert totals["by_month"] == {1: Decimal("45000")}
    assert totals["grand_total"] == Decimal("45000")

    assert totals["separate"]["by_category"] == {"Consultant": Decimal("105000")}
    assert totals["separate"]["grand_total"] == Decimal("105000")
    assert totals["contingent"]["by_category"] == {"Contingency reserve": Decimal("20000")}
    assert totals["contingent"]["grand_total"] == Decimal("20000")


def test_missing_or_unrecognized_treatment_defaults_included_in_totals():
    # No "treatment" key at all -> included (backward-compat). An unrecognized
    # value never silently drops a cost out of capital math either -- it also
    # falls into "included" (the conservative side for a live financial engine).
    schedule = [
        {"category": "Legacy", "month": 1, "amount": 1000},
        {"category": "Typo'd", "month": 1, "amount": 500, "treatment": "seperate"},
    ]
    totals = cost_schedule_totals(schedule)
    assert totals["grand_total"] == Decimal("1500")
    assert totals["separate"]["grand_total"] == Decimal("0")
    assert totals["contingent"]["grand_total"] == Decimal("0")


def test_empty_rows_fallback_has_empty_separate_and_contingent():
    # The seeded default (no cost_schedule at all) has no treatment keys -> every
    # row is included -> separate/contingent are empty, never omitted keys.
    totals = cost_schedule_totals([])
    assert totals["separate"] == {"by_category": {}, "grand_total": Decimal("0")}
    assert totals["contingent"] == {"by_category": {}, "grand_total": Decimal("0")}

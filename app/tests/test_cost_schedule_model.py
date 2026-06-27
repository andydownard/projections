"""W1 data-model spine — engine.model default-schedule helper (Spec §5/§7; #113).

The fixed ``STARTUP`` lump is superseded by ``cost_schedule``. ``default_cost_schedule``
is the single source of the migration backfill AND the engine default, so these
tests pin its shape, its parity with ``STARTUP``, and its independence/immutability
guarantees. Pure-Python (no DB / no HTTP) so they stay fast and deterministic.
"""
from __future__ import annotations

from engine.model import (
    DEFAULT_OPENING_MONTH_NUMBER,
    STARTUP,
    default_cost_schedule,
)


def test_default_opening_month_number_is_one():
    # Grand opening at month 1 => no pre-opening months => single lump at opening,
    # reproducing today's numbers exactly (Spec §7, "no special synthesis").
    assert DEFAULT_OPENING_MONTH_NUMBER == 1
    assert isinstance(DEFAULT_OPENING_MONTH_NUMBER, int)


def test_default_schedule_returns_a_list_of_rows():
    schedule = default_cost_schedule()
    assert isinstance(schedule, list)
    assert schedule, "default schedule must not be empty"
    for row in schedule:
        assert isinstance(row, dict)


def test_default_schedule_row_shape():
    # Row shape is exactly {category, month, amount} (Spec §5).
    for row in default_cost_schedule():
        assert set(row.keys()) == {"category", "month", "amount"}


def test_default_schedule_category_is_a_string():
    for row in default_cost_schedule():
        assert isinstance(row["category"], str)
        assert row["category"], "category label must be non-empty"


def test_default_schedule_every_row_at_month_one():
    # The default places every line at month 1 (a single lump at opening).
    assert all(row["month"] == 1 for row in default_cost_schedule())


def test_default_schedule_month_is_int_ge_one():
    for row in default_cost_schedule():
        assert isinstance(row["month"], int)
        assert row["month"] >= 1


def test_default_schedule_amount_is_non_negative():
    for row in default_cost_schedule():
        assert row["amount"] >= 0


def test_default_schedule_one_row_per_startup_line():
    assert len(default_cost_schedule()) == len(STARTUP)


def test_default_schedule_categories_match_startup_keys():
    categories = [row["category"] for row in default_cost_schedule()]
    assert set(categories) == set(STARTUP.keys())
    # no duplicate categories in the default
    assert len(categories) == len(set(categories))


def test_default_schedule_amounts_match_startup_values():
    by_category = {row["category"]: row["amount"] for row in default_cost_schedule()}
    assert by_category == dict(STARTUP)


def test_default_schedule_total_equals_startup_total():
    # Total startup == sum of the schedule (Spec §6: "Total startup = sum of schedule").
    total = sum(row["amount"] for row in default_cost_schedule())
    assert total == sum(STARTUP.values())


def test_default_schedule_preserves_startup_insertion_order():
    # Dict iteration order is stable in py3.7+, so the schedule mirrors STARTUP order.
    categories = [row["category"] for row in default_cost_schedule()]
    assert categories == list(STARTUP.keys())


def test_default_schedule_returns_independent_lists():
    # Each call returns a fresh list — callers may mutate without poisoning others.
    a = default_cost_schedule()
    b = default_cost_schedule()
    assert a == b
    assert a is not b
    a[0]["amount"] = 99999999
    a.append({"category": "spurious", "month": 5, "amount": 1})
    fresh = default_cost_schedule()
    assert fresh != a
    assert len(fresh) == len(STARTUP)


def test_mutating_default_schedule_does_not_mutate_startup():
    schedule = default_cost_schedule()
    schedule[0]["amount"] = 0
    schedule.clear()
    # STARTUP is untouched by mutation of the derived schedule.
    assert sum(STARTUP.values()) == 100000 + 45000 + 50000 + 13500


def test_default_schedule_includes_each_known_startup_line():
    by_category = {row["category"]: row["amount"] for row in default_cost_schedule()}
    assert by_category["Thrift Store Consultant"] == 100000
    assert by_category["Equipment & Fixtures"] == 45000
    assert by_category["Build-out / Renovations / Tenant Improvements"] == 50000
    assert by_category["Legal, Permits, Insurance Setup, Signage"] == 13500


def test_default_schedule_amounts_are_numeric():
    for row in default_cost_schedule():
        assert isinstance(row["amount"], (int, float))


def test_default_schedule_is_json_round_trippable():
    import json

    schedule = default_cost_schedule()
    assert json.loads(json.dumps(schedule)) == schedule


def test_default_schedule_has_no_extra_keys_anywhere():
    for row in default_cost_schedule():
        assert "month" in row and "amount" in row and "category" in row
        assert len(row) == 3


def test_default_schedule_months_all_equal_default_opening():
    # The lump sits on the same month as the default grand-opening milestone, so
    # there are no pre-opening months in the default state.
    for row in default_cost_schedule():
        assert row["month"] == DEFAULT_OPENING_MONTH_NUMBER


def test_default_schedule_amounts_are_whole_dollars():
    # STARTUP is expressed in whole dollars; the derived schedule keeps that.
    for row in default_cost_schedule():
        assert float(row["amount"]).is_integer()


def test_default_schedule_total_is_positive():
    assert sum(row["amount"] for row in default_cost_schedule()) > 0


def test_default_schedule_consultant_is_the_largest_line():
    by_category = {r["category"]: r["amount"] for r in default_cost_schedule()}
    assert by_category["Thrift Store Consultant"] == max(by_category.values())


def test_default_schedule_length_is_stable_across_calls():
    assert len({len(default_cost_schedule()) for _ in range(5)}) == 1


def test_default_schedule_equal_value_across_calls():
    runs = [default_cost_schedule() for _ in range(3)]
    assert runs[0] == runs[1] == runs[2]

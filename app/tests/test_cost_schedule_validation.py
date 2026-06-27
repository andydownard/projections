"""W1 data-model spine — unit-level validation of the schedule/anchor models and
the router helpers (#113). Exercises ``CostScheduleItemIn`` / ``InputsIn`` Pydantic
validation, the PATCH-path ``_validate_schedule_inputs`` guard, the denormalized
``_schedule_columns`` mirror, and the engine-arg filtering that keeps the
schedule/anchor out of the frozen engine ``Inputs`` dataclass — all without HTTP.
"""
from __future__ import annotations

import json

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.routers.projections import (
    _NON_ENGINE_INPUT_KEYS,
    CostScheduleItemIn,
    InputsIn,
    _build_engine_args_from_dicts,
    _schedule_columns,
    _validate_schedule_inputs,
)
from engine.model import DEFAULT_OPENING_MONTH_NUMBER, default_cost_schedule

ENGINE_INPUTS = {
    "org_name": "House of Hope",
    "city": "Longview, Texas",
    "opening_status": "pre_launch",
    "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
    "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
    "source_of_funds": "300000", "occupancy_annual": "120000",
    "lease_type": "nnn", "nnn_opex_annual": "0",
}
TRADE = {"basis": "city", "households": "31798"}


# ----------------------------------------------------- CostScheduleItemIn model
def test_item_accepts_valid_row():
    item = CostScheduleItemIn(category="Build-out", month=2, amount=50000)
    assert item.category == "Build-out"
    assert item.month == 2
    assert item.amount == 50000


def test_item_accepts_month_one():
    assert CostScheduleItemIn(category="X", month=1, amount=0).month == 1


def test_item_accepts_zero_amount():
    assert CostScheduleItemIn(category="X", month=1, amount=0).amount == 0


@pytest.mark.parametrize("month", [0, -1, -100])
def test_item_rejects_month_below_one(month):
    with pytest.raises(ValidationError):
        CostScheduleItemIn(category="X", month=month, amount=10)


@pytest.mark.parametrize("amount", [-1, -0.5, -99999])
def test_item_rejects_negative_amount(amount):
    with pytest.raises(ValidationError):
        CostScheduleItemIn(category="X", month=1, amount=amount)


def test_item_rejects_extra_field():
    with pytest.raises(ValidationError):
        CostScheduleItemIn(category="X", month=1, amount=10, surprise=1)


def test_item_coerces_numeric_strings():
    item = CostScheduleItemIn(category="X", month="3", amount="2500")
    assert item.month == 3
    assert item.amount == 2500


def test_item_requires_category():
    with pytest.raises(ValidationError):
        CostScheduleItemIn(month=1, amount=10)


# ------------------------------------------------------------- InputsIn model
def test_inputs_defaults_opening_month_to_constant():
    inp = InputsIn(**ENGINE_INPUTS)
    assert inp.opening_month_number == DEFAULT_OPENING_MONTH_NUMBER


def test_inputs_defaults_schedule_to_none():
    inp = InputsIn(**ENGINE_INPUTS)
    assert inp.cost_schedule is None
    assert inp.target_opening_date is None


def test_inputs_accepts_schedule_and_anchor():
    inp = InputsIn(
        **ENGINE_INPUTS,
        cost_schedule=[{"category": "X", "month": 2, "amount": 100}],
        opening_month_number=6,
        target_opening_date="2026-09",
    )
    assert inp.opening_month_number == 6
    assert inp.target_opening_date == "2026-09"
    assert inp.cost_schedule[0].month == 2


@pytest.mark.parametrize("opening", [0, -1, -12])
def test_inputs_rejects_opening_month_below_one(opening):
    with pytest.raises(ValidationError):
        InputsIn(**ENGINE_INPUTS, opening_month_number=opening)


def test_inputs_rejects_bad_schedule_row():
    with pytest.raises(ValidationError):
        InputsIn(
            **ENGINE_INPUTS,
            cost_schedule=[{"category": "X", "month": 0, "amount": 1}],
        )


def test_inputs_model_dump_round_trips_schedule():
    schedule = [{"category": "X", "month": 2, "amount": 100}]
    inp = InputsIn(**ENGINE_INPUTS, cost_schedule=schedule, opening_month_number=3)
    dumped = inp.model_dump()
    assert dumped["cost_schedule"] == schedule
    assert dumped["opening_month_number"] == 3
    # JSON-serializable (this is what gets persisted to inputs_json)
    assert json.loads(json.dumps(dumped))["cost_schedule"] == schedule


# ----------------------------------------------- _validate_schedule_inputs guard
def test_validate_passes_for_clean_inputs():
    # returns None and does not raise
    assert _validate_schedule_inputs({**ENGINE_INPUTS}) is None


def test_validate_passes_with_valid_schedule():
    assert _validate_schedule_inputs({
        "cost_schedule": [{"category": "X", "month": 1, "amount": 0}],
        "opening_month_number": 4,
    }) is None


def test_validate_passes_when_schedule_absent():
    assert _validate_schedule_inputs({"opening_month_number": 2}) is None


def test_validate_passes_with_none_schedule():
    assert _validate_schedule_inputs({"cost_schedule": None}) is None


@pytest.mark.parametrize(
    "bad",
    [
        {"cost_schedule": [{"category": "X", "month": 0, "amount": 1}]},
        {"cost_schedule": [{"category": "X", "month": 1, "amount": -1}]},
        {"cost_schedule": [{"category": "X", "month": -5, "amount": 1}]},
        {"opening_month_number": 0},
        {"opening_month_number": -3},
    ],
)
def test_validate_raises_422_on_bad(bad):
    with pytest.raises(HTTPException) as ei:
        _validate_schedule_inputs(bad)
    assert ei.value.status_code == 422
    assert ei.value.detail["error"] == "invalid_inputs"


def test_validate_rejects_extra_field_row():
    with pytest.raises(HTTPException) as ei:
        _validate_schedule_inputs({
            "cost_schedule": [{"category": "X", "month": 1, "amount": 1, "x": 1}]
        })
    assert ei.value.status_code == 422


# ----------------------------------------------------------- _schedule_columns
def test_schedule_columns_mirror_explicit_values():
    schedule = [{"category": "X", "month": 2, "amount": 100}]
    cols = _schedule_columns({
        "cost_schedule": schedule,
        "opening_month_number": 6,
        "target_opening_date": "2026-09",
    })
    assert json.loads(cols["cost_schedule_json"]) == schedule
    assert cols["opening_month_number"] == 6
    assert cols["target_opening_date"] == "2026-09"


def test_schedule_columns_default_when_missing():
    cols = _schedule_columns({})
    assert json.loads(cols["cost_schedule_json"]) == default_cost_schedule()
    assert cols["opening_month_number"] == DEFAULT_OPENING_MONTH_NUMBER
    assert cols["target_opening_date"] is None


def test_schedule_columns_default_when_empty_schedule():
    cols = _schedule_columns({"cost_schedule": []})
    # empty schedule falls back to the month-1 lump default for the mirror column
    assert json.loads(cols["cost_schedule_json"]) == default_cost_schedule()


def test_schedule_columns_coerces_opening_to_int():
    cols = _schedule_columns({"opening_month_number": "7"})
    assert cols["opening_month_number"] == 7
    assert isinstance(cols["opening_month_number"], int)


def test_schedule_columns_returns_only_known_keys():
    cols = _schedule_columns({"cost_schedule": [], "ignored": 1})
    assert set(cols.keys()) == {
        "cost_schedule_json", "target_opening_date", "opening_month_number"
    }


# --------------------------------------------- engine-arg filtering of new keys
def test_non_engine_keys_constant_lists_the_new_fields():
    assert set(_NON_ENGINE_INPUT_KEYS) == {
        "cost_schedule", "opening_month_number", "target_opening_date"
    }


def test_build_engine_args_filters_schedule_and_anchor():
    inputs_d = {
        **ENGINE_INPUTS,
        "cost_schedule": [{"category": "X", "month": 2, "amount": 100}],
        "opening_month_number": 6,
        "target_opening_date": "2026-09",
    }
    # The engine Inputs now models the schedule/anchor, but this app-level builder
    # still filters the keys out, so the engine falls back to its defaults (the
    # month-1 lump / opening month 1) rather than the user's stored values here.
    inputs, _assump, _demand, _trade = _build_engine_args_from_dicts(
        inputs_d, {"labor_pct": "0.60"}, {}, TRADE)
    assert inputs.cost_schedule == ()
    assert inputs.opening_month_number == 1
    assert inputs.city == "Longview, Texas"


def test_build_engine_args_works_without_schedule():
    inputs, _a, _d, _t = _build_engine_args_from_dicts(
        {**ENGINE_INPUTS}, {"labor_pct": "0.60"}, {}, TRADE)
    assert inputs.org_name == "House of Hope"


def test_build_engine_args_identical_with_or_without_schedule():
    base = _build_engine_args_from_dicts(
        {**ENGINE_INPUTS}, None, {}, TRADE)[0]
    with_sched = _build_engine_args_from_dicts(
        {**ENGINE_INPUTS,
         "cost_schedule": [{"category": "X", "month": 2, "amount": 100}],
         "opening_month_number": 9},
        None, {}, TRADE)[0]
    # the engine sees the same Inputs regardless of schedule/anchor presence
    assert base == with_sched

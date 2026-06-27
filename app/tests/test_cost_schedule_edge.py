"""W1 data-model spine — edge cases for the timed cost schedule + anchor (#113).

Per Spec §5/§6 rows may fall on ANY month — before or after the opening milestone
(e.g. post-open support) — and the opening month is a general milestone (1, 6, or
any month). These tests pin that flexibility and assorted numeric/serialization
edges through the create + PATCH API and the pure helpers.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore
from engine.model import default_cost_schedule

BASE_INPUTS = {
    "org_name": "House of Hope",
    "city": "Longview, Texas",
    "opening_status": "pre_launch",
    "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
    "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
    "source_of_funds": "300000", "occupancy_annual": "120000",
    "lease_type": "nnn", "nnn_opex_annual": "0",
}


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


@pytest.fixture()
def client(store):
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


def _body(**input_overrides):
    return {
        "name": "House of Hope",
        "inputs": {**BASE_INPUTS, **input_overrides},
        "trade_area": {"basis": "city", "households": "31798"},
        "assumptions": {"labor_pct": "0.60"},
    }


def _create(client, **input_overrides):
    r = client.post("/api/projections", json=_body(**input_overrides))
    assert r.status_code == 201, r.text
    return r.json()


def _stored(store, slug):
    return json.loads(store.get_projection_by_slug(slug)["inputs_json"])


def _headers(created, if_match):
    return {"Authorization": f"Bearer {created['owner_token']}", "If-Match": str(if_match)}


# ----------------------------------------- rows before/after the opening month
def test_pre_opening_rows_allowed():
    # opening at month 6; rows on months 1..5 are pre-opening costs.
    schedule = [{"category": f"Pre {m}", "month": m, "amount": 1000 * m} for m in range(1, 6)]
    client = TestClient(create_app())
    store = SqliteStore(":memory:")
    store.migrate()
    client.app.dependency_overrides[get_store] = lambda: store
    created = _create(client, cost_schedule=schedule, opening_month_number=6)
    assert _stored(store, created["view_slug"])["cost_schedule"] == schedule


def test_post_opening_rows_allowed(client, store):
    # rows after the opening milestone (e.g. post-open support) are valid.
    schedule = [
        {"category": "Launch", "month": 1, "amount": 50000},
        {"category": "Post-open support", "month": 14, "amount": 8000},
    ]
    created = _create(client, cost_schedule=schedule, opening_month_number=1)
    assert _stored(store, created["view_slug"])["cost_schedule"] == schedule


def test_opening_month_can_be_one(client, store):
    created = _create(client, opening_month_number=1)
    assert store.get_projection_by_slug(created["view_slug"])["opening_month_number"] == 1


def test_opening_month_can_be_far_in_future(client, store):
    created = _create(client, opening_month_number=18)
    assert store.get_projection_by_slug(created["view_slug"])["opening_month_number"] == 18


def test_row_on_high_month_number(client, store):
    schedule = [{"category": "Year 3 refit", "month": 30, "amount": 20000}]
    created = _create(client, cost_schedule=schedule)
    assert _stored(store, created["view_slug"])["cost_schedule"][0]["month"] == 30


# ----------------------------------------------------- numeric / serialization
def test_decimal_amount_preserved_through_create(client, store):
    schedule = [{"category": "X", "month": 1, "amount": 12345.67}]
    created = _create(client, cost_schedule=schedule)
    assert _stored(store, created["view_slug"])["cost_schedule"][0]["amount"] == 12345.67


def test_zero_amount_row_preserved(client, store):
    schedule = [{"category": "Placeholder", "month": 2, "amount": 0}]
    created = _create(client, cost_schedule=schedule)
    assert _stored(store, created["view_slug"])["cost_schedule"][0]["amount"] == 0


def test_many_categories_round_trip(client, store):
    schedule = [
        {"category": f"Cat {i}", "month": (i % 12) + 1, "amount": 100 + i}
        for i in range(40)
    ]
    created = _create(client, cost_schedule=schedule)
    stored = _stored(store, created["view_slug"])["cost_schedule"]
    assert stored == schedule
    assert len(stored) == 40


def test_duplicate_category_labels_allowed(client, store):
    # the user may add two rows with the same label on different months.
    schedule = [
        {"category": "Rent deposit", "month": 1, "amount": 5000},
        {"category": "Rent deposit", "month": 2, "amount": 5000},
    ]
    created = _create(client, cost_schedule=schedule)
    assert _stored(store, created["view_slug"])["cost_schedule"] == schedule


def test_unicode_category_label(client, store):
    schedule = [{"category": "Réno / café build-out", "month": 1, "amount": 9000}]
    created = _create(client, cost_schedule=schedule)
    assert _stored(store, created["view_slug"])["cost_schedule"][0]["category"] == \
        "Réno / café build-out"


# ------------------------------------------------------ default-state behaviour
def test_default_state_matches_helper(client, store):
    created = _create(client)
    row = store.get_projection_by_slug(created["view_slug"])
    assert json.loads(row["cost_schedule_json"]) == default_cost_schedule()
    assert row["opening_month_number"] == 1


def test_patch_then_default_does_not_resurrect_old_schedule(client, store):
    created = _create(client, cost_schedule=[{"category": "X", "month": 1, "amount": 10}])
    slug = created["view_slug"]
    # replace with a single different row
    client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": [{"category": "Y", "month": 2, "amount": 20}]}},
        headers=_headers(created, 1),
    )
    stored = _stored(store, slug)["cost_schedule"]
    assert stored == [{"category": "Y", "month": 2, "amount": 20}]


def test_anchor_independent_of_schedule(client, store):
    # setting only the anchor on create leaves schedule unset in inputs_json
    created = _create(client, opening_month_number=8, target_opening_date="2027-03")
    stored = _stored(store, created["view_slug"])
    assert stored["opening_month_number"] == 8
    assert stored["target_opening_date"] == "2027-03"
    assert stored.get("cost_schedule") is None

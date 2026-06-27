"""W1 data-model spine — timed cost schedule + opening anchor (Spec §5/§7; #113).

Covers the four acceptance pillars:
  1. ``engine.model`` exposes a default-schedule helper derived from ``STARTUP``.
  2. m0005 is an additive ``ALTER TABLE ADD COLUMN`` migration (no DROP) that the
     migration-safety gate accepts, and it adds the three projection columns.
  3. Legacy/seeded rows backfill to the month-1 lump default (``opening_month_number=1``),
     a value that equals the ``STARTUP`` constant amounts (parity assertion).
  4. ``InputsIn`` validates ``month>=1``/``amount>=0``/``opening_month_number>=1`` and
     create + PATCH round-trip the schedule + anchor through ``inputs_json``.
"""
from __future__ import annotations

import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import get_store
from app.store.migration_safety import assert_migrations_additive, scan_sql
from app.store.migrations import MIGRATIONS, m0005_cost_schedule
from app.store.sqlite import SqliteStore
from engine.model import (
    DEFAULT_OPENING_MONTH_NUMBER,
    STARTUP,
    default_cost_schedule,
)


# --------------------------------------------------------------------- fixtures
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


VALID_INPUTS = {
    "org_name": "House of Hope",
    "city": "Longview, Texas",
    "opening_status": "pre_launch",
    "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
    "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
    "source_of_funds": "300000", "occupancy_annual": "120000",
    "lease_type": "nnn", "nnn_opex_annual": "0",
}


def _body(**input_overrides):
    return {
        "name": "House of Hope",
        "inputs": {**VALID_INPUTS, **input_overrides},
        "trade_area": {"basis": "city", "households": "31798"},
        "assumptions": {"labor_pct": "0.60"},
    }


def _create(client, **input_overrides):
    r = client.post("/api/projections", json=_body(**input_overrides))
    assert r.status_code == 201, r.text
    return r.json()


# ----------------------------------------------------- 1. engine.model default
def test_default_cost_schedule_parity_with_startup():
    """The default schedule == the legacy STARTUP constant amounts, at month 1."""
    schedule = default_cost_schedule()
    assert {item["category"]: item["amount"] for item in schedule} == dict(STARTUP)
    assert all(item["month"] == 1 for item in schedule)
    assert len(schedule) == len(STARTUP)
    # the lump total reproduces today's fixed startup total exactly
    assert sum(item["amount"] for item in schedule) == sum(STARTUP.values())


def test_default_opening_month_is_one():
    assert DEFAULT_OPENING_MONTH_NUMBER == 1


# ------------------------------------------------------- 2. additive migration
def test_m0005_registered_in_order():
    names = [name for name, _ in MIGRATIONS]
    assert "0005_cost_schedule" in names
    # append-only discipline: m0005 follows its predecessor m0004; later
    # migrations append after it, never before (so assert order, not a tail).
    assert names.index("0005_cost_schedule") == names.index("0004_narrative_edit_origin") + 1


def test_m0005_is_additive_only():
    assert scan_sql(m0005_cost_schedule.SQL) == []
    # the whole shipped list (including m0005) passes the CI additive gate
    assert assert_migrations_additive(MIGRATIONS) is None


def test_migration_adds_the_three_columns(store):
    cols = {
        r[1]
        for r in store._conn.execute("PRAGMA table_info(projections)").fetchall()
    }
    assert {"target_opening_date", "opening_month_number", "cost_schedule_json"} <= cols


# --------------------------------------------------- 3. legacy-row backfill
def test_legacy_row_backfills_to_month1_lump_default(tmp_path):
    """A row written under the pre-m0005 schema backfills to the month-1 lump
    default when m0005 runs — opening_month_number=1 and a schedule equal to the
    STARTUP constant (the additive ADD COLUMN DEFAULT does the backfill)."""
    db = tmp_path / "legacy.db"
    con = sqlite3.connect(db)
    # Apply every migration BEFORE m0005 (the legacy schema).
    for name, sql in MIGRATIONS:
        if name == "0005_cost_schedule":
            break
        con.executescript(sql)
    # A legacy projection row (no schedule columns exist yet).
    con.execute(
        "INSERT INTO projections "
        "(id, view_slug, owner_token_hash, name, model_version, "
        " compute_schema_version, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        ("p1", "slug1", "hash1", "Legacy", "1.0.0", "1.0.0", "now", "now"),
    )
    con.commit()
    # Now apply the additive m0005 migration.
    con.executescript(m0005_cost_schedule.SQL)
    con.commit()
    row = con.execute(
        "SELECT opening_month_number, target_opening_date, cost_schedule_json "
        "FROM projections WHERE id = 'p1'"
    ).fetchone()
    con.close()
    opening, target, schedule_json = row
    assert opening == 1
    assert target is None
    assert json.loads(schedule_json) == default_cost_schedule()


# ---------------------------------------------------- 4. validation + round-trip
def test_create_round_trips_schedule_and_anchor(client, store):
    schedule = [
        {"category": "Build-out", "month": 2, "amount": 50000},
        {"category": "Consultant", "month": 1, "amount": 100000},
    ]
    created = _create(
        client,
        cost_schedule=schedule,
        target_opening_date="2026-09",
        opening_month_number=6,
    )
    row = store.get_projection_by_slug(created["view_slug"])
    stored_inputs = json.loads(row["inputs_json"])
    # canonical copy round-trips through inputs_json (what the engine consumes)
    assert stored_inputs["cost_schedule"] == schedule
    assert stored_inputs["target_opening_date"] == "2026-09"
    assert stored_inputs["opening_month_number"] == 6
    # denormalized columns mirror it
    assert json.loads(row["cost_schedule_json"]) == schedule
    assert row["opening_month_number"] == 6
    assert row["target_opening_date"] == "2026-09"


def test_create_without_schedule_backfills_default_columns(client, store):
    created = _create(client)
    row = store.get_projection_by_slug(created["view_slug"])
    assert json.loads(row["cost_schedule_json"]) == default_cost_schedule()
    assert row["opening_month_number"] == 1
    # absent from inputs_json -> the engine/migration default applies downstream
    assert "cost_schedule" not in json.loads(row["inputs_json"]) or \
        json.loads(row["inputs_json"])["cost_schedule"] is None


@pytest.mark.parametrize(
    "bad",
    [
        {"cost_schedule": [{"category": "X", "month": 0, "amount": 10}]},
        {"cost_schedule": [{"category": "X", "month": 1, "amount": -1}]},
        {"opening_month_number": 0},
    ],
)
def test_create_rejects_bad_schedule(client, bad):
    r = client.post("/api/projections", json=_body(**bad))
    assert r.status_code == 422, r.text


def test_patch_round_trips_schedule(client, store):
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    new_schedule = [{"category": "Equipment", "month": 3, "amount": 45000}]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {
            "cost_schedule": new_schedule,
            "opening_month_number": 4,
            "target_opening_date": "2027-01",
        }},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    row = store.get_projection_by_slug(slug)
    stored = json.loads(row["inputs_json"])
    assert stored["cost_schedule"] == new_schedule
    assert stored["opening_month_number"] == 4
    assert json.loads(row["cost_schedule_json"]) == new_schedule
    assert row["opening_month_number"] == 4


@pytest.mark.parametrize(
    "bad",
    [
        {"cost_schedule": [{"category": "X", "month": 0, "amount": 1}]},
        {"cost_schedule": [{"category": "X", "month": 1, "amount": -5}]},
        {"opening_month_number": 0},
    ],
)
def test_patch_rejects_bad_schedule(client, bad):
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": bad},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
    )
    assert r.status_code == 422, r.text

"""W1 data-model spine — m0005 additive migration mechanics (Spec §7; #113).

Acceptance: an additive ``ALTER TABLE ADD COLUMN`` migration (no DROP/recreate)
that the additive-only safety gate accepts; legacy/seeded rows backfill to the
month-1 lump default (``opening_month_number = 1``) with a schedule equal to the
``STARTUP`` constant amounts. These tests drive the migration in isolation and via
the real ``SqliteStore.migrate`` boot path.
"""
from __future__ import annotations

import json
import sqlite3

import pytest

from app.store.migration_safety import (
    MigrationSafetyError,
    assert_migrations_additive,
    scan_sql,
)
from app.store.migrations import MIGRATIONS, m0005_cost_schedule
from app.store.sqlite import SqliteStore
from engine.model import default_cost_schedule

_NAME = "0005_cost_schedule"
_NEW_COLUMNS = {"target_opening_date", "opening_month_number", "cost_schedule_json"}


# ----------------------------------------------------------- registration
def test_m0005_is_registered():
    names = [name for name, _ in MIGRATIONS]
    assert _NAME in names


def test_m0005_is_appended_last():
    # Append-only discipline (migrations are an ordered, append-only list).
    assert MIGRATIONS[-1][0] == _NAME


def test_m0005_has_nonempty_sql():
    sql = dict(MIGRATIONS)[_NAME]
    assert sql.strip()
    assert "ADD COLUMN" in sql.upper()


def test_migration_names_are_unique():
    names = [name for name, _ in MIGRATIONS]
    assert len(names) == len(set(names))


# ----------------------------------------------------------- additive safety
def test_m0005_sql_is_additive():
    assert scan_sql(m0005_cost_schedule.SQL) == []


def test_full_migration_list_passes_additive_gate():
    assert assert_migrations_additive(MIGRATIONS) is None


def test_m0005_contains_no_drop_or_rename():
    upper = m0005_cost_schedule.SQL.upper()
    assert "DROP" not in upper
    assert "RENAME" not in upper
    assert "DELETE" not in upper
    assert "TRUNCATE" not in upper


def test_m0005_only_alters_projections_table():
    # Every ALTER targets the projections table (additive column adds).
    for line in m0005_cost_schedule.SQL.splitlines():
        s = line.strip()
        if s.upper().startswith("ALTER TABLE"):
            assert "projections" in s


def test_a_destructive_variant_would_be_caught():
    # Sanity: the gate that protects m0005 actually rejects a destructive sibling.
    bad = [(_NAME, "ALTER TABLE projections DROP COLUMN cost_schedule_json;")]
    with pytest.raises(MigrationSafetyError):
        assert_migrations_additive(bad)


# ----------------------------------------------------------- columns added
def _columns(con) -> dict:
    return {
        r[1]: r for r in con.execute("PRAGMA table_info(projections)").fetchall()
    }


def test_migrate_adds_all_three_columns():
    store = SqliteStore(":memory:")
    store.migrate()
    cols = set(_columns(store._conn).keys())
    assert _NEW_COLUMNS <= cols


def test_opening_month_number_column_is_integer():
    store = SqliteStore(":memory:")
    store.migrate()
    info = _columns(store._conn)["opening_month_number"]
    # PRAGMA table_info: (cid, name, type, notnull, dflt_value, pk)
    assert info[2].upper() == "INTEGER"
    assert info[3] == 1  # NOT NULL
    assert info[4] is not None  # has a DEFAULT


def test_cost_schedule_json_column_is_text_with_default():
    store = SqliteStore(":memory:")
    store.migrate()
    info = _columns(store._conn)["cost_schedule_json"]
    assert info[2].upper() == "TEXT"
    assert info[3] == 1  # NOT NULL
    assert info[4] is not None  # has a DEFAULT


def test_target_opening_date_column_is_nullable_text():
    store = SqliteStore(":memory:")
    store.migrate()
    info = _columns(store._conn)["target_opening_date"]
    assert info[2].upper() == "TEXT"
    assert info[3] == 0  # nullable


def test_migration_recorded_in_schema_migrations():
    store = SqliteStore(":memory:")
    store.migrate()
    applied = {
        r[0] for r in store._conn.execute("SELECT name FROM schema_migrations")
    }
    assert _NAME in applied


def test_migrate_is_idempotent():
    store = SqliteStore(":memory:")
    store.migrate()
    # Running migrate again must not raise (already-applied migrations are skipped).
    store.migrate()
    cols = set(_columns(store._conn).keys())
    assert _NEW_COLUMNS <= cols


# ----------------------------------------------------------- legacy backfill
def _apply_pre_m0005(con) -> None:
    for name, sql in MIGRATIONS:
        if name == _NAME:
            break
        con.executescript(sql)


def _insert_legacy_row(con, pid: str, slug: str) -> None:
    con.execute(
        "INSERT INTO projections "
        "(id, view_slug, owner_token_hash, name, model_version, "
        " compute_schema_version, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (pid, slug, "ownerhash", "Legacy", "1.0.0", "1.0.0", "now", "now"),
    )


def test_legacy_row_backfills_opening_month_to_one(tmp_path):
    db = tmp_path / "legacy.db"
    con = sqlite3.connect(db)
    _apply_pre_m0005(con)
    _insert_legacy_row(con, "p1", "slug1")
    con.commit()
    con.executescript(m0005_cost_schedule.SQL)
    con.commit()
    opening = con.execute(
        "SELECT opening_month_number FROM projections WHERE id='p1'"
    ).fetchone()[0]
    con.close()
    assert opening == 1


def test_legacy_row_backfills_schedule_to_startup_lump(tmp_path):
    db = tmp_path / "legacy.db"
    con = sqlite3.connect(db)
    _apply_pre_m0005(con)
    _insert_legacy_row(con, "p1", "slug1")
    con.commit()
    con.executescript(m0005_cost_schedule.SQL)
    con.commit()
    schedule_json = con.execute(
        "SELECT cost_schedule_json FROM projections WHERE id='p1'"
    ).fetchone()[0]
    con.close()
    assert json.loads(schedule_json) == default_cost_schedule()


def test_legacy_row_backfills_target_opening_date_null(tmp_path):
    db = tmp_path / "legacy.db"
    con = sqlite3.connect(db)
    _apply_pre_m0005(con)
    _insert_legacy_row(con, "p1", "slug1")
    con.commit()
    con.executescript(m0005_cost_schedule.SQL)
    con.commit()
    target = con.execute(
        "SELECT target_opening_date FROM projections WHERE id='p1'"
    ).fetchone()[0]
    con.close()
    assert target is None


def test_multiple_legacy_rows_all_backfill(tmp_path):
    db = tmp_path / "legacy.db"
    con = sqlite3.connect(db)
    _apply_pre_m0005(con)
    for i in range(5):
        _insert_legacy_row(con, f"p{i}", f"slug{i}")
    con.commit()
    con.executescript(m0005_cost_schedule.SQL)
    con.commit()
    rows = con.execute(
        "SELECT opening_month_number, cost_schedule_json FROM projections"
    ).fetchall()
    con.close()
    assert len(rows) == 5
    for opening, schedule_json in rows:
        assert opening == 1
        assert json.loads(schedule_json) == default_cost_schedule()


def test_backfilled_schedule_total_equals_startup(tmp_path):
    db = tmp_path / "legacy.db"
    con = sqlite3.connect(db)
    _apply_pre_m0005(con)
    _insert_legacy_row(con, "p1", "slug1")
    con.commit()
    con.executescript(m0005_cost_schedule.SQL)
    con.commit()
    schedule_json = con.execute(
        "SELECT cost_schedule_json FROM projections WHERE id='p1'"
    ).fetchone()[0]
    con.close()
    schedule = json.loads(schedule_json)
    from engine.model import STARTUP

    assert sum(r["amount"] for r in schedule) == sum(STARTUP.values())


def test_pre_m0005_schema_lacks_new_columns(tmp_path):
    # Confirms the legacy schema genuinely predates the columns (so the backfill
    # above is a real ADD COLUMN backfill, not a no-op).
    db = tmp_path / "legacy.db"
    con = sqlite3.connect(db)
    _apply_pre_m0005(con)
    cols = {r[1] for r in con.execute("PRAGMA table_info(projections)").fetchall()}
    con.close()
    assert not (_NEW_COLUMNS & cols)


def test_default_column_value_parses_as_json(tmp_path):
    db = tmp_path / "fresh.db"
    store = SqliteStore(str(db))
    store.migrate()
    # The DEFAULT literal embedded in the DDL must be valid JSON.
    store._conn.execute(
        "INSERT INTO projections "
        "(id, view_slug, owner_token_hash, name, model_version, "
        " compute_schema_version, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        ("p1", "slug1", "h", "n", "1", "1", "now", "now"),
    )
    store._conn.commit()
    schedule_json = store._conn.execute(
        "SELECT cost_schedule_json FROM projections WHERE id='p1'"
    ).fetchone()[0]
    assert json.loads(schedule_json) == default_cost_schedule()

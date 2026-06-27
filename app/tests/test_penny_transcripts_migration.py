"""PE2 data-model spine — m0006 additive migration mechanics (Spec §7; issue #121).

Acceptance: an additive migration (``CREATE TABLE IF NOT EXISTS`` for
``penny_transcripts`` + an ``ALTER TABLE ADD COLUMN`` for the revision ``actor``
enum) that the additive-only safety gate accepts — no DROP/RENAME/DELETE, Postgres
path stays drop-in. These tests drive the migration in isolation and via the real
``SqliteStore.migrate`` boot path.
"""
from __future__ import annotations

import sqlite3

import pytest

from app.store.migration_safety import (
    MigrationSafetyError,
    assert_migrations_additive,
    scan_sql,
)
from app.store.migrations import MIGRATIONS, m0006_penny_transcripts
from app.store.sqlite import SqliteStore

_NAME = "0006_penny_transcripts"
_TRANSCRIPT_COLUMNS = {"id", "projection_id", "turns_json", "created_at", "updated_at"}


# ----------------------------------------------------------- registration
def test_m0006_is_registered():
    names = [name for name, _ in MIGRATIONS]
    assert _NAME in names


def test_m0006_is_appended_in_order():
    # Append-only discipline (migrations are an ordered, append-only list): m0006
    # sits immediately after m0005. Later migrations (e.g. m0007) append AFTER it —
    # assert relative order, not a frozen tail position.
    names = [name for name, _ in MIGRATIONS]
    assert names.index(_NAME) == names.index("0005_cost_schedule") + 1


def test_m0006_has_nonempty_sql():
    sql = dict(MIGRATIONS)[_NAME]
    assert sql.strip()
    assert "PENNY_TRANSCRIPTS" in sql.upper()


def test_migration_names_are_unique():
    names = [name for name, _ in MIGRATIONS]
    assert len(names) == len(set(names))


# ----------------------------------------------------------- additive safety
def test_m0006_sql_is_additive():
    assert scan_sql(m0006_penny_transcripts.SQL) == []


def test_full_migration_list_passes_additive_gate():
    assert assert_migrations_additive(MIGRATIONS) is None


def test_m0006_contains_no_destructive_ddl():
    upper = m0006_penny_transcripts.SQL.upper()
    assert "DROP" not in upper
    assert "RENAME" not in upper
    assert "DELETE" not in upper
    assert "TRUNCATE" not in upper


def test_a_destructive_variant_would_be_caught():
    # Sanity: the gate that protects m0006 actually rejects a destructive sibling.
    bad = [(_NAME, "DROP TABLE penny_transcripts;")]
    with pytest.raises(MigrationSafetyError):
        assert_migrations_additive(bad)


# ----------------------------------------------------------- table created
def _tables(con) -> set:
    return {
        r[0]
        for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }


def _columns(con, table: str) -> dict:
    return {r[1]: r for r in con.execute(f"PRAGMA table_info({table})").fetchall()}


def test_migrate_creates_penny_transcripts_table():
    store = SqliteStore(":memory:")
    store.migrate()
    assert "penny_transcripts" in _tables(store._conn)


def test_penny_transcripts_has_all_columns():
    store = SqliteStore(":memory:")
    store.migrate()
    cols = set(_columns(store._conn, "penny_transcripts").keys())
    assert _TRANSCRIPT_COLUMNS <= cols


def test_projection_id_is_nullable():
    # NULL projection_id is the (never-persisted) ephemeral wizard-draft shape; the
    # column must permit NULL so the FK does not force a row to exist.
    store = SqliteStore(":memory:")
    store.migrate()
    info = _columns(store._conn, "penny_transcripts")["projection_id"]
    # PRAGMA table_info: (cid, name, type, notnull, dflt_value, pk)
    assert info[3] == 0  # nullable


def test_turns_json_is_text_not_null_with_default():
    store = SqliteStore(":memory:")
    store.migrate()
    info = _columns(store._conn, "penny_transcripts")["turns_json"]
    assert info[2].upper() == "TEXT"
    assert info[3] == 1  # NOT NULL
    assert info[4] is not None  # has a DEFAULT ('[]')


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
    store.migrate()  # second run must not raise / duplicate
    assert "penny_transcripts" in _tables(store._conn)


# ----------------------------------------------------------- revision actor enum
def test_revisions_gains_actor_column():
    store = SqliteStore(":memory:")
    store.migrate()
    cols = _columns(store._conn, "revisions")
    assert "actor" in cols
    # NOT NULL + defaults to 'user' so legacy revisions read back attributable.
    assert cols["actor"][3] == 1
    assert cols["actor"][4] is not None


def test_legacy_revision_backfills_actor_user(tmp_path):
    db = tmp_path / "legacy.db"
    con = sqlite3.connect(db)
    for name, sql in MIGRATIONS:
        if name == _NAME:
            break
        con.executescript(sql)
    con.execute(
        "INSERT INTO projections "
        "(id, view_slug, owner_token_hash, name, model_version, "
        " compute_schema_version, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        ("p1", "slug1", "h", "Legacy", "1", "1", "now", "now"),
    )
    con.execute(
        "INSERT INTO revisions "
        "(id, projection_id, seq, inputs_json, assumptions_json, overrides_json, "
        " monthly_json, computed_json, model_version, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        ("r1", "p1", 1, "{}", "{}", "{}", "{}", "{}", "1", "now"),
    )
    con.commit()
    con.executescript(m0006_penny_transcripts.SQL)
    con.commit()
    actor = con.execute("SELECT actor FROM revisions WHERE id='r1'").fetchone()[0]
    con.close()
    assert actor == "user"


def test_existing_tables_survive_m0006(tmp_path):
    # Additive discipline: m0006 must not disturb pre-existing rows.
    db = tmp_path / "legacy.db"
    con = sqlite3.connect(db)
    for name, sql in MIGRATIONS:
        if name == _NAME:
            break
        con.executescript(sql)
    con.execute(
        "INSERT INTO projections "
        "(id, view_slug, owner_token_hash, name, model_version, "
        " compute_schema_version, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        ("p1", "slug1", "h", "Legacy", "1", "1", "now", "now"),
    )
    con.commit()
    con.executescript(m0006_penny_transcripts.SQL)
    con.commit()
    row = con.execute(
        "SELECT id, view_slug, name FROM projections WHERE id='p1'"
    ).fetchone()
    con.close()
    assert row == ("p1", "slug1", "Legacy")

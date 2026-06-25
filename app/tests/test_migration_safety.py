"""M7 hardening — additive-migration safety check (CLAUDE.md DB discipline / DATA_MODEL §8).

The DB rule is additive-only: ``CREATE TABLE IF NOT EXISTS`` / ``ALTER TABLE ADD
COLUMN`` only. NEVER ``DROP TABLE`` / ``DROP COLUMN`` / ``RENAME`` / destructive
``ALTER``. This guard scans the real MIGRATIONS list (the migration that ships) and
is meant to fail CI the moment a non-additive statement is introduced — the kind of
thing a restore drill cannot save you from because the schema change already ran.
"""
from __future__ import annotations

import pytest

from app.store.migration_safety import (
    MigrationSafetyError,
    assert_migrations_additive,
    scan_sql,
)
from app.store.migrations import MIGRATIONS


def test_shipped_migrations_are_all_additive():
    # The real, append-only MIGRATIONS list must pass the additive-only gate
    # (returns None, raises on violation).
    assert assert_migrations_additive(MIGRATIONS) is None


@pytest.mark.parametrize(
    "sql",
    [
        "DROP TABLE projections;",
        "drop   table  IF EXISTS revisions;",
        "ALTER TABLE projections DROP COLUMN name;",
        "ALTER TABLE projections RENAME TO old_projections;",
        "ALTER TABLE projections RENAME COLUMN name TO title;",
        "DELETE FROM projections;",
        "TRUNCATE TABLE projections;",
        "ALTER TABLE projections ALTER COLUMN name TYPE INTEGER;",
        "CREATE TABLE x (id TEXT); DROP TABLE projections;",  # destructive hidden in a batch
    ],
)
def test_destructive_statements_are_rejected(sql):
    violations = scan_sql(sql)
    assert violations, f"expected a violation for: {sql!r}"


@pytest.mark.parametrize(
    "sql",
    [
        "CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY);",
        "ALTER TABLE narratives ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}';",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx ON t(id);",
        "CREATE INDEX IF NOT EXISTS idx2 ON t(a, b);",
        # a column literally named "drop_off_count" must not trip the DROP scan
        "ALTER TABLE t ADD COLUMN drop_off_count INTEGER NOT NULL DEFAULT 0;",
        # a default string containing the word "drop table" must not trip it
        "ALTER TABLE t ADD COLUMN note TEXT NOT NULL DEFAULT 'drop table allowed';",
    ],
)
def test_additive_statements_pass(sql):
    assert scan_sql(sql) == []


def test_assert_raises_with_named_migration():
    bad = [("0001_init", "CREATE TABLE t (id TEXT);"),
           ("0099_bad", "DROP TABLE projections;")]
    with pytest.raises(MigrationSafetyError) as ei:
        assert_migrations_additive(bad)
    msg = str(ei.value)
    assert "0099_bad" in msg
    assert "DROP TABLE" in msg.upper()
    # a passing migration name is not implicated
    assert "0001_init" not in msg


def test_store_migrate_refuses_non_additive(tmp_path, monkeypatch):
    # A destructive migration must be rejected at boot BEFORE it can run against the
    # durable volume (fail-closed, CLAUDE.md "refuse to boot" discipline).
    import app.store.sqlite as sqlite_mod
    from app.store.sqlite import SqliteStore

    bad = [("0001_init", "CREATE TABLE t (id TEXT);"),
           ("0099_drop", "DROP TABLE t;")]
    monkeypatch.setattr(sqlite_mod, "MIGRATIONS", bad)
    store = SqliteStore(str(tmp_path / "boot.db"))
    with pytest.raises(MigrationSafetyError):
        store.migrate()


def test_store_migrate_refuses_before_running_destructive_sql(tmp_path, monkeypatch):
    # The gate must run BEFORE any DDL executes — the destructive statement must not
    # have touched the DB (no `t` table created from the additive first entry either,
    # because the whole list is validated up front).
    import sqlite3

    import app.store.sqlite as sqlite_mod
    from app.store.sqlite import SqliteStore

    bad = [("0001_init", "CREATE TABLE t (id TEXT);"),
           ("0099_drop", "DROP TABLE projections;")]
    monkeypatch.setattr(sqlite_mod, "MIGRATIONS", bad)
    db = tmp_path / "boot.db"
    store = SqliteStore(str(db))
    with pytest.raises(MigrationSafetyError):
        store.migrate()
    # No app table was created (the gate short-circuited the whole run).
    con = sqlite3.connect(db)
    names = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    con.close()
    assert "t" not in names


def test_store_migrate_applies_real_additive_migrations(tmp_path):
    # The real, additive MIGRATIONS pass the gate and produce the v1 schema.
    import sqlite3

    from app.store.sqlite import SqliteStore

    db = tmp_path / "ok.db"
    store = SqliteStore(str(db))
    store.migrate()  # must not raise
    con = sqlite3.connect(db)
    names = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    con.close()
    assert "projections" in names
    assert "revisions" in names
    assert "schema_migrations" in names


def test_each_shipped_migration_individually_additive():
    # Every entry on its own is additive (defends against a future append).
    for name, sql in MIGRATIONS:
        assert scan_sql(sql) == [], f"{name} introduced a non-additive statement"


def test_violation_list_dedupes_per_migration():
    # Two DROP TABLEs in one migration report the DROP TABLE label once per match
    # set (the label vocabulary is stable / human-readable).
    violations = scan_sql("DROP TABLE a; DROP TABLE b;")
    assert "DROP TABLE" in violations


def test_create_then_alter_add_column_is_additive():
    sql = """
    CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY);
    ALTER TABLE t ADD COLUMN extra TEXT NOT NULL DEFAULT '';
    """
    assert scan_sql(sql) == []
    assert assert_migrations_additive([("0001", sql)]) is None


def test_comments_and_strings_do_not_false_positive():
    sql = """
    -- this migration does NOT drop table anything
    /* nor does this block comment drop column foo */
    CREATE TABLE IF NOT EXISTS t (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT 'do not drop column'
    );
    """
    assert scan_sql(sql) == []

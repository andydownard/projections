"""M7.4 — pre-migration Litestream checkpoint + boot-order invariants.

OPS_RUNBOOK §8.2 / SECURITY §12 / CLAUDE.md DB discipline: the boot sequence forces
a Litestream checkpoint/snapshot BEFORE applying any pending migration, creating a
clean pre-migration restore point. These tests assert the *ordering* (checkpoint runs
before any migration DDL), that it runs only when there is pending work (idempotent
re-run is a no-op), the default checkpoint behaviour (a truncating WAL checkpoint that
the continuous Litestream replica then ships), and the day-one ``actuals`` regression.
"""
from __future__ import annotations

import sqlite3

import app.store.sqlite as sqlite_mod
from app.store.litestream import force_pre_migration_checkpoint
from app.store.migrations import MIGRATIONS, m0001_init
from app.store.sqlite import SqliteStore


def _tables(db_path: str) -> set[str]:
    con = sqlite3.connect(db_path)
    try:
        return {r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        con.close()


def test_checkpoint_runs_before_pending_migration_ddl(tmp_path, monkeypatch):
    # A single pending migration creating table `t`. The checkpoint hook must fire
    # BEFORE `t` is created — proving the restore point precedes the schema change.
    monkeypatch.setattr(sqlite_mod, "MIGRATIONS",
                        [("0001_init", "CREATE TABLE t (id TEXT);")])
    holder: dict = {}
    events: list = []

    def spy() -> None:
        names = {r[0] for r in holder["store"]._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        events.append(("checkpoint", "t" in names))

    db = tmp_path / "boot.db"
    store = SqliteStore(str(db), checkpoint=spy)
    holder["store"] = store
    store.migrate()

    # checkpoint fired exactly once, and `t` did NOT exist when it fired
    assert events == [("checkpoint", False)]
    # and the migration did apply afterwards
    assert "t" in _tables(str(db))


def test_checkpoint_skipped_when_no_pending_migrations(tmp_path):
    # First migrate has pending work -> one checkpoint. A second migrate has nothing
    # pending -> NO further checkpoint (idempotent; we never snapshot for a no-op).
    calls: list = []
    db = tmp_path / "boot.db"
    store = SqliteStore(str(db), checkpoint=lambda: calls.append(1))
    store.migrate()
    assert calls == [1]  # real MIGRATIONS all pending on first boot -> one checkpoint
    store.migrate()
    assert calls == [1]  # re-run: nothing pending -> no extra checkpoint


def test_checkpoint_forced_once_per_boot_not_per_migration(tmp_path, monkeypatch):
    # Two pending migrations -> the pre-migration checkpoint is forced ONCE for the
    # whole batch (a single restore point), not once per migration.
    monkeypatch.setattr(sqlite_mod, "MIGRATIONS",
                        [("0001_init", "CREATE TABLE a (id TEXT);"),
                          ("0002_more", "CREATE TABLE b (id TEXT);")])
    calls: list = []
    store = SqliteStore(str(tmp_path / "boot.db"), checkpoint=lambda: calls.append(1))
    store.migrate()
    assert calls == [1]


def test_idempotent_rerun_no_double_apply(tmp_path):
    # Re-running an already-applied migration is a no-op: no error, ledger stable.
    db = tmp_path / "boot.db"
    store = SqliteStore(str(db))
    store.migrate()
    con = sqlite3.connect(db)
    first = {r[0] for r in con.execute("SELECT name FROM schema_migrations")}
    con.close()
    store.migrate()  # must not raise nor re-apply
    con = sqlite3.connect(db)
    second = {r[0] for r in con.execute("SELECT name FROM schema_migrations")}
    con.close()
    assert first == second
    assert len(second) == len(MIGRATIONS)


def test_default_checkpoint_truncates_wal_returns_status(tmp_path):
    # The default hook performs a truncating WAL checkpoint and reports status.
    db = tmp_path / "x.db"
    con = sqlite3.connect(db)
    con.execute("PRAGMA journal_mode=WAL;")
    con.execute("CREATE TABLE t (id TEXT);")
    con.execute("INSERT INTO t VALUES ('a');")
    con.commit()
    status = force_pre_migration_checkpoint(con, db_path=str(db), env={})
    con.close()
    assert status == "wal-checkpoint"  # Litestream not configured (empty env)


def test_default_checkpoint_reports_replicating_when_litestream_configured(tmp_path):
    db = tmp_path / "x.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE t (id TEXT);")
    con.commit()
    status = force_pre_migration_checkpoint(
        con, db_path=str(db), env={"LITESTREAM_BUCKET": "my-bucket"})
    con.close()
    assert status == "replicating"


def test_default_checkpoint_tolerates_checkpoint_error():
    # A benign checkpoint failure (e.g. closed connection) must NOT raise — the
    # additive-only guarantee, not the checkpoint, is what makes the migration safe.
    con = sqlite3.connect(":memory:")
    con.close()  # now any execute() raises sqlite3.ProgrammingError (a sqlite3.Error)
    status = force_pre_migration_checkpoint(con, db_path="dead", env={})
    assert status == "wal-checkpoint"  # returned, did not raise


def test_migrate_default_checkpoint_path_does_not_raise(tmp_path):
    # No injected checkpoint -> the real force_pre_migration_checkpoint runs against
    # the store connection and the migration still completes.
    db = tmp_path / "real.db"
    store = SqliteStore(str(db))
    store.migrate()  # exercises the default (non-injected) checkpoint branch
    assert "projections" in _tables(str(db))


def test_actuals_table_exists_from_initial_migration(tmp_path):
    # Regression (PRD §24): the actuals table ships in 0001_init so post-launch
    # actuals are NEVER a later migration. Assert both the source and the live DB.
    assert "CREATE TABLE IF NOT EXISTS actuals" in m0001_init.SQL
    db = tmp_path / "real.db"
    store = SqliteStore(str(db))
    store.migrate()
    assert "actuals" in _tables(str(db))


def test_actuals_present_after_only_initial_migration(tmp_path, monkeypatch):
    # Even with ONLY 0001_init applied, actuals exists (it is not a later migration).
    monkeypatch.setattr(sqlite_mod, "MIGRATIONS", [("0001_init", m0001_init.SQL)])
    db = tmp_path / "init_only.db"
    store = SqliteStore(str(db))
    store.migrate()
    assert "actuals" in _tables(str(db))

"""Store robustness: atomic+idempotent migrations (#185), connection-per-request
reads (#177), and single-transaction version+revision writes (#186).

RED-first. These exercise the failure modes the prior design could not survive:
- a crash in the window between a migration's DDL commit and its ledger commit must
  recover on the next boot, NOT boot-crash-loop the single durable volume (#185);
- reads must run on their own per-thread connection so a slow query (or a writer)
  can never head-of-line-block another read or the healthcheck probe (#177);
- the version bump and its revision snapshot must commit together or not at all, and
  a duplicate ``(projection_id, seq)`` must fail loudly (#186).
"""
from __future__ import annotations

import sqlite3
import threading

import pytest

import app.store.sqlite as sqlite_mod
from app.store.migrations import MIGRATIONS
from app.store.sqlite import SqliteStore
from engine.model import COMPUTE_SCHEMA_VERSION, MODEL_VERSION


def _now() -> str:
    return "2026-01-01T00:00:00Z"


def _make_projection(store: SqliteStore, *, pid: str, slug: str, owner: str = "owner") -> None:
    store.create_projection({
        "id": pid,
        "view_slug": slug,
        "owner_token_hash": owner,
        "name": "P",
        "model_version": MODEL_VERSION,
        "compute_schema_version": COMPUTE_SCHEMA_VERSION,
        "created_at": _now(),
        "updated_at": _now(),
    })


def _revision(pid: str, seq: int) -> dict:
    return {
        "id": f"rev_{pid}_{seq}",
        "projection_id": pid,
        "seq": seq,
        "inputs_json": "{}",
        "assumptions_json": "{}",
        "overrides_json": "{}",
        "monthly_json": "{}",
        "computed_json": "{}",
        "model_version": MODEL_VERSION,
        "created_at": _now(),
    }


@pytest.fixture()
def file_store(tmp_path):
    s = SqliteStore(str(tmp_path / "robust.db"))
    s.migrate()
    return s


# =========================================================================
# #185 — atomic + idempotent migration apply
# =========================================================================

def test_crash_between_ddl_and_ledger_recovers_on_next_boot(tmp_path):
    # The exact #185 window: a migration's ADD COLUMN physically committed but its
    # schema_migrations ledger row never landed (crash/OOM between the two). On the
    # next boot the migration re-runs; a bare ALTER would raise "duplicate column
    # name" and boot-crash-loop. The runner must be idempotent and recover.
    db = tmp_path / "boot.db"
    s1 = SqliteStore(str(db))
    s1.migrate()  # healthy, fully migrated
    # Reproduce the crash window: drop the ledger rows for the ALTER-bearing
    # migrations while their columns remain physically present.
    s1._conn.execute(
        "DELETE FROM schema_migrations "
        "WHERE name IN ('0005_cost_schedule', '0006_penny_transcripts')"
    )
    s1._conn.commit()

    # Next boot opens the SAME file with a fresh store and migrates again.
    s2 = SqliteStore(str(db))
    s2.migrate()  # MUST NOT raise duplicate-column

    applied = {r[0] for r in s2._conn.execute("SELECT name FROM schema_migrations")}
    assert {"0005_cost_schedule", "0006_penny_transcripts"} <= applied


def test_full_rerun_on_migrated_db_is_noop(tmp_path):
    # Re-running the ENTIRE migration set against an already-migrated DB (e.g. a
    # wiped/empty ledger) must be a clean no-op: every ALTER ADD COLUMN is guarded,
    # so it never raises and simply re-records the ledger.
    db = tmp_path / "boot.db"
    s1 = SqliteStore(str(db))
    s1.migrate()
    s1._conn.execute("DELETE FROM schema_migrations")  # ledger wiped; columns remain
    s1._conn.commit()

    s2 = SqliteStore(str(db))
    s2.migrate()  # must not raise
    applied = {r[0] for r in s2._conn.execute("SELECT name FROM schema_migrations")}
    assert {name for name, _ in MIGRATIONS} <= applied


def test_failed_migration_rolls_back_atomically(tmp_path, monkeypatch):
    # A migration whose later statement fails must leave NOTHING behind: the earlier
    # DDL is rolled back and the ledger row is NOT written (apply + ledger are one
    # transaction). SQLite rolls back DDL, so this is achievable.
    bad = "CREATE TABLE good_t (id TEXT);\nINSERT INTO nope_table VALUES ('x');"
    monkeypatch.setattr(sqlite_mod, "MIGRATIONS", [("0001_init", bad)])
    db = tmp_path / "boot.db"
    store = SqliteStore(str(db))
    with pytest.raises(sqlite3.OperationalError):
        store.migrate()

    tables = {
        r[0] for r in store._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert "good_t" not in tables  # rolled back
    applied = {r[0] for r in store._conn.execute("SELECT name FROM schema_migrations")}
    assert "0001_init" not in applied  # ledger not written


def test_idempotent_apply_only_swallows_duplicate_column(tmp_path, monkeypatch):
    # The idempotency guard must be narrow: it swallows "duplicate column name" only.
    # An unrelated OperationalError (here: no such table) still propagates.
    bad = "ALTER TABLE no_such_table ADD COLUMN x TEXT;"
    monkeypatch.setattr(sqlite_mod, "MIGRATIONS", [("0001_init", bad)])
    store = SqliteStore(str(tmp_path / "boot.db"))
    with pytest.raises(sqlite3.OperationalError):
        store.migrate()


def test_split_sql_statements_respects_semicolons_in_literals():
    # The statement splitter must not break a statement on a ';' inside a string
    # literal (otherwise the atomic single-statement apply would corrupt the DDL).
    sql = "INSERT INTO t VALUES ('a;b');\nCREATE TABLE u (id TEXT);"
    stmts = sqlite_mod._split_sql_statements(sql)
    assert len(stmts) == 2
    assert "'a;b'" in stmts[0]


# =========================================================================
# #177 — connection-per-request reads (WAL concurrency + healthcheck safety)
# =========================================================================

def test_file_reads_use_a_connection_distinct_from_the_writer(file_store):
    # Reads must NOT funnel through the single writer connection, or WAL concurrency
    # is nullified and a slow query blocks every other request.
    assert file_store._read_conn() is not file_store._conn


def test_each_thread_gets_its_own_reader_connection(file_store):
    # Regression (batch3 tracked flake): the ORIGINAL version of this test computed
    # `id(file_store._read_conn())` INSIDE each worker and stashed only the int,
    # never the connection object itself. `_read_conn()` caches the connection on
    # `threading.local()` (per-thread), but that cache entry is the ONLY strong
    # reference to it -- once a worker thread exits, CPython tears down its
    # thread-local storage, dropping that reference, and the connection object can
    # be garbage-collected immediately. With 5 short-lived threads racing, thread A's
    # connection can be freed and thread B's NEW connection allocated at the exact
    # same (now-recycled) memory address before every thread has joined -- so two
    # DIFFERENT, already-dead connections report the SAME `id()`, undercounting the
    # five distinct connections (proven flake: `assert 4 == 5`).
    #
    # Fix: hold a STRONG reference to every connection in `conns` for the whole test
    # (not just its id()), so all 5 stay alive SIMULTANEOUSLY when we finally compare
    # identities below -- `id()` is only guaranteed unique among objects that are
    # alive at the same time, which this now actually guarantees.
    conns: dict[int, sqlite3.Connection] = {}

    def worker(k: int) -> None:
        conns[k] = file_store._read_conn()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(conns) == 5
    assert len({id(c) for c in conns.values()}) == 5  # five distinct reader connections


def test_ping_probe_does_not_use_the_writer_connection(file_store):
    # The healthcheck probe reads via a per-thread reader, so it can never queue
    # behind a slow write holding the single writer and trip a restart loop.
    assert file_store.ping() is True
    assert file_store._read_conn() is not file_store._conn


def test_memory_store_reads_share_the_single_connection():
    # An in-memory DB is per-connection (a second connection sees an EMPTY db), so
    # reads MUST fall back to the primary connection — never a fresh empty one.
    s = SqliteStore(":memory:")
    s.migrate()
    assert s._read_conn() is s._conn


def test_concurrent_reads_during_writes_stay_consistent(file_store):
    # Functional smoke: many reader threads while a writer mutates — no errors, and
    # readers see committed data (WAL readers + serialized writer).
    _make_projection(file_store, pid="p1", slug="s1")
    errors: list[Exception] = []

    def reader() -> None:
        try:
            for _ in range(20):
                file_store.get_projection_by_slug("s1")
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    def writer() -> None:
        try:
            for v in range(1, 21):
                file_store.update_with_version_check("p1", v, {"name": f"n{v}"})
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=reader) for _ in range(4)]
    threads.append(threading.Thread(target=writer))
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert file_store.get_projection_by_slug("s1") is not None


# =========================================================================
# #186 — single-transaction version bump + revision snapshot
# =========================================================================

def test_update_and_revision_commit_together(file_store):
    _make_projection(file_store, pid="p1", slug="s1")
    affected = file_store.update_with_version_check_and_revision(
        "p1", 1, {"name": "renamed"}, _revision("p1", 2))
    assert affected == 1
    revs = file_store.list_revisions("p1")
    assert len(revs) == 1 and revs[0]["seq"] == 2
    assert file_store.get_projection_by_slug("s1")["version"] == 2


def test_conflict_writes_no_revision_and_returns_zero(file_store):
    _make_projection(file_store, pid="p1", slug="s1")
    # Stale expected_version -> 0 rows (409 path), and NO orphan revision row.
    affected = file_store.update_with_version_check_and_revision(
        "p1", 99, {"name": "x"}, _revision("p1", 100))
    assert affected == 0
    assert file_store.list_revisions("p1") == []
    assert file_store.get_projection_by_slug("s1")["version"] == 1


def test_revision_failure_rolls_back_the_version_bump(file_store):
    # The #186 hole: if the revision INSERT fails, the version++ must NOT persist
    # (no version with a missing snapshot). A duplicate revision PK forces the
    # failure; the whole transaction rolls back.
    _make_projection(file_store, pid="p1", slug="s1")
    file_store.insert_revision(_revision("p1", 2))  # rev id rev_p1_2 already exists
    with pytest.raises(sqlite3.IntegrityError):
        file_store.update_with_version_check_and_revision(
            "p1", 1, {"name": "renamed"}, _revision("p1", 2))  # dup id -> fails
    # version stayed at 1 (bump rolled back), only the original revision exists
    assert file_store.get_projection_by_slug("s1")["version"] == 1
    assert len(file_store.list_revisions("p1")) == 1


def test_unique_projection_seq_rejects_duplicate(file_store):
    # The DB-level backstop (#186): a duplicate (projection_id, seq) fails loudly
    # with IntegrityError instead of silently corrupting the restore/audit trail.
    _make_projection(file_store, pid="p1", slug="s1")
    file_store.insert_revision(_revision("p1", 2))
    dup = _revision("p1", 2)
    dup["id"] = "rev_other"  # different PK, same (projection_id, seq)
    with pytest.raises(sqlite3.IntegrityError):
        file_store.insert_revision(dup)


def test_same_seq_different_projection_is_allowed(file_store):
    # The UNIQUE backstop is scoped per projection: seq=2 may exist once per
    # projection. Two different projections both having seq=2 is legal.
    _make_projection(file_store, pid="p1", slug="s1")
    _make_projection(file_store, pid="p2", slug="s2")
    file_store.insert_revision(_revision("p1", 2))
    file_store.insert_revision(_revision("p2", 2))  # must not raise
    assert len(file_store.list_revisions("p1")) == 1
    assert len(file_store.list_revisions("p2")) == 1

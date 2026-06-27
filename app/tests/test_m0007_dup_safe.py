"""m0007 — UNIQUE(projection_id, seq) backstop degrades safely on an existing dup.

An unattended prod deploy must NEVER crash the boot. Migration 0007 builds a UNIQUE
index over ``revisions(projection_id, seq)`` (#186 seq-integrity backstop). On a
healthy DB no duplicate exists and the UNIQUE index builds cleanly. But if a legacy/
corrupted prod DB already holds a duplicate ``(projection_id, seq)``, a bare
``CREATE UNIQUE INDEX`` raises ``IntegrityError`` and boot-crash-loops the single
durable volume.

These tests pin BOTH paths:

1. **Clean DB (expected):** migrate builds the UNIQUE index, and a later duplicate
   insert is rejected — the backstop is intact.
2. **DB seeded WITH a duplicate (unexpected):** migrate applies WITHOUT raising, a
   NON-UNIQUE index is created so lookups/restore stay fast, NO revision row is
   deleted (additive-only / never de-dup by deletion), 0007 is recorded so boot
   proceeds, a loud structured warning names the affected projection_ids, and a
   re-run is a clean no-op.
"""
from __future__ import annotations

import logging
import sqlite3

import pytest

import app.store.sqlite as sqlite_mod
from app.store.migrations import m0007_revision_seq_unique as m0007
from app.store.sqlite import SqliteStore
from engine.model import COMPUTE_SCHEMA_VERSION, MODEL_VERSION

INDEX_NAME = m0007.INDEX_NAME


# --------------------------------------------------------------------- helpers
def _index_kind(conn: sqlite3.Connection, table: str = "revisions") -> str | None:
    """Return 'unique' / 'plain' for the 0007 index on ``table``, or None if absent."""
    for row in conn.execute(f"PRAGMA index_list('{table}')"):
        # PRAGMA index_list rows: (seq, name, unique, origin, partial)
        if row[1] == INDEX_NAME:
            return "unique" if row[2] else "plain"
    return None


def _make_projection(store: SqliteStore, *, pid: str, slug: str) -> None:
    store.create_projection({
        "id": pid,
        "view_slug": slug,
        "owner_token_hash": "owner",
        "name": "P",
        "model_version": MODEL_VERSION,
        "compute_schema_version": COMPUTE_SCHEMA_VERSION,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    })


def _revision(pid: str, seq: int, rid: str) -> dict:
    return {
        "id": rid,
        "projection_id": pid,
        "seq": seq,
        "inputs_json": "{}",
        "assumptions_json": "{}",
        "overrides_json": "{}",
        "monthly_json": "{}",
        "computed_json": "{}",
        "model_version": MODEL_VERSION,
        "created_at": "2026-01-01T00:00:00Z",
    }


def _pre_0007_migrations() -> list[tuple[str, str]]:
    """The real migration list truncated to everything BEFORE 0007 (revisions exists,
    no UNIQUE seq index yet) so a duplicate can be seeded the way a legacy DB would."""
    full = list(sqlite_mod.MIGRATIONS)
    names = [n for n, _ in full]
    return full[: names.index("0007_revision_seq_unique")]


# ============================================================ path 1: clean DB
def test_clean_db_creates_unique_index(tmp_path):
    store = SqliteStore(str(tmp_path / "clean.db"))
    store.migrate()
    assert _index_kind(store._conn) == "unique"


def test_clean_db_backstop_rejects_a_later_duplicate(tmp_path):
    # The UNIQUE backstop is intact: once built on a clean DB, a duplicate
    # (projection_id, seq) insert fails loudly rather than corrupting the trail.
    store = SqliteStore(str(tmp_path / "clean.db"))
    store.migrate()
    _make_projection(store, pid="p1", slug="s1")
    store.insert_revision(_revision("p1", 2, "r1"))
    with pytest.raises(sqlite3.IntegrityError):
        store.insert_revision(_revision("p1", 2, "r2"))  # same (p1, seq=2)


def test_clean_db_records_0007(tmp_path):
    store = SqliteStore(str(tmp_path / "clean.db"))
    store.migrate()
    applied = {r[0] for r in store._conn.execute("SELECT name FROM schema_migrations")}
    assert "0007_revision_seq_unique" in applied


# ===================================================== path 2: DB with a dup
def _boot_with_seeded_duplicate(tmp_path, monkeypatch, caplog):
    """Build a file DB whose ``revisions`` already holds a duplicate (p1, seq=2),
    then run the FULL migration set (which must apply 0007 dup-safe). Returns the
    re-opened, fully-migrated store."""
    db = tmp_path / "dup.db"
    full = list(sqlite_mod.MIGRATIONS)

    # 1) migrate only through pre-0007 so the revisions table exists with NO unique
    #    seq index, then seed two revisions sharing (projection_id, seq).
    monkeypatch.setattr(sqlite_mod, "MIGRATIONS", _pre_0007_migrations())
    seed = SqliteStore(str(db))
    seed.migrate()
    _make_projection(seed, pid="p1", slug="s1")
    seed.insert_revision(_revision("p1", 2, "r1"))
    seed.insert_revision(_revision("p1", 2, "r2"))  # duplicate seq — legacy/corrupt DB
    assert _index_kind(seed._conn) is None  # no seq index yet

    # 2) reboot with the REAL full migration set; 0007 must NOT crash on the dup.
    monkeypatch.setattr(sqlite_mod, "MIGRATIONS", full)
    store = SqliteStore(str(db))
    with caplog.at_level(logging.WARNING, logger="app.migrations"):
        store.migrate()  # must not raise IntegrityError
    return store


def test_existing_duplicate_does_not_crash_boot(tmp_path, monkeypatch, caplog):
    # The core guarantee: an unattended boot over a pre-existing duplicate completes.
    store = _boot_with_seeded_duplicate(tmp_path, monkeypatch, caplog)
    applied = {r[0] for r in store._conn.execute("SELECT name FROM schema_migrations")}
    assert "0007_revision_seq_unique" in applied  # recorded -> boot proceeds


def test_existing_duplicate_degrades_to_plain_index(tmp_path, monkeypatch, caplog):
    store = _boot_with_seeded_duplicate(tmp_path, monkeypatch, caplog)
    # A NON-UNIQUE index exists so lookups/restore stay fast, but it is NOT unique
    # (the dup would have made a unique index impossible).
    assert _index_kind(store._conn) == "plain"


def test_existing_duplicate_deletes_no_revision_data(tmp_path, monkeypatch, caplog):
    # Additive-only / never de-dup by deleting rows: BOTH duplicate revisions survive.
    store = _boot_with_seeded_duplicate(tmp_path, monkeypatch, caplog)
    ids = {
        r[0]
        for r in store._conn.execute(
            "SELECT id FROM revisions WHERE projection_id='p1' AND seq=2"
        )
    }
    assert ids == {"r1", "r2"}


def test_existing_duplicate_logs_loud_warning_naming_projection(
    tmp_path, monkeypatch, caplog
):
    caplog.clear()
    _boot_with_seeded_duplicate(tmp_path, monkeypatch, caplog)
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert warnings, "expected a loud warning when degrading on a duplicate seq"
    rec = next(
        r for r in warnings if "p1" in (getattr(r, "affected_projection_ids", []) or [])
        or "p1" in r.getMessage()
    )
    # The affected projection_ids are surfaced (structured extra and/or message) so an
    # operator can de-dup per OPS_RUNBOOK §8.2.
    assert "p1" in rec.getMessage() or "p1" in (
        getattr(rec, "affected_projection_ids", []) or []
    )


def test_existing_duplicate_rerun_is_a_noop(tmp_path, monkeypatch, caplog):
    store = _boot_with_seeded_duplicate(tmp_path, monkeypatch, caplog)
    db_path = store.db_path
    before = {
        r[0]
        for r in store._conn.execute(
            "SELECT id FROM revisions WHERE projection_id='p1' AND seq=2"
        )
    }
    # Re-open and migrate again: no raise, ledger stable, still a plain index, and no
    # revision row touched.
    store2 = SqliteStore(db_path)
    store2.migrate()
    assert _index_kind(store2._conn) == "plain"
    after = {
        r[0]
        for r in store2._conn.execute(
            "SELECT id FROM revisions WHERE projection_id='p1' AND seq=2"
        )
    }
    assert after == before == {"r1", "r2"}


# ============================================================= additive guard
def test_m0007_sql_is_still_additive_only():
    from app.store.migration_safety import scan_sql
    assert scan_sql(m0007.SQL) == []
    assert scan_sql(m0007.PLAIN_SQL) == []

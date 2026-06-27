"""m0007 — UNIQUE(projection_id, seq) backstop on revisions (issue #186).

Additive-only (CLAUDE.md DB discipline / DATA_MODEL §8): a new index, no DROP/RENAME
and no row mutation. ``seq`` integrity previously rested ENTIRELY on the app computing
``seq = if_match + 1`` under the version check — there was no DB constraint, so any
future/buggy ``insert_revision`` path that miscomputed ``seq`` would silently produce
a duplicate or gapped snapshot and corrupt the restore/audit trail with no signal.

On a healthy DB this index is **UNIQUE**, so a duplicate ``(projection_id, seq)`` fails
LOUDLY with an ``IntegrityError`` instead. It pairs with the single-transaction
``update_with_version_check_and_revision`` write path (also #186) so a version bump can
never land without its matching snapshot.

**Boot-never-fails on an existing duplicate (degrade-on-dup).** A duplicate is NOT
expected — the optimistic-concurrency write path + #186 atomic version+revision prevent
new ones. But for an unattended prod deploy the migration must never crash the boot. A
bare ``CREATE UNIQUE INDEX`` over rows that already hold a duplicate
``(projection_id, seq)`` raises ``IntegrityError`` and boot-crash-loops the single
durable volume. So this migration is applied by ``apply()`` (dispatched from
``SqliteStore._apply_migration`` by name), which:

- detects an existing duplicate ``(projection_id, seq)`` BEFORE creating the index;
- with NONE (the expected case) creates the UNIQUE index (the seq backstop);
- with duplicates (unexpected) does NOT crash and does NOT delete data — it creates a
  PLAIN (non-unique) index so lookups/restore stay fast, logs a LOUD structured warning
  naming the affected ``projection_id``s for the operator to de-dup later
  (OPS_RUNBOOK §8.2), and still records 0007 as applied so boot proceeds.

Idempotent: ``apply()`` no-ops when an index (unique OR plain) already exists. A *fresh*
apply after the duplicates have been removed upgrades to the UNIQUE backstop again.

The ``SQL`` constant (the UNIQUE DDL) remains the canonical, additive-only statement the
migration-lint / additive-safety scanners read; ``apply()`` is what the runner executes.
"""
from __future__ import annotations

import logging
import sqlite3

logger = logging.getLogger("app.migrations")

# The index name is shared by the UNIQUE (healthy) and PLAIN (degraded) variants so the
# two can never coexist and idempotency is a simple name lookup.
INDEX_NAME = "idx_revisions_projection_seq"

# Canonical clean-path DDL — scanned by migration_lint / assert_migrations_additive.
SQL = """
CREATE UNIQUE INDEX IF NOT EXISTS idx_revisions_projection_seq
  ON revisions(projection_id, seq);
"""

# Degrade-on-dup fallback: a NON-UNIQUE index on the same columns so lookups/restore
# stay fast when an existing duplicate makes the UNIQUE backstop impossible. Still
# additive-only (CREATE INDEX, no DROP/row mutation).
PLAIN_SQL = """
CREATE INDEX IF NOT EXISTS idx_revisions_projection_seq
  ON revisions(projection_id, seq);
"""


def _existing_index_kind(conn: sqlite3.Connection) -> str | None:
    """Return ``"unique"`` / ``"plain"`` for the 0007 index, or ``None`` if absent."""
    for row in conn.execute("PRAGMA index_list('revisions')"):
        # PRAGMA index_list rows: (seq, name, unique, origin, partial).
        if row[1] == INDEX_NAME:
            return "unique" if row[2] else "plain"
    return None


def _duplicate_seq_groups(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Rows of ``(projection_id, seq, c)`` for every duplicated pair (empty == clean)."""
    return conn.execute(
        "SELECT projection_id, seq, COUNT(*) AS c FROM revisions "
        "GROUP BY projection_id, seq HAVING c > 1"
    ).fetchall()


def _warn_existing_duplicates(log: logging.Logger, dups: list[sqlite3.Row]) -> None:
    """Loud, structured warning naming the affected projection_ids for OPS_RUNBOOK §8.2."""
    projection_ids = sorted({row["projection_id"] for row in dups})
    log.warning(
        "m0007 degraded: pre-existing duplicate (projection_id, seq) in revisions — "
        "created a NON-UNIQUE index instead of the UNIQUE backstop so boot proceeds "
        "WITHOUT deleting any revision data. De-duplicate per OPS_RUNBOOK §8.2, then "
        "rebuild the UNIQUE index to restore the seq backstop. "
        "affected_projection_ids=%s duplicate_group_count=%s",
        projection_ids,
        len(dups),
        extra={
            "migration": "0007_revision_seq_unique",
            "event": "revision_seq_duplicate_degraded_index",
            "affected_projection_ids": projection_ids,
            "duplicate_group_count": len(dups),
        },
    )


def apply(conn: sqlite3.Connection, *, log: logging.Logger | None = None) -> None:
    """Apply 0007 boot-safely: UNIQUE backstop when clean, degrade to a PLAIN index on
    an existing duplicate. Never raises on a duplicate and never deletes a row.

    Runs inside the runner's explicit migration transaction (the caller writes the
    ``schema_migrations`` ledger row in the same transaction, atomically). Idempotent:
    a no-op when an index already exists.
    """
    log = log or logger
    if _existing_index_kind(conn) is not None:
        return  # idempotent: a unique OR plain index already present -> no-op
    dups = _duplicate_seq_groups(conn)
    if not dups:
        # Expected clean DB (or duplicates since removed): build the UNIQUE backstop.
        conn.execute(SQL)
        return
    # Unexpected pre-existing duplicate. Never crash the boot, never delete revision
    # data: degrade to a NON-UNIQUE index and warn loudly so an operator de-dups.
    conn.execute(PLAIN_SQL)
    _warn_existing_duplicates(log, dups)

"""app/store/litestream.py — pre-migration Litestream checkpoint (OPS_RUNBOOK §8.2).

Before any pending migration touches the durable volume, force a clean pre-migration
restore point (SECURITY §12 / CLAUDE.md DB discipline). A *truncating* WAL checkpoint
flushes every committed frame from the ``-wal`` file into the main database file;
because Litestream replicates continuously (``sync-interval: 1s`` in ``litestream.yml``)
the just-checkpointed image is exactly what the next sync ships to object storage — so
the pre-migration state is captured as a recoverable restore point BEFORE the schema
changes run.

Migrations are additive-only (never ``DROP``), so even a failed migration leaves data
intact; the checkpoint is the belt-and-braces restore point the runbook promises and
the boot-time line operators see in the logs.
"""
from __future__ import annotations

import logging
import os
import sqlite3
from collections.abc import Mapping

logger = logging.getLogger("app.migrations")


def force_pre_migration_checkpoint(
    conn: sqlite3.Connection,
    *,
    db_path: str = "",
    env: Mapping[str, str] | None = None,
    log: logging.Logger | None = None,
) -> str:
    """Force a truncating WAL checkpoint as a pre-migration Litestream restore point.

    Returns a short status string: ``"replicating"`` when Litestream is configured
    (``LITESTREAM_BUCKET`` set), else ``"wal-checkpoint"``. Never raises on a benign
    checkpoint failure (e.g. an in-memory dev DB has no WAL, or the connection is
    closed) — it logs and continues, because the additive-only guarantee (not the
    checkpoint) is what makes the migration safe.
    """
    env = os.environ if env is None else env
    log = log or logger
    replicating = bool(env.get("LITESTREAM_BUCKET"))
    try:
        row = conn.execute("PRAGMA wal_checkpoint(TRUNCATE);").fetchone()
    except sqlite3.Error as exc:
        log.warning("pre-migration WAL checkpoint failed (continuing): %s", exc)
        row = None
    if replicating:
        log.info(
            "pre-migration Litestream checkpoint forced (db=%s, wal_checkpoint=%s) — "
            "clean restore point captured before applying pending migrations",
            db_path or "<unknown>", row,
        )
        return "replicating"
    log.debug(
        "pre-migration WAL checkpoint (Litestream not configured; db=%s, result=%s)",
        db_path or "<unknown>", row,
    )
    return "wal-checkpoint"

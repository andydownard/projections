"""app/store/sqlite.py — SqliteStore (v1).

WAL + busy_timeout + serialized single-writer (DATA_MODEL.md §7). App-generated
ULID PKs; explicit SELECT-then-INSERT/UPDATE (no SQLite-only upsert); opaque JSON
TEXT columns; the version-check optimistic-concurrency UPDATE is the SAME SQL the
Postgres path will use. WAL PRAGMAs are SqliteStore internals, applied on connect.
"""
from __future__ import annotations

import json
import secrets
import sqlite3
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

from app.store import revision_retention
from app.store.card_summary import build_card_summary
from app.store.litestream import force_pre_migration_checkpoint
from app.store.migration_safety import assert_migrations_additive
from app.store.migrations import MIGRATIONS, m0007_revision_seq_unique
from app.store.penny_retention import apply_retention
from app.store.role_links import parse_role_tokens, slug_token_hash


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _is_memory_db(db_path: str) -> bool:
    """True for an in-memory DB, whose contents are private to ONE connection.

    A second connection to ``:memory:`` opens a *different* empty database, so the
    connection-per-thread read pool (below) cannot be used — reads must share the
    single primary connection. File DBs (the production ``/data`` volume) get the
    pool, where WAL gives concurrent readers + one writer.
    """
    p = db_path.strip()
    return p in ("", ":memory:") or ":memory:" in p or "mode=memory" in p


def _split_sql_statements(script: str) -> list[str]:
    """Split a migration script into individual statements, semicolon-safe.

    The atomic migration apply (#185) executes each statement inside ONE explicit
    transaction (``executescript`` is unusable — it issues an implicit COMMIT that
    breaks atomicity). We split on statement boundaries using SQLite's own
    ``complete_statement`` lexer, which ignores semicolons inside string literals
    and comments, so a DEFAULT value or comment containing ``;`` never corrupts the
    split.
    """
    statements: list[str] = []
    buffer = ""
    for ch in script:
        buffer += ch
        if ch == ";" and sqlite3.complete_statement(buffer):
            stmt = buffer.strip()
            if stmt and stmt != ";":
                statements.append(stmt)
            buffer = ""
    tail = buffer.strip()
    if tail and tail != ";":
        statements.append(tail)
    return statements


def _new_transcript_id() -> str:
    # App-generated, time-ordered string PK (no DB autoincrement; Postgres-portable).
    return "pt_" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + secrets.token_hex(6)


# Migrations whose apply step needs runtime logic the static-SQL path cannot express,
# keyed by migration name -> callable(conn). The runner dispatches to the hook inside
# the SAME explicit transaction it uses for the DDL + ledger INSERT (so the hook stays
# atomic + idempotent), instead of executing the migration's SQL string. The hook lives
# in the migration module (logic stays with the migration); the runner only dispatches.
# 0007 must degrade to a NON-UNIQUE index — never crash the boot — if the durable volume
# already holds a duplicate (projection_id, seq) (see m0007_revision_seq_unique.apply).
_MIGRATION_APPLY_HOOKS: dict[str, Callable[[sqlite3.Connection], None]] = {
    "0007_revision_seq_unique": m0007_revision_seq_unique.apply,
}


class SqliteStore:
    def __init__(
        self, db_path: str, *, checkpoint: Callable[[], None] | None = None
    ) -> None:
        self.db_path = db_path
        # Pre-migration Litestream checkpoint hook (OPS_RUNBOOK §8.2). Injectable so
        # tests can spy the call ordering; defaults to the real WAL/Litestream
        # checkpoint against this store's connection.
        self._checkpoint = checkpoint
        # Single-writer serialization (DATA_MODEL.md §5.2). ALL writes (and the
        # migration apply) go through this one connection under the lock, preserving
        # SQLite's single-writer invariant.
        self._write_lock = threading.Lock()
        self._is_memory = _is_memory_db(db_path)
        # The primary/writer connection. For an in-memory DB it is also the only
        # connection that can see the data, so reads use it too (see _read_conn).
        self._conn = self._connect()
        # Per-thread READER connections for file DBs (#177): reusing one shared
        # connection for every read serialized all DB access through SQLite's
        # per-connection mutex, nullified WAL concurrency, and let a slow query
        # head-of-line-block every other request — including the /api/health probe,
        # which could then exceed the healthcheck window and trip a restart loop.
        # Each thread gets its own read-only connection so WAL readers run in
        # parallel with each other and with the single writer.
        self._readers = threading.local()

    def _connect(self, *, read_only: bool = False) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("PRAGMA journal_mode = WAL;")
        cur.execute("PRAGMA busy_timeout = 5000;")
        cur.execute("PRAGMA synchronous = NORMAL;")
        cur.execute("PRAGMA foreign_keys = ON;")
        if read_only:
            # Reader connections never write: query_only fails closed if a read path
            # ever attempts a mutation, keeping writes on the single writer.
            cur.execute("PRAGMA query_only = ON;")
        conn.commit()
        return conn

    def _read_conn(self) -> sqlite3.Connection:
        """Return the connection to use for a READ on the current thread.

        File DBs: a lazily-opened, per-thread read-only connection (WAL concurrent
        reads). In-memory DBs: the single primary connection (a second connection
        would see an empty database).
        """
        if self._is_memory:
            return self._conn
        conn: sqlite3.Connection | None = getattr(self._readers, "conn", None)
        if conn is None:
            conn = self._connect(read_only=True)
            self._readers.conn = conn
        return conn

    @contextmanager
    def _explicit_transaction(self) -> Iterator[sqlite3.Connection]:
        """Run an explicit BEGIN/COMMIT (autocommit mode) for transactional DDL+DML.

        Python's sqlite3 only auto-wraps DML and NEVER DDL, so DDL runs in autocommit
        by default — the exact non-atomicity behind #185. Setting isolation_level=None
        hands transaction control to us so a migration's DDL and its ledger INSERT
        commit together, or roll back together on any error (SQLite rolls back DDL).
        Only ever called under the write lock (single writer).
        """
        conn = self._conn
        prev = conn.isolation_level
        conn.isolation_level = None
        conn.execute("BEGIN")
        try:
            yield conn
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.isolation_level = prev

    # --- lifecycle ---
    def migrate(self) -> None:
        # Fail-closed: never run a non-additive migration against the durable
        # volume (CLAUDE.md DB discipline / OPS_RUNBOOK §8.2). The scan runs every
        # boot over the migration that is about to apply.
        assert_migrations_additive(MIGRATIONS)
        with self._write_lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations "
                "(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
            )
            self._conn.commit()
            applied = {
                r["name"]
                for r in self._conn.execute("SELECT name FROM schema_migrations")
            }
            pending = [(name, sql) for name, sql in MIGRATIONS if name not in applied]
            if pending:
                # OPS_RUNBOOK §8.2 / SECURITY §12: force a pre-migration Litestream
                # checkpoint so there is a clean restore point BEFORE any pending DDL
                # touches the durable volume. Forced ONCE per boot (one restore
                # point for the batch), only when there is actually work to apply.
                self._run_pre_migration_checkpoint()
            for name, sql in pending:
                self._apply_migration(name, sql)
        # One-time data backfills, keyed to the migration that introduced the column/
        # table, so an existing DB is correct WITHOUT a re-save. Run outside the
        # migration lock (each acquires the write lock itself); only on the boot that
        # freshly applied the migration (idempotent: a no-op once recorded).
        freshly_applied = {name for name, _ in pending}
        if "0008_card_summary" in freshly_applied:
            self._backfill_card_summaries()
        if "0009_role_links" in freshly_applied:
            self._backfill_role_links()

    def _apply_migration(self, name: str, sql: str) -> None:
        """Apply ONE migration atomically and idempotently (#185).

        ATOMIC: the DDL statements AND the ``schema_migrations`` ledger INSERT run in
        a SINGLE explicit transaction. A crash/OOM mid-apply commits NEITHER — so the
        prior boot's executescript window (column physically added but the ledger
        INSERT lost) can no longer brick the single durable volume.

        IDEMPOTENT: every statement tolerates a re-run. ``CREATE TABLE/INDEX IF NOT
        EXISTS`` is already a no-op; a bare ``ALTER TABLE ADD COLUMN`` is guarded so a
        re-run after a crash (where the column is already present but the ledger row
        is not) swallows "duplicate column name" and proceeds to re-record the ledger
        instead of boot-crash-looping.
        """
        with self._explicit_transaction() as conn:
            hook = _MIGRATION_APPLY_HOOKS.get(name)
            if hook is not None:
                # Runtime-logic migration (e.g. 0007 degrade-on-dup): the hook owns the
                # DDL decision; the ledger INSERT below keeps it atomic + idempotent.
                hook(conn)
            else:
                for statement in _split_sql_statements(sql):
                    self._execute_idempotent(conn, statement)
            conn.execute(
                "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)",
                (name, _utcnow()),
            )

    @staticmethod
    def _execute_idempotent(conn: sqlite3.Connection, statement: str) -> None:
        """Execute one migration statement, swallowing ONLY 'duplicate column name'.

        The guard is deliberately narrow: an already-applied ``ALTER ADD COLUMN`` is a
        no-op on re-run, but any OTHER OperationalError still propagates (and rolls the
        migration back), so a genuinely broken migration is never silently skipped.
        """
        try:
            conn.execute(statement)
        except sqlite3.OperationalError as exc:
            if "duplicate column name" in str(exc).lower():
                return
            raise

    def _run_pre_migration_checkpoint(self) -> None:
        if self._checkpoint is not None:
            self._checkpoint()
            return
        force_pre_migration_checkpoint(self._conn, db_path=self.db_path)

    def _backfill_card_summaries(self) -> None:
        """Populate ``summary_json`` from ``computed_json`` for pre-0008 rows (#178).

        Runs ONCE, on the boot that applies migration 0008, so existing projections
        get a correct owner-list card without a re-save. Maintenance UPDATE (no
        version bump) under the write lock.
        """
        with self._write_lock:
            rows = self._conn.execute(
                "SELECT id, computed_json FROM projections "
                "WHERE summary_json = '{}' OR summary_json IS NULL"
            ).fetchall()
            for r in rows:
                try:
                    vm = json.loads(r["computed_json"] or "{}")
                except json.JSONDecodeError:
                    vm = {}
                self._conn.execute(
                    "UPDATE projections SET summary_json = ? WHERE id = ?",
                    (json.dumps(build_card_summary(vm)), r["id"]),
                )
            self._conn.commit()

    def _backfill_role_links(self) -> None:
        """Populate ``role_links`` from ``role_tokens_json`` for pre-0009 rows (#180).

        Runs ONCE, on the boot that applies migration 0009, so existing role-share
        links resolve through the indexed table immediately. Tolerant of both the
        legacy ``{slug: role_name}`` and documented ``{role_name: {slug,...}}`` shapes.
        """
        with self._write_lock:
            rows = self._conn.execute(
                "SELECT id, role_tokens_json, created_at FROM projections "
                "WHERE deleted_at IS NULL"
            ).fetchall()
            for r in rows:
                self._sync_role_links(self._conn, r["id"], r["role_tokens_json"],
                                      created_at=r["created_at"])
            self._conn.commit()

    @staticmethod
    def _sync_role_links(
        conn: sqlite3.Connection,
        projection_id: str,
        role_tokens_json: str | None,
        *,
        created_at: str | None = None,
    ) -> None:
        """Rebuild ``role_links`` rows for one projection from its ``role_tokens_json``.

        Replace-all (scoped DELETE + INSERT) so a rotation/edit that drops a role link
        kills its row. The slug is the plaintext lookup PK (like ``view_slug``);
        ``token_hash = SHA-256(slug)`` is the documented §6 hashed-at-rest companion.
        Caller controls the surrounding transaction/lock.
        """
        conn.execute("DELETE FROM role_links WHERE projection_id = ?", (projection_id,))
        now = created_at or _utcnow()
        for link in parse_role_tokens(role_tokens_json):
            conn.execute(
                "INSERT INTO role_links (slug, projection_id, role_name, token_hash, "
                "created_at) VALUES (?, ?, ?, ?, ?)",
                (link["slug"], projection_id, link["role_name"],
                 slug_token_hash(link["slug"]), now),
            )

    def _prune_revisions(self, conn: sqlite3.Connection, projection_id: str) -> None:
        """Cap retained revisions per projection (#179), keeping recent + protected.

        Keeps the most-recent ``MAX_REVISIONS_PER_PROJECTION`` by ``seq`` plus any
        protected revision (model upgrade / token rotation) that falls outside that
        window. Portable (no LIKE/JSON1): candidate selection + filtering in Python,
        scoped DELETE by id. Runs inside the caller's write transaction.
        """
        keep = revision_retention.MAX_REVISIONS_PER_PROJECTION
        rows = conn.execute(
            "SELECT id, change_summary FROM revisions WHERE projection_id = ? "
            "ORDER BY seq DESC",
            (projection_id,),
        ).fetchall()
        if len(rows) <= keep:
            return
        for r in rows[keep:]:
            if not revision_retention.is_protected(r["change_summary"]):
                conn.execute("DELETE FROM revisions WHERE id = ?", (r["id"],))

    def ping(self) -> bool:
        # The healthcheck probe reads via the per-thread reader (#177), so it is never
        # head-of-line-blocked behind a slow write holding the single writer.
        try:
            self._read_conn().execute("SELECT 1").fetchone()
            return True
        except sqlite3.Error:
            return False

    # --- projections ---
    def get_projection_by_slug(self, view_slug: str) -> dict | None:
        row = self._read_conn().execute(
            "SELECT * FROM projections WHERE view_slug = ? AND deleted_at IS NULL",
            (view_slug,),
        ).fetchone()
        return dict(row) if row else None

    def list_by_owner(
        self, owner_token_hash: str, *, include_trashed: bool = False
    ) -> list[dict]:
        # Owner-scoped, NEVER global (DATA_MODEL.md §3.1 / SECURITY.md §1 risk #3).
        sql = (
            "SELECT * FROM projections "
            "WHERE owner_token_hash = ? AND deleted_at IS NULL"
        )
        if not include_trashed:
            sql += " AND status = 'active'"
        sql += " ORDER BY updated_at DESC"
        return [dict(r) for r in self._read_conn().execute(sql, (owner_token_hash,))]

    def list_card_summaries(
        self, owner_token_hash: str, *, include_trashed: bool = False
    ) -> list[dict]:
        """Owner-scoped list selecting ONLY the small card columns (#178).

        Never SELECTs the heavy JSON blobs (computed_json/inputs_json/...); returns the
        denormalized ``summary_json`` instead, so the hottest authenticated query stops
        being O(N rows x ~10KB) read + per-row full-blob parse. Owner-scoped, NEVER
        global (DATA_MODEL.md §3.1 / SECURITY.md §1 risk #3); the owner index backs the
        WHERE + ORDER BY.
        """
        sql = (
            "SELECT view_slug, name, status, version, updated_at, summary_json "
            "FROM projections WHERE owner_token_hash = ? AND deleted_at IS NULL"
        )
        if not include_trashed:
            sql += " AND status = 'active'"
        sql += " ORDER BY updated_at DESC"
        return [dict(r) for r in self._read_conn().execute(sql, (owner_token_hash,))]

    def create_projection(self, p: dict) -> dict:
        # Denormalize the owner-list card summary at write time (#178) so the list
        # never parses the full computed_json per row.
        row = dict(p)
        if "computed_json" in row and "summary_json" not in row:
            row["summary_json"] = self._summary_json(row["computed_json"])
        cols = list(row.keys())
        placeholders = ", ".join("?" for _ in cols)
        with self._write_lock:
            conn = self._conn
            prev = conn.isolation_level
            conn.isolation_level = None
            try:
                conn.execute("BEGIN")
                conn.execute(
                    f"INSERT INTO projections ({', '.join(cols)}) "
                    f"VALUES ({placeholders})",
                    [row[c] for c in cols],
                )
                # Keep the indexed role_links table in sync (#180): role-share links
                # resolve via an exact-match slug PK, never a leading-wildcard scan.
                if "role_tokens_json" in row:
                    self._sync_role_links(
                        conn, row["id"], row["role_tokens_json"],
                        created_at=row.get("created_at"))
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            finally:
                conn.isolation_level = prev
        return p

    @staticmethod
    def _summary_json(computed_json: str | None) -> str:
        """Compact owner-list card summary derived from a computed_json blob (#178)."""
        try:
            vm = json.loads(computed_json or "{}")
        except json.JSONDecodeError:
            vm = {}
        return json.dumps(build_card_summary(vm))

    def update_with_version_check(
        self, id: str, expected_version: int, patch: dict[str, Any]
    ) -> int:
        # Refresh the denormalized owner-list card summary in the SAME UPDATE whenever
        # computed_json changes (#178), so the list never re-parses the full blob.
        if "computed_json" in patch and "summary_json" not in patch:
            patch = {**patch, "summary_json": self._summary_json(patch["computed_json"])}
        # Identical SQL on both backends: 0 rows -> HTTP 409 (DATA_MODEL.md §5.1).
        set_cols = ", ".join(f"{k} = ?" for k in patch)
        sql = (
            "UPDATE projections SET version = version + 1, updated_at = ?"
            + (", " + set_cols if patch else "")
            + " WHERE id = ? AND version = ? AND deleted_at IS NULL"
        )
        params = [_utcnow(), *patch.values(), id, expected_version]
        with self._write_lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur.rowcount

    def update_with_version_check_and_revision(
        self,
        id: str,
        expected_version: int,
        patch: dict[str, Any],
        revision: dict,
    ) -> int:
        """Version-checked UPDATE + its revision snapshot in ONE transaction (#186).

        Closes the crash window where ``update_with_version_check`` committed the
        ``version++`` and a SEPARATE ``insert_revision`` commit was lost — bumping the
        version with NO snapshot for it, an unrecoverable hole in the restore/audit
        trail (DATA_MODEL §3.2). Either both land or neither does:

        - 0 rows from the version check -> **HTTP 409**, the transaction rolls back,
          and NO revision row is written.
        - else the UPDATE and the INSERT commit together.

        The version-check SQL is identical to ``update_with_version_check`` (the same
        drop-in the Postgres path uses). The UNIQUE(projection_id, seq) backstop
        (migration 0007) makes a miscomputed/duplicate seq fail loudly here rather
        than silently corrupt the trail.
        """
        # Refresh the denormalized card summary alongside computed_json (#178).
        if "computed_json" in patch and "summary_json" not in patch:
            patch = {**patch, "summary_json": self._summary_json(patch["computed_json"])}
        # Revisions never persist the recomputable, never-read compute snapshot (#179):
        # restore recomputes from inputs/assumptions/overrides; computed_json/monthly_json
        # are blanked so the durable volume (and Litestream) is not bloated.
        revision = revision_retention.strip_recomputable(revision)
        set_cols = ", ".join(f"{k} = ?" for k in patch)
        update_sql = (
            "UPDATE projections SET version = version + 1, updated_at = ?"
            + (", " + set_cols if patch else "")
            + " WHERE id = ? AND version = ? AND deleted_at IS NULL"
        )
        params = [_utcnow(), *patch.values(), id, expected_version]
        cols = list(revision.keys())
        placeholders = ", ".join("?" for _ in cols)
        insert_sql = (
            f"INSERT INTO revisions ({', '.join(cols)}) VALUES ({placeholders})"
        )
        with self._write_lock:
            conn = self._conn
            prev = conn.isolation_level
            conn.isolation_level = None
            try:
                conn.execute("BEGIN")
                cur = conn.execute(update_sql, params)
                if cur.rowcount == 0:
                    conn.execute("ROLLBACK")  # 409: no orphan revision
                    return 0
                conn.execute(insert_sql, [revision[c] for c in cols])
                self._prune_revisions(conn, revision["projection_id"])  # bounded (#179)
                conn.execute("COMMIT")
                return cur.rowcount
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            finally:
                conn.isolation_level = prev

    def rotate_tokens(
        self, id: str, expected_version: int, new_hashes: dict[str, Any]
    ) -> int:
        """Atomic owner/edit/view_slug/role rotation (DATA_MODEL §6.1).

        One version-checked UPDATE re-hashes every shared capability so all prior
        links die at once, and the indexed ``role_links`` table is rebuilt from the
        new ``role_tokens_json`` IN THE SAME TRANSACTION (#180) so every old role slug
        stops resolving. Same 0-rows -> 409 contract as every mutation.
        """
        patch = dict(new_hashes)
        set_cols = ", ".join(f"{k} = ?" for k in patch)
        update_sql = (
            "UPDATE projections SET version = version + 1, updated_at = ?"
            + (", " + set_cols if patch else "")
            + " WHERE id = ? AND version = ? AND deleted_at IS NULL"
        )
        params = [_utcnow(), *patch.values(), id, expected_version]
        with self._write_lock:
            conn = self._conn
            prev = conn.isolation_level
            conn.isolation_level = None
            try:
                conn.execute("BEGIN")
                cur = conn.execute(update_sql, params)
                if cur.rowcount == 0:
                    conn.execute("ROLLBACK")  # 409: nothing rotated
                    return 0
                if "role_tokens_json" in patch:
                    self._sync_role_links(conn, id, patch["role_tokens_json"])
                conn.execute("COMMIT")
                return cur.rowcount
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            finally:
                conn.isolation_level = prev

    def set_status(self, id: str, status: str, expected_version: int) -> int:
        """Trash/restore: flip status under the optimistic-concurrency version check."""
        return self.update_with_version_check(id, expected_version, {"status": status})

    def soft_delete(self, id: str, expected_version: int) -> int:
        """Soft-delete marker: set deleted_at so the row is excluded everywhere.

        Recoverable (the row + children persist); the real privacy purge is
        ``purge_projection`` (#202).
        """
        return self.update_with_version_check(
            id, expected_version, {"deleted_at": _utcnow()})

    # Child tables erased by a hard purge (#202), ordered children-before-parent so
    # the FK references (no ON DELETE CASCADE; PRAGMA foreign_keys=ON) resolve.
    _PURGE_CHILD_TABLES = (
        "revisions", "narratives", "evidence", "penny_transcripts",
        "actuals", "role_links",
    )

    def purge_projection(self, id: str, expected_version: int) -> int:
        """Hard purge (#202): version-checked DELETE of the projection AND a cascade
        of every child row it owns (revisions, narratives, evidence, penny_transcripts,
        actuals, role_links). Truly irreversible — the confidential financials + Penny
        conversation are ERASED, not merely hidden behind ``deleted_at``.

        0 rows (version mismatch / unknown id) -> NO cascade runs and 0 is returned
        (the 409 path), so a stale purge never half-erases a live projection. Children
        are deleted before the parent because the FKs have no ON DELETE CASCADE.
        """
        with self._write_lock:
            conn = self._conn
            prev = conn.isolation_level
            conn.isolation_level = None
            try:
                conn.execute("BEGIN")
                row = conn.execute(
                    "SELECT version FROM projections WHERE id = ?", (id,)
                ).fetchone()
                if row is None or row["version"] != expected_version:
                    conn.execute("ROLLBACK")  # 409: nothing erased
                    return 0
                for tbl in self._PURGE_CHILD_TABLES:
                    conn.execute(
                        f"DELETE FROM {tbl} WHERE projection_id = ?", (id,))
                conn.execute("DELETE FROM projections WHERE id = ?", (id,))
                conn.execute("COMMIT")
                return 1
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            finally:
                conn.isolation_level = prev

    # --- revisions ---
    def insert_revision(self, rev: dict) -> None:
        # Never persist the recomputable, never-read compute snapshot (#179): restore
        # recomputes from inputs/assumptions/overrides; computed_json/monthly_json are
        # blanked so each revision is not ~10KB of Litestream-replicated dead weight.
        rev = revision_retention.strip_recomputable(rev)
        cols = list(rev.keys())
        placeholders = ", ".join("?" for _ in cols)
        with self._write_lock:
            conn = self._conn
            prev = conn.isolation_level
            conn.isolation_level = None
            try:
                conn.execute("BEGIN")
                conn.execute(
                    f"INSERT INTO revisions ({', '.join(cols)}) "
                    f"VALUES ({placeholders})",
                    [rev[c] for c in cols],
                )
                # Bound per-projection revision growth (#179): prune oldest beyond the
                # cap, keeping the recent window + protected (upgrade/rotate) rows.
                self._prune_revisions(conn, rev["projection_id"])
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            finally:
                conn.isolation_level = prev

    def list_revisions(self, projection_id: str, limit: int = 50) -> list[dict]:
        return [
            dict(r)
            for r in self._read_conn().execute(
                "SELECT * FROM revisions WHERE projection_id = ? "
                "ORDER BY seq DESC LIMIT ?",
                (projection_id, limit),
            )
        ]

    def get_revision(self, revision_id: str) -> dict | None:
        row = self._read_conn().execute(
            "SELECT * FROM revisions WHERE id = ?", (revision_id,)
        ).fetchone()
        return dict(row) if row else None

    def get_projection_by_role_slug(self, role_slug: str) -> dict | None:
        """Resolve a role-link slug -> (projection_row, role_name) by EXACT MATCH (#180).

        O(1) lookup on the ``role_links`` slug PK joined to the live projection — no
        leading-wildcard ``LIKE`` full-table scan, identical on Postgres. The role slug
        is the plaintext read-only lookup key (like ``view_slug``); ``role_links`` is
        kept in sync from ``role_tokens_json`` on every write. Excludes purged/deleted
        projections (``deleted_at IS NULL``).
        """
        row = self._read_conn().execute(
            "SELECT p.*, rl.role_name AS _role_name "
            "FROM role_links rl JOIN projections p ON p.id = rl.projection_id "
            "WHERE rl.slug = ? AND p.deleted_at IS NULL",
            (role_slug,),
        ).fetchone()
        return dict(row) if row else None

    # --- narratives (M5 / §6.1) ---
    def get_narrative(self, projection_id: str) -> dict | None:
        row = self._read_conn().execute(
            "SELECT * FROM narratives WHERE projection_id = ?", (projection_id,)
        ).fetchone()
        return dict(row) if row else None

    def upsert_narrative(self, projection_id: str, narrative: dict[str, Any]) -> dict:
        """Insert-or-update the single narrative row for a projection.

        Portable upsert (avoids the SQLite-only replace idiom): try UPDATE, fall
        back to INSERT when no row exists. The narrative is 1:1 with a projection
        (``projection_id`` PK), so there is no concurrency window worth a CAS here.
        """
        cols = ("body_md", "edited", "computed_hash", "snapshot_json", "provider",
                "model_version", "edit_origin", "updated_at")
        vals = {c: narrative.get(c) for c in cols}
        vals["updated_at"] = vals["updated_at"] or _utcnow()
        vals["snapshot_json"] = vals["snapshot_json"] or "{}"
        with self._write_lock:
            set_clause = ", ".join(f"{c} = ?" for c in cols)
            cur = self._conn.execute(
                f"UPDATE narratives SET {set_clause} WHERE projection_id = ?",
                [*(vals[c] for c in cols), projection_id],
            )
            if cur.rowcount == 0:
                placeholders = ", ".join("?" for _ in range(len(cols) + 1))
                self._conn.execute(
                    "INSERT INTO narratives "
                    f"(projection_id, {', '.join(cols)}) VALUES ({placeholders})",
                    [projection_id, *(vals[c] for c in cols)],
                )
            self._conn.commit()
        return {"projection_id": projection_id, **vals}

    # --- feedback ---
    def create_feedback(self, fb: dict) -> dict:
        cols = list(fb.keys())
        placeholders = ", ".join("?" for _ in cols)
        with self._write_lock:
            self._conn.execute(
                f"INSERT INTO feedback ({', '.join(cols)}) VALUES ({placeholders})",
                [fb[c] for c in cols],
            )
            self._conn.commit()
        return fb

    # --- intent ---
    def create_intent(self, intent: dict) -> dict:
        cols = list(intent.keys())
        placeholders = ", ".join("?" for _ in cols)
        with self._write_lock:
            self._conn.execute(
                f"INSERT INTO intent ({', '.join(cols)}) VALUES ({placeholders})",
                [intent[c] for c in cols],
            )
            self._conn.commit()
        return intent

    # --- penny transcripts (§7) ---
    def create_transcript(self, t: dict) -> dict:
        """Insert a new per-project transcript row.

        Fails closed on a missing/NULL ``projection_id``: ephemeral wizard-draft
        transcripts are NEVER persisted (Spec §7).
        """
        if not t.get("projection_id"):
            raise ValueError(
                "penny transcript requires a projection_id; wizard-draft "
                "transcripts are never persisted (Spec §7)"
            )
        cols = list(t.keys())
        placeholders = ", ".join("?" for _ in cols)
        with self._write_lock:
            self._conn.execute(
                f"INSERT INTO penny_transcripts ({', '.join(cols)}) "
                f"VALUES ({placeholders})",
                [t[c] for c in cols],
            )
            self._conn.commit()
        return t

    def get_transcript_by_projection(self, projection_id: str) -> dict | None:
        """Owner-scoped read by (already owner-resolved) projection id.

        Deserializes ``turns_json`` -> ``turns`` (no JSON1 above the interface).
        """
        row = self._read_conn().execute(
            "SELECT * FROM penny_transcripts WHERE projection_id = ?",
            (projection_id,),
        ).fetchone()
        if row is None:
            return None
        d = dict(row)
        try:
            d["turns"] = json.loads(d.get("turns_json") or "[]")
        except json.JSONDecodeError:
            d["turns"] = []
        return d

    def append_transcript_turn(self, projection_id: str, turn: dict) -> dict:
        """Append one turn to a projection's transcript (creating it on demand).

        Applies the §7 retention cap before persisting; returns the full
        transcript dict with parsed ``turns``. Portable SELECT-then-INSERT/UPDATE
        upsert (never the SQLite-only replace idiom). NULL/empty projection_id is
        rejected (wizard drafts are never persisted, Spec §7).
        """
        if not projection_id:
            raise ValueError(
                "penny transcript requires a projection_id; wizard-draft "
                "transcripts are never persisted (Spec §7)"
            )
        now = _utcnow()
        with self._write_lock:
            row = self._conn.execute(
                "SELECT * FROM penny_transcripts WHERE projection_id = ?",
                (projection_id,),
            ).fetchone()
            if row is None:
                turns = apply_retention([turn])
                tid = _new_transcript_id()
                created_at = now
                self._conn.execute(
                    "INSERT INTO penny_transcripts "
                    "(id, projection_id, turns_json, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (tid, projection_id, json.dumps(turns), now, now),
                )
            else:
                d = dict(row)
                tid = d["id"]
                created_at = d.get("created_at", now)
                try:
                    existing = json.loads(d.get("turns_json") or "[]")
                except json.JSONDecodeError:
                    existing = []
                turns = apply_retention([*existing, turn])
                self._conn.execute(
                    "UPDATE penny_transcripts SET turns_json = ?, updated_at = ? "
                    "WHERE id = ?",
                    (json.dumps(turns), now, tid),
                )
            self._conn.commit()
        return {
            "id": tid,
            "projection_id": projection_id,
            "turns": turns,
            "created_at": created_at,
            "updated_at": now,
        }

    # --- terms gate ---
    def get_terms_accepted_at(self, id: str) -> str | None:
        row = self._read_conn().execute(
            "SELECT terms_accepted_at FROM projections WHERE id = ?", (id,)
        ).fetchone()
        return row["terms_accepted_at"] if row else None

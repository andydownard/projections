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
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from app.store.litestream import force_pre_migration_checkpoint
from app.store.migration_safety import assert_migrations_additive
from app.store.migrations import MIGRATIONS
from app.store.penny_retention import apply_retention


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_transcript_id() -> str:
    # App-generated, time-ordered string PK (no DB autoincrement; Postgres-portable).
    return "pt_" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + secrets.token_hex(6)


class SqliteStore:
    def __init__(
        self, db_path: str, *, checkpoint: Callable[[], None] | None = None
    ) -> None:
        self.db_path = db_path
        # Pre-migration Litestream checkpoint hook (OPS_RUNBOOK §8.2). Injectable so
        # tests can spy the call ordering; defaults to the real WAL/Litestream
        # checkpoint against this store's connection.
        self._checkpoint = checkpoint
        # Single-writer serialization (DATA_MODEL.md §5.2).
        self._write_lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        cur = self._conn.cursor()
        cur.execute("PRAGMA journal_mode = WAL;")
        cur.execute("PRAGMA busy_timeout = 5000;")
        cur.execute("PRAGMA synchronous = NORMAL;")
        cur.execute("PRAGMA foreign_keys = ON;")
        self._conn.commit()

    # --- lifecycle ---
    def migrate(self) -> None:
        # Fail-closed: never run a non-additive migration against the durable
        # volume (CLAUDE.md DB discipline / OPS_RUNBOOK §8.2). The scan runs every
        # boot over the migration that is about to apply.
        assert_migrations_additive(MIGRATIONS)
        with self._write_lock:
            cur = self._conn.cursor()
            cur.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations "
                "(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
            )
            self._conn.commit()
            applied = {
                r["name"] for r in cur.execute("SELECT name FROM schema_migrations")
            }
            pending = [(name, sql) for name, sql in MIGRATIONS if name not in applied]
            if pending:
                # OPS_RUNBOOK §8.2 / SECURITY §12: force a pre-migration Litestream
                # checkpoint so there is a clean restore point BEFORE any pending DDL
                # touches the durable volume. Forced ONCE per boot (one restore
                # point for the batch), only when there is actually work to apply.
                self._run_pre_migration_checkpoint()
            for name, sql in pending:
                cur.executescript(sql)
                cur.execute(
                    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)",
                    (name, _utcnow()),
                )
                self._conn.commit()

    def _run_pre_migration_checkpoint(self) -> None:
        if self._checkpoint is not None:
            self._checkpoint()
            return
        force_pre_migration_checkpoint(self._conn, db_path=self.db_path)

    def ping(self) -> bool:
        try:
            self._conn.execute("SELECT 1").fetchone()
            return True
        except sqlite3.Error:
            return False

    # --- projections ---
    def get_projection_by_slug(self, view_slug: str) -> dict | None:
        row = self._conn.execute(
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
        return [dict(r) for r in self._conn.execute(sql, (owner_token_hash,))]

    def create_projection(self, p: dict) -> dict:
        cols = list(p.keys())
        placeholders = ", ".join("?" for _ in cols)
        with self._write_lock:
            self._conn.execute(
                f"INSERT INTO projections ({', '.join(cols)}) VALUES ({placeholders})",
                [p[c] for c in cols],
            )
            self._conn.commit()
        return p

    def update_with_version_check(
        self, id: str, expected_version: int, patch: dict[str, Any]
    ) -> int:
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

    def rotate_tokens(
        self, id: str, expected_version: int, new_hashes: dict[str, Any]
    ) -> int:
        """Atomic owner/edit/view_slug/role rotation (DATA_MODEL §6.1).

        One version-checked UPDATE re-hashes every shared capability so all prior
        links die at once. Same 0-rows -> 409 contract as every mutation.
        """
        return self.update_with_version_check(id, expected_version, dict(new_hashes))

    def set_status(self, id: str, status: str, expected_version: int) -> int:
        """Trash/restore: flip status under the optimistic-concurrency version check."""
        return self.update_with_version_check(id, expected_version, {"status": status})

    def soft_delete(self, id: str, expected_version: int) -> int:
        """Hard-delete marker: set deleted_at so the row is excluded everywhere."""
        return self.update_with_version_check(
            id, expected_version, {"deleted_at": _utcnow()})

    # --- revisions ---
    def insert_revision(self, rev: dict) -> None:
        cols = list(rev.keys())
        placeholders = ", ".join("?" for _ in cols)
        with self._write_lock:
            self._conn.execute(
                f"INSERT INTO revisions ({', '.join(cols)}) VALUES ({placeholders})",
                [rev[c] for c in cols],
            )
            self._conn.commit()

    def list_revisions(self, projection_id: str, limit: int = 50) -> list[dict]:
        return [
            dict(r)
            for r in self._conn.execute(
                "SELECT * FROM revisions WHERE projection_id = ? "
                "ORDER BY seq DESC LIMIT ?",
                (projection_id, limit),
            )
        ]

    def get_revision(self, revision_id: str) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM revisions WHERE id = ?", (revision_id,)
        ).fetchone()
        return dict(row) if row else None

    def get_projection_by_role_slug(self, role_slug: str) -> dict | None:
        """Resolve a role-link slug -> (projection_row, role_name).

        role_tokens_json maps {role_slug: role_name}. Scanned with a portable
        LIKE prefilter then matched in Python (no SQLite-only JSON1 above Store).
        """
        import json as _json

        rows = self._conn.execute(
            "SELECT * FROM projections "
            "WHERE deleted_at IS NULL AND role_tokens_json LIKE ?",
            (f'%"{role_slug}"%',),
        ).fetchall()
        for row in rows:
            try:
                mapping = _json.loads(row["role_tokens_json"] or "{}")
            except _json.JSONDecodeError:
                continue
            if role_slug in mapping:
                d = dict(row)
                d["_role_name"] = mapping[role_slug]
                return d
        return None

    # --- narratives (M5 / §6.1) ---
    def get_narrative(self, projection_id: str) -> dict | None:
        row = self._conn.execute(
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
        row = self._conn.execute(
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
        row = self._conn.execute(
            "SELECT terms_accepted_at FROM projections WHERE id = ?", (id,)
        ).fetchone()
        return row["terms_accepted_at"] if row else None

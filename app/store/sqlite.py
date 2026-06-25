"""app/store/sqlite.py — SqliteStore (v1).

WAL + busy_timeout + serialized single-writer (DATA_MODEL.md §7). App-generated
ULID PKs; explicit SELECT-then-INSERT/UPDATE (no SQLite-only upsert); opaque JSON
TEXT columns; the version-check optimistic-concurrency UPDATE is the SAME SQL the
Postgres path will use. WAL PRAGMAs are SqliteStore internals, applied on connect.
"""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

from app.store.migrations import MIGRATIONS


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class SqliteStore:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
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
            for name, sql in MIGRATIONS:
                if name in applied:
                    continue
                cur.executescript(sql)
                cur.execute(
                    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)",
                    (name, _utcnow()),
                )
                self._conn.commit()

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
                "model_version", "updated_at")
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

    # --- terms gate ---
    def get_terms_accepted_at(self, id: str) -> str | None:
        row = self._conn.execute(
            "SELECT terms_accepted_at FROM projections WHERE id = ?", (id,)
        ).fetchone()
        return row["terms_accepted_at"] if row else None

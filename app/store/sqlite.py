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

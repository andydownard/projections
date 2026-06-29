"""m0014 — share_grants table: editable shares that follow a Clerk account (#323).

Pins the additive migration that introduces ``share_grants`` (the server-side home
for shared-edit access keyed on the recipient's Clerk ``sub``). Mirrors the m0013
test style:
  (a) registered  — m0014 appears in MIGRATIONS, in order, after m0013;
  (b) additive    — passes the additive-only safety scan (no DROP/RENAME/DELETE);
  (c) shape       — the table + the expected columns + UNIQUE constraint exist after
                    migrate(), and the grantee/projection indexes are present;
  (d) idempotent  — re-applying the DDL (CREATE TABLE/INDEX IF NOT EXISTS) is a no-op.
"""
from __future__ import annotations

import sqlite3

import pytest

from app.store.migration_safety import scan_sql
from app.store.migrations import MIGRATIONS
from app.store.sqlite import SqliteStore

_SQL = dict(MIGRATIONS)["0014_share_grants"]


def _store() -> SqliteStore:
    s = SqliteStore(":memory:")
    s.migrate()
    return s


# ---------------------------------------------------------------------------
# (a) registration + ordering
# ---------------------------------------------------------------------------


def test_migration_is_registered_and_ordered():
    names = [n for n, _ in MIGRATIONS]
    assert "0014_share_grants" in names
    assert names[-1] == "0014_share_grants"
    assert names[-2] == "0013_rebind_longview_clerk_sub"


# ---------------------------------------------------------------------------
# (b) additive-only
# ---------------------------------------------------------------------------


def test_migration_is_additive_only():
    assert scan_sql(_SQL) == []  # no DROP/RENAME/destructive ALTER/DELETE/TRUNCATE


# ---------------------------------------------------------------------------
# (c) table + columns + UNIQUE + indexes
# ---------------------------------------------------------------------------


def test_share_grants_table_and_columns_exist():
    s = _store()
    cols = {r[1] for r in s._read_conn().execute("PRAGMA table_info(share_grants)")}
    assert cols == {
        "id",
        "projection_id",
        "role",
        "grantee_clerk_user_id",
        "grantee_owner_token_hash",
        "created_at",
    }


def test_role_defaults_to_editor():
    s = _store()
    s.create_projection(_projection_row("p1", "s1"))
    s._conn.execute(
        "INSERT INTO share_grants (id, projection_id, grantee_clerk_user_id, created_at) "
        "VALUES (?, ?, ?, ?)",
        ("g1", "p1", "user_a", "2026-06-29T00:00:00Z"),
    )
    s._conn.commit()
    role = s._read_conn().execute(
        "SELECT role FROM share_grants WHERE id = 'g1'"
    ).fetchone()[0]
    assert role == "editor"


def test_unique_projection_grantee_enforced():
    s = _store()
    s.create_projection(_projection_row("p1", "s1"))
    s._conn.execute(
        "INSERT INTO share_grants (id, projection_id, role, grantee_clerk_user_id, created_at) "
        "VALUES (?, ?, 'editor', ?, ?)",
        ("g1", "p1", "user_a", "2026-06-29T00:00:00Z"),
    )
    s._conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        s._conn.execute(
            "INSERT INTO share_grants (id, projection_id, role, grantee_clerk_user_id, created_at) "
            "VALUES (?, ?, 'editor', ?, ?)",
            ("g2", "p1", "user_a", "2026-06-29T00:00:01Z"),
        )


def test_grantee_and_projection_indexes_exist():
    s = _store()
    idx = {r[1] for r in s._read_conn().execute("PRAGMA index_list(share_grants)")}
    assert "idx_share_grants_grantee" in idx
    assert "idx_share_grants_projection" in idx


# ---------------------------------------------------------------------------
# (d) idempotent — re-applying the DDL is a no-op
# ---------------------------------------------------------------------------


def test_reapply_is_idempotent():
    s = _store()
    s._conn.executescript(_SQL)  # CREATE TABLE/INDEX IF NOT EXISTS → no-op
    s._conn.commit()
    cols = {r[1] for r in s._read_conn().execute("PRAGMA table_info(share_grants)")}
    assert "grantee_clerk_user_id" in cols


def _projection_row(pid: str, slug: str) -> dict:
    return {
        "id": pid,
        "view_slug": slug,
        "owner_token_hash": "tok-" + pid,
        "name": "P",
        "model_version": "2.7.0",
        "compute_schema_version": "1.5.0",
        "computed_json": "{}",
        "created_at": "2026-06-29T00:00:00Z",
        "updated_at": "2026-06-29T00:00:00Z",
    }

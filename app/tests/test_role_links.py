"""#180 — indexed role-link resolution (no leading-wildcard LIKE scan).

`get_projection_by_role_slug` scanned the whole projections table with
`role_tokens_json LIKE '%"<slug>"%'` (unindexed, leading-wildcard, won't port to
Postgres) on every UNAUTHENTICATED `/api/r/{slug}` request. These tests pin the
fix: a first-class `role_links` table with a UNIQUE slug PK giving O(1) exact-match
resolution, kept in sync from `role_tokens_json` at write time, and a tolerant
parser + backfill for legacy data.

RED-first: the `role_links` table, the sync, and the exact-match lookup do not
exist yet.
"""
from __future__ import annotations

import inspect
import json
from datetime import datetime, timezone

import pytest

from app.store.role_links import parse_role_tokens, slug_token_hash
from app.store.sqlite import SqliteStore
from engine.model import COMPUTE_SCHEMA_VERSION, MODEL_VERSION


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


def _make(store, *, pid, slug, owner="ownerA", roles=None):
    p = {
        "id": pid, "view_slug": slug, "owner_token_hash": owner, "name": "P",
        "model_version": MODEL_VERSION,
        "compute_schema_version": COMPUTE_SCHEMA_VERSION,
        "computed_json": json.dumps({"reco": {"tag": "proceed"}}),
        "created_at": _now(), "updated_at": _now(),
    }
    if roles is not None:
        p["role_tokens_json"] = json.dumps(roles)
    return store.create_projection(p)


def test_parse_role_tokens_tolerates_both_shapes():
    # legacy shipped shape {slug: role_name}
    legacy = parse_role_tokens(json.dumps({"board-slug": "board"}))
    assert legacy == [{"role_name": "board", "slug": "board-slug"}]
    # documented shape {role_name: {slug, token_hash}}
    documented = parse_role_tokens(json.dumps(
        {"funder": {"slug": "f_123", "token_hash": "abc"}}))
    assert documented == [{"role_name": "funder", "slug": "f_123"}]
    assert parse_role_tokens("") == []
    assert parse_role_tokens("{}") == []


def test_parse_role_tokens_ignores_malformed_input():
    # A corrupt/non-dict blob must never raise (it would break an unauthenticated
    # role lookup or a projection write); it degrades to "no links".
    assert parse_role_tokens("not json") == []
    assert parse_role_tokens("[1,2,3]") == []
    assert parse_role_tokens(None) == []
    # documented-shape entry missing a slug is skipped, legacy entry kept
    mixed = parse_role_tokens(json.dumps(
        {"board": {"token_hash": "x"}, "funder-slug": "funder"}))
    assert mixed == [{"role_name": "funder", "slug": "funder-slug"}]


def test_slug_token_hash_is_sha256_hex():
    h = slug_token_hash("board-slug")
    assert len(h) == 64
    int(h, 16)  # valid hex
    assert slug_token_hash("board-slug") == slug_token_hash("board-slug")


def test_role_links_table_has_slug_pk(store):
    info = store._conn.execute("PRAGMA table_info(role_links)").fetchall()
    cols = {r["name"]: r for r in info}
    assert {"slug", "projection_id", "role_name", "token_hash"} <= set(cols)
    assert cols["slug"]["pk"] == 1  # slug is the primary key (exact-match lookup)


def test_create_syncs_role_links_and_resolves(store):
    _make(store, pid="p1", slug="s1", roles={"board-slug": "board"})
    row = store.get_projection_by_role_slug("board-slug")
    assert row is not None
    assert row["id"] == "p1"
    assert row["_role_name"] == "board"


def test_unknown_role_slug_returns_none(store):
    _make(store, pid="p1", slug="s1", roles={"board-slug": "board"})
    assert store.get_projection_by_role_slug("nope") is None


def test_resolution_uses_exact_match_not_leading_wildcard_like():
    # Guard: the role resolver must never reintroduce the unindexed leading-wildcard
    # LIKE scan (#180). The SqliteStore source must not contain a LIKE '%... pattern.
    src = inspect.getsource(SqliteStore)
    assert "LIKE '%" not in src
    assert 'LIKE "%' not in src


def test_deleted_projection_role_slug_does_not_resolve(store):
    _make(store, pid="p1", slug="s1", roles={"board-slug": "board"})
    # mark the projection deleted (hard-delete marker)
    store.soft_delete("p1", 1)
    assert store.get_projection_by_role_slug("board-slug") is None


def test_rotate_resyncs_role_links(store):
    _make(store, pid="p1", slug="s1", roles={"old-slug": "board"})
    assert store.get_projection_by_role_slug("old-slug") is not None
    # rotate re-mints the role slug (keeping the role name)
    store.rotate_tokens("p1", 1, {
        "view_slug": "s1b",
        "role_tokens_json": json.dumps({"new-slug": "board"}),
    })
    assert store.get_projection_by_role_slug("old-slug") is None  # old link dead
    new = store.get_projection_by_role_slug("new-slug")
    assert new is not None and new["_role_name"] == "board"


def test_role_link_stores_hashed_companion(store):
    _make(store, pid="p1", slug="s1", roles={"board-slug": "board"})
    row = store._conn.execute(
        "SELECT token_hash FROM role_links WHERE slug='board-slug'"
    ).fetchone()
    assert row["token_hash"] == slug_token_hash("board-slug")


def test_multiple_roles_each_resolve(store):
    _make(store, pid="p1", slug="s1",
          roles={"b-slug": "board", "f-slug": "funder", "a-slug": "advisor"})
    assert store.get_projection_by_role_slug("b-slug")["_role_name"] == "board"
    assert store.get_projection_by_role_slug("f-slug")["_role_name"] == "funder"
    assert store.get_projection_by_role_slug("a-slug")["_role_name"] == "advisor"


def test_rotate_drops_a_removed_role(store):
    # Rotation is the role-link write path. Re-minting with only the board link must
    # leave the funder slug unresolvable (its role_links row is rebuilt away).
    _make(store, pid="p1", slug="s1", roles={"keep": "board", "drop": "funder"})
    assert store.get_projection_by_role_slug("drop") is not None
    store.rotate_tokens("p1", 1, {"role_tokens_json": json.dumps({"keep": "board"})})
    assert store.get_projection_by_role_slug("drop") is None
    assert store.get_projection_by_role_slug("keep") is not None


def test_documented_shape_resolves_through_store(store):
    _make(store, pid="p1", slug="s1",
          roles={"board": {"slug": "b_doc", "token_hash": "ignored"}})
    assert store.get_projection_by_role_slug("b_doc")["_role_name"] == "board"


def test_backfill_role_links_for_legacy_rows(tmp_path):
    db = tmp_path / "legacy.db"
    s1 = SqliteStore(str(db))
    s1.migrate()
    _make(s1, pid="p1", slug="s1", roles={"board-slug": "board"})
    # Simulate the pre-0009 state: drop the role_links rows + ledger entry so the
    # next boot re-runs the backfill from role_tokens_json.
    s1._conn.execute("DELETE FROM role_links")
    s1._conn.execute("DELETE FROM schema_migrations WHERE name='0009_role_links'")
    s1._conn.commit()

    s2 = SqliteStore(str(db))
    s2.migrate()  # re-applies 0009 -> backfill runs
    assert s2.get_projection_by_role_slug("board-slug")["id"] == "p1"

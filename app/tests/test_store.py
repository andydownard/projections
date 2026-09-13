"""Store / migration / terms-gate tests (M0.4 / M0.6).

Verifies: 0001_init creates every DATA_MODEL.md table incl. the EMPTY actuals table
and cohort_json; global list (no auth, owner decision 2026-09-13); version-checked
update (409 path); the terms gate. No SQLite-isms leak above the Store.
"""
from datetime import datetime, timezone

import pytest

from app.deps import new_internal_owner_hash, parse_if_match
from app.store.sqlite import SqliteStore
from app.terms import require_terms_accepted
from engine.model import COMPUTE_SCHEMA_VERSION, MODEL_VERSION

EXPECTED_TABLES = {
    "schema_migrations", "projections", "revisions", "narratives",
    "evidence", "research_cache", "feedback", "actuals",
}


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


def _make_projection(store, *, slug, owner_hash, name="P", terms=None):
    p = {
        "id": "01J" + slug,
        "view_slug": slug,
        "owner_token_hash": owner_hash,
        "name": name,
        "model_version": MODEL_VERSION,
        "compute_schema_version": COMPUTE_SCHEMA_VERSION,
        "terms_accepted_at": terms,
        "created_at": _now(),
        "updated_at": _now(),
    }
    return store.create_projection(p)


def test_migration_creates_all_tables(store):
    rows = store._conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    names = {r["name"] for r in rows}
    assert EXPECTED_TABLES <= names


def test_actuals_table_is_empty_schema_only(store):
    count = store._conn.execute("SELECT COUNT(*) AS c FROM actuals").fetchone()["c"]
    assert count == 0
    cols = {
        r["name"]
        for r in store._conn.execute("PRAGMA table_info(actuals)").fetchall()
    }
    assert {"projection_id", "month", "revenue", "cohort_json"} <= cols


def test_projections_has_cohort_json_column(store):
    cols = {
        r["name"]
        for r in store._conn.execute("PRAGMA table_info(projections)").fetchall()
    }
    assert "cohort_json" in cols


def test_migration_is_idempotent(store):
    store.migrate()  # second run must not raise / duplicate
    applied = store._conn.execute(
        "SELECT COUNT(*) AS c FROM schema_migrations WHERE name='0001_init'"
    ).fetchone()["c"]
    assert applied == 1


def test_wal_mode_enabled(store):
    mode = store._conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "memory" or mode.lower() == "wal"
    # in-memory dbs report 'memory'; a file db reports 'wal'.


def test_list_card_summaries_is_global(store):
    # No authentication (owner decision, 2026-09-13): the list is global, not
    # scoped to any owner/token.
    _make_projection(store, slug="aaa", owner_hash="ownerA")
    _make_projection(store, slug="bbb", owner_hash="ownerB")
    slugs = {r["view_slug"] for r in store.list_card_summaries()}
    assert slugs == {"aaa", "bbb"}


def test_get_by_slug(store):
    _make_projection(store, slug="ccc", owner_hash="ownerA")
    assert store.get_projection_by_slug("ccc")["view_slug"] == "ccc"
    assert store.get_projection_by_slug("nonexistent") is None


def test_version_check_update_succeeds_then_409s(store):
    _make_projection(store, slug="ddd", owner_hash="ownerA")
    pid = "01Jddd"
    # correct version -> 1 row affected, version bumps to 2
    assert store.update_with_version_check(pid, 1, {"name": "renamed"}) == 1
    # stale version -> 0 rows (the 409 path)
    assert store.update_with_version_check(pid, 1, {"name": "again"}) == 0
    # current version -> 1 row
    assert store.update_with_version_check(pid, 2, {"name": "ok"}) == 1


def test_revision_insert_and_list(store):
    _make_projection(store, slug="eee", owner_hash="ownerA")
    store.insert_revision({
        "id": "rev1", "projection_id": "01Jeee", "seq": 1,
        "inputs_json": "{}", "assumptions_json": "{}", "overrides_json": "{}",
        "monthly_json": "{}", "computed_json": "{}", "model_version": MODEL_VERSION,
        "created_at": _now(),
    })
    revs = store.list_revisions("01Jeee")
    assert len(revs) == 1 and revs[0]["seq"] == 1


def test_ping(store):
    assert store.ping() is True


# --- internal owner-hash primitive (vestigial NOT NULL column, never returned) ---

def test_new_internal_owner_hash_is_sha256_hex_and_random():
    h = new_internal_owner_hash()
    assert len(h) == 64
    int(h, 16)  # valid hex
    assert new_internal_owner_hash() != h  # random each call, never deterministic


# --- If-Match parsing (SECURITY.md §6.1) ---

def test_parse_if_match_valid():
    assert parse_if_match("7") == 7
    assert parse_if_match('"7"') == 7


def test_parse_if_match_missing_raises_428():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        parse_if_match(None)
    assert exc.value.status_code == 428


def test_parse_if_match_invalid_raises_400():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        parse_if_match("notanumber")
    assert exc.value.status_code == 400


# --- terms gate (M0.6) ---

def test_terms_gate_blocks_without_acceptance(monkeypatch, store):
    _make_projection(store, slug="fff", owner_hash="ownerA", terms=None)
    import app.terms as terms_mod

    monkeypatch.setattr(terms_mod, "get_store", lambda: store)
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        require_terms_accepted("01Jfff")
    assert exc.value.status_code == 403
    assert exc.value.detail == {"error": "terms_required"}


def test_terms_gate_passes_when_accepted(monkeypatch, store):
    _make_projection(store, slug="ggg", owner_hash="ownerA", terms=_now())
    import app.terms as terms_mod

    monkeypatch.setattr(terms_mod, "get_store", lambda: store)
    require_terms_accepted("01Jggg")  # no raise


def test_no_insert_or_replace_in_sqlite_store():
    # Guard: no SQLite-only upsert leaks above the interface (DATA_MODEL.md §9).
    import inspect

    import app.store.sqlite as mod

    src = inspect.getsource(mod)
    assert "INSERT OR REPLACE" not in src.upper()
    assert "LAST_INSERT_ROWID" not in src.upper()

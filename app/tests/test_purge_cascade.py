"""#202 — honest purge: real hard-delete with cascade.

The DELETE endpoint promised an "irreversible" purge but only set `deleted_at`
(soft delete): the projection's financial blobs, plus every `revisions` snapshot,
`narratives`, `evidence`, `penny_transcripts` and role link, persisted forever (and
into Litestream backups). These tests pin `purge_projection`: a version-checked
hard `DELETE FROM projections` that cascades to all child rows, so a privacy purge
actually erases the data.

RED-first: `purge_projection` does not exist yet.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from app.store.sqlite import SqliteStore
from engine.model import COMPUTE_SCHEMA_VERSION, MODEL_VERSION


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


def _make_full(store, *, pid="p1", slug="s1", owner="ownerA", role_slug="board-slug"):
    """A projection with one of every child row, to prove the cascade."""
    store.create_projection({
        "id": pid, "view_slug": slug, "owner_token_hash": owner, "name": "P",
        "model_version": MODEL_VERSION,
        "compute_schema_version": COMPUTE_SCHEMA_VERSION,
        "computed_json": json.dumps({"reco": {"tag": "proceed"}}),
        "role_tokens_json": json.dumps({role_slug: "board"}),
        "created_at": _now(), "updated_at": _now(),
    })
    store.insert_revision({
        "id": f"rev_{pid}", "projection_id": pid, "seq": 1,
        "inputs_json": "{}", "assumptions_json": "{}", "overrides_json": "{}",
        "monthly_json": "{}", "computed_json": "{}", "model_version": MODEL_VERSION,
        "created_at": _now(),
    })
    store.upsert_narrative(
        pid, {"body_md": "secret financials", "edited": 0, "updated_at": _now()})
    store.append_transcript_turn(pid, {"role": "user", "content": "private", "ts": _now()})
    store._conn.execute(
        "INSERT INTO evidence (id, projection_id, field, kind, created_at) "
        "VALUES (?, ?, 'rent', 'researched', ?)", (f"ev_{pid}", pid, _now()))
    store._conn.commit()


def _counts(store, pid):
    c = store._conn
    return {
        "projections": c.execute(
            "SELECT COUNT(*) AS n FROM projections WHERE id=?", (pid,)).fetchone()["n"],
        "revisions": c.execute(
            "SELECT COUNT(*) AS n FROM revisions WHERE projection_id=?", (pid,)).fetchone()["n"],
        "narratives": c.execute(
            "SELECT COUNT(*) AS n FROM narratives WHERE projection_id=?", (pid,)).fetchone()["n"],
        "penny_transcripts": c.execute(
            "SELECT COUNT(*) AS n FROM penny_transcripts WHERE projection_id=?",
            (pid,)).fetchone()["n"],
        "evidence": c.execute(
            "SELECT COUNT(*) AS n FROM evidence WHERE projection_id=?", (pid,)).fetchone()["n"],
        "role_links": c.execute(
            "SELECT COUNT(*) AS n FROM role_links WHERE projection_id=?", (pid,)).fetchone()["n"],
    }


def test_purge_hard_deletes_and_cascades(store):
    _make_full(store)
    before = _counts(store, "p1")
    assert before["projections"] == 1 and before["revisions"] == 1
    assert before["narratives"] == 1 and before["penny_transcripts"] == 1
    assert before["evidence"] == 1 and before["role_links"] == 1

    affected = store.purge_projection("p1", 1)
    assert affected == 1

    after = _counts(store, "p1")
    assert after == {k: 0 for k in after}  # everything erased, no orphans
    # the role link no longer resolves
    assert store.get_projection_by_role_slug("board-slug") is None
    # the row is truly gone (not merely deleted_at)
    assert store.get_projection_by_slug("s1") is None


def test_purge_version_mismatch_returns_zero_and_keeps_data(store):
    _make_full(store)
    affected = store.purge_projection("p1", 99)  # stale version
    assert affected == 0
    after = _counts(store, "p1")
    assert after["projections"] == 1  # nothing deleted on a 409
    assert after["revisions"] == 1
    assert after["narratives"] == 1


def test_purge_unknown_id_returns_zero(store):
    assert store.purge_projection("nope", 1) == 0


def test_purge_leaves_other_projections_intact(store):
    _make_full(store, pid="p1", slug="s1", role_slug="board-1")
    _make_full(store, pid="p2", slug="s2", role_slug="board-2")
    assert store.purge_projection("p1", 1) == 1
    # the sibling projection and all its children are untouched
    after = _counts(store, "p2")
    assert after["projections"] == 1 and after["revisions"] == 1
    assert after["narratives"] == 1 and after["role_links"] == 1
    assert store.get_projection_by_slug("s2") is not None


def test_purge_frees_the_view_slug(store):
    # After a real erase the slug is free — a re-create with the same slug must not
    # collide with a lingering soft-deleted row (it would, under the old behavior).
    _make_full(store, pid="p1", slug="s1")
    assert store.purge_projection("p1", 1) == 1
    _make_full(store, pid="p2", slug="s1")  # same slug, no UNIQUE collision
    assert store.get_projection_by_slug("s1")["id"] == "p2"


def test_purge_is_atomic_under_foreign_keys(store):
    # With PRAGMA foreign_keys=ON and no ON DELETE CASCADE, children MUST be deleted
    # before the parent or the DELETE raises — assert the whole cascade succeeds.
    _make_full(store)
    store._conn.execute("PRAGMA foreign_keys = ON")
    assert store.purge_projection("p1", 1) == 1
    assert _counts(store, "p1") == {k: 0 for k in _counts(store, "p1")}

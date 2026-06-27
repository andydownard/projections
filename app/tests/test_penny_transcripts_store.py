"""PE2 — penny_transcripts Store conformance (Spec §7; issue #121).

Drives the new Store seam: create / append-turn / get-by-projection, the
never-persist-a-wizard-draft invariant (NULL projection_id), owner-scoped (per
projection) isolation, the retention/size cap, and the revision ``actor`` enum
round-trip. The Postgres stub must expose the same surface (raises until wired).
"""
from __future__ import annotations

import pytest

from app.store import penny_retention
from app.store.postgres import PostgresStore
from app.store.sqlite import SqliteStore
from engine.model import COMPUTE_SCHEMA_VERSION, MODEL_VERSION


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


def _make_projection(store, *, pid, slug, owner_hash="ownerA"):
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    store.create_projection({
        "id": pid,
        "view_slug": slug,
        "owner_token_hash": owner_hash,
        "name": "P",
        "model_version": MODEL_VERSION,
        "compute_schema_version": COMPUTE_SCHEMA_VERSION,
        "created_at": now,
        "updated_at": now,
    })


def _turn(role="user", content="hi", **extra):
    return {"role": role, "content": content, "ts": "2026-06-27T00:00:00Z", **extra}


# ----------------------------------------------------------- create / get
def test_get_transcript_absent_returns_none(store):
    _make_projection(store, pid="p1", slug="s1")
    assert store.get_transcript_by_projection("p1") is None


def test_create_then_get_round_trip(store):
    _make_projection(store, pid="p1", slug="s1")
    store.create_transcript({
        "id": "pt1",
        "projection_id": "p1",
        "turns_json": "[]",
        "created_at": "2026-06-27T00:00:00Z",
        "updated_at": "2026-06-27T00:00:00Z",
    })
    t = store.get_transcript_by_projection("p1")
    assert t is not None
    assert t["id"] == "pt1"
    assert t["projection_id"] == "p1"
    assert t["turns"] == []  # turns_json deserialized to a list


# ----------------------------------------------------------- append round-trip
def test_append_creates_on_demand_and_returns_turns(store):
    _make_projection(store, pid="p1", slug="s1")
    t = store.append_transcript_turn("p1", _turn(content="Set Y1 share to 8%"))
    assert [x["content"] for x in t["turns"]] == ["Set Y1 share to 8%"]
    # persisted: a second fetch sees the same single turn.
    again = store.get_transcript_by_projection("p1")
    assert [x["content"] for x in again["turns"]] == ["Set Y1 share to 8%"]


def test_append_preserves_turn_order(store):
    _make_projection(store, pid="p1", slug="s1")
    store.append_transcript_turn("p1", _turn(role="user", content="one"))
    store.append_transcript_turn("p1", _turn(role="assistant", content="two"))
    store.append_transcript_turn("p1", _turn(role="tool", content="three"))
    t = store.get_transcript_by_projection("p1")
    assert [x["content"] for x in t["turns"]] == ["one", "two", "three"]
    assert [x["role"] for x in t["turns"]] == ["user", "assistant", "tool"]


def test_append_persists_full_turn_shape(store):
    _make_projection(store, pid="p1", slug="s1")
    store.append_transcript_turn("p1", _turn(
        role="tool", content="applied", tool_name="set_assumption",
        tool_args={"node": "share_y1", "value": "0.08"},
        tool_result_ref="ref123", revision_id="rev9", provider="anthropic",
    ))
    t = store.get_transcript_by_projection("p1")
    turn = t["turns"][0]
    assert turn["tool_name"] == "set_assumption"
    assert turn["tool_args"] == {"node": "share_y1", "value": "0.08"}
    assert turn["revision_id"] == "rev9"
    assert turn["provider"] == "anthropic"


def test_append_bumps_updated_at(store):
    _make_projection(store, pid="p1", slug="s1")
    store.append_transcript_turn("p1", _turn(content="a"))
    first = store.get_transcript_by_projection("p1")["updated_at"]
    store.append_transcript_turn("p1", _turn(content="b"))
    second = store.get_transcript_by_projection("p1")["updated_at"]
    assert second >= first


# ------------------------------------------------ wizard-draft never persisted
def test_create_rejects_null_projection_id(store):
    # Spec §7: ephemeral wizard-draft transcripts (projection_id NULL) are NEVER
    # written. The store seam fails closed rather than persisting a draft.
    with pytest.raises(ValueError):
        store.create_transcript({
            "id": "pt1",
            "projection_id": None,
            "turns_json": "[]",
            "created_at": "now",
            "updated_at": "now",
        })


def test_append_rejects_null_projection_id(store):
    with pytest.raises(ValueError):
        store.append_transcript_turn(None, _turn())


def test_append_rejects_empty_projection_id(store):
    with pytest.raises(ValueError):
        store.append_transcript_turn("", _turn())


# ----------------------------------------------------------- owner-scoping
def test_transcripts_are_isolated_per_projection(store):
    _make_projection(store, pid="p1", slug="s1", owner_hash="ownerA")
    _make_projection(store, pid="p2", slug="s2", owner_hash="ownerB")
    store.append_transcript_turn("p1", _turn(content="A-secret"))
    store.append_transcript_turn("p2", _turn(content="B-secret"))
    a = store.get_transcript_by_projection("p1")
    b = store.get_transcript_by_projection("p2")
    assert [x["content"] for x in a["turns"]] == ["A-secret"]
    assert [x["content"] for x in b["turns"]] == ["B-secret"]
    # No cross-projection leakage.
    assert "B-secret" not in str(a)
    assert "A-secret" not in str(b)


# ----------------------------------------------------------- retention cap
def test_retention_caps_total_turns():
    turns = [{"role": "user", "content": str(i)} for i in range(penny_retention.MAX_TURNS + 50)]
    kept = penny_retention.apply_retention(turns)
    assert len(kept) == penny_retention.MAX_TURNS
    # The most-recent turns survive; the oldest are dropped.
    assert kept[-1]["content"] == str(penny_retention.MAX_TURNS + 49)
    assert kept[0]["content"] == str(50)


def test_retention_truncates_old_tool_payloads_keeps_summary():
    turns = [
        {"role": "tool", "content": f"summary {i}", "tool_args": {"big": "x" * 100},
         "tool_result_ref": f"ref{i}"}
        for i in range(penny_retention.TOOL_PAYLOAD_RETENTION + 10)
    ]
    kept = penny_retention.apply_retention(turns)
    # Oldest tool turns: heavy payload stripped, human-readable summary kept.
    assert kept[0]["content"] == "summary 0"
    assert kept[0]["tool_args"] is None
    assert kept[0]["tool_result_ref"] is None
    # Most-recent tool turns: payload retained.
    assert kept[-1]["tool_args"] == {"big": "x" * 100}


def test_retention_does_not_truncate_recent_assistant_prose():
    turns = [{"role": "assistant", "content": f"prose {i}"} for i in range(5)]
    kept = penny_retention.apply_retention(turns)
    assert kept == turns  # nothing to strip; nothing capped


def test_append_enforces_retention_cap_on_persist(store):
    _make_projection(store, pid="p1", slug="s1")
    for i in range(penny_retention.MAX_TURNS + 25):
        store.append_transcript_turn("p1", _turn(content=str(i)))
    t = store.get_transcript_by_projection("p1")
    assert len(t["turns"]) == penny_retention.MAX_TURNS
    assert t["turns"][-1]["content"] == str(penny_retention.MAX_TURNS + 24)


# ----------------------------------------------------------- revision actor enum
def test_revision_actor_enum_round_trips(store):
    _make_projection(store, pid="p1", slug="s1")
    store.insert_revision({
        "id": "rev1", "projection_id": "p1", "seq": 1,
        "inputs_json": "{}", "assumptions_json": "{}", "overrides_json": "{}",
        "monthly_json": "{}", "computed_json": "{}", "model_version": MODEL_VERSION,
        "actor": "penny", "created_at": "2026-06-27T00:00:00Z",
    })
    revs = store.list_revisions("p1")
    assert revs[0]["actor"] == "penny"


def test_revision_actor_defaults_to_user_when_omitted(store):
    _make_projection(store, pid="p1", slug="s1")
    store.insert_revision({
        "id": "rev1", "projection_id": "p1", "seq": 1,
        "inputs_json": "{}", "assumptions_json": "{}", "overrides_json": "{}",
        "monthly_json": "{}", "computed_json": "{}", "model_version": MODEL_VERSION,
        "created_at": "2026-06-27T00:00:00Z",
    })
    revs = store.list_revisions("p1")
    assert revs[0]["actor"] == "user"


# ----------------------------------------------------------- portability
def test_no_sqlite_only_sql_for_transcripts():
    import inspect

    import app.store.sqlite as mod

    src = inspect.getsource(mod)
    assert "INSERT OR REPLACE" not in src.upper()
    assert "LAST_INSERT_ROWID" not in src.upper()


def test_postgres_stub_exposes_transcript_surface():
    pg = PostgresStore("postgres://stub")
    for name, args in [
        ("create_transcript", ({},)),
        ("append_transcript_turn", ("p1", {})),
        ("get_transcript_by_projection", ("p1",)),
    ]:
        with pytest.raises(NotImplementedError):
            getattr(pg, name)(*args)

"""#179 — bounded revisions + drop the write-only compute snapshot.

Each revision stored the full ~10KB `computed_json` (and an empty `monthly_json`)
that is NEVER read back — `restore_revision` recomputes from
inputs/assumptions/overrides — so it is pure Litestream write-amplification. And
revisions grew unbounded. These tests pin:

1. `insert_revision` / the atomic write strip the recomputable compute snapshot
   (`computed_json`/`monthly_json` -> '{}').
2. a per-projection retention cap prunes the oldest beyond N, preserving the
   recent window and the protected (upgrade/rotate audit) revisions.

RED-first: `revision_retention` + the store-side strip/prune do not exist yet.
"""
from __future__ import annotations

import pytest

import app.store.revision_retention as rr
from app.store.revision_retention import is_protected, strip_recomputable
from app.store.sqlite import SqliteStore
from engine.model import COMPUTE_SCHEMA_VERSION, MODEL_VERSION


def _now() -> str:
    return "2026-01-01T00:00:00Z"


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


def _make_projection(store, *, pid="p1", slug="s1", owner="owner"):
    store.create_projection({
        "id": pid, "view_slug": slug, "owner_token_hash": owner, "name": "P",
        "model_version": MODEL_VERSION,
        "compute_schema_version": COMPUTE_SCHEMA_VERSION,
        "created_at": _now(), "updated_at": _now(),
    })


def _rev(pid, seq, *, computed="x" * 10000, summary=""):
    return {
        "id": f"rev_{pid}_{seq}", "projection_id": pid, "seq": seq,
        "inputs_json": '{"a":1}', "assumptions_json": "{}", "overrides_json": "{}",
        "monthly_json": '{"big":"' + "y" * 5000 + '"}',
        "computed_json": '{"vm":"' + computed + '"}',
        "model_version": MODEL_VERSION, "change_summary": summary,
        "created_at": _now(),
    }


def test_strip_recomputable_blanks_compute_snapshot():
    out = strip_recomputable(_rev("p1", 1))
    assert out["computed_json"] == "{}"
    assert out["monthly_json"] == "{}"
    # the recoverable inputs are preserved (restore reads these)
    assert out["inputs_json"] == '{"a":1}'
    assert out["model_version"] == MODEL_VERSION


def test_strip_recomputable_does_not_mutate_input():
    rev = _rev("p1", 1)
    original_computed = rev["computed_json"]
    strip_recomputable(rev)
    assert rev["computed_json"] == original_computed  # caller's dict untouched


def test_strip_recomputable_tolerates_missing_fields():
    # A revision dict that omits monthly_json (e.g. a rotation audit row) is fine —
    # only present recomputable fields are blanked.
    out = strip_recomputable({"id": "r", "projection_id": "p1", "seq": 1,
                              "computed_json": "{...}"})
    assert out["computed_json"] == "{}"
    assert "monthly_json" not in out


def test_is_protected_marks_upgrade_and_rotate():
    assert is_protected("upgrade_model to 2.1.0")
    assert is_protected("tokens_rotated")
    assert not is_protected("edited labor %")
    assert not is_protected("")


def test_insert_revision_does_not_persist_compute_snapshot(store):
    _make_projection(store)
    store.insert_revision(_rev("p1", 2))
    row = store._conn.execute(
        "SELECT computed_json, monthly_json, inputs_json FROM revisions "
        "WHERE projection_id='p1'"
    ).fetchone()
    assert row["computed_json"] == "{}"
    assert row["monthly_json"] == "{}"
    assert row["inputs_json"] == '{"a":1}'  # recoverable inputs retained


def test_retention_caps_revisions_and_keeps_recent(store, monkeypatch):
    monkeypatch.setattr(rr, "MAX_REVISIONS_PER_PROJECTION", 5)
    _make_projection(store)
    for seq in range(1, 21):  # 20 plain revisions, cap 5
        store.insert_revision(_rev("p1", seq))
    revs = store.list_revisions("p1", limit=100)
    seqs = sorted(r["seq"] for r in revs)
    assert len(seqs) == 5
    assert seqs == [16, 17, 18, 19, 20]  # the 5 most recent survive


def test_retention_preserves_protected_revisions(store, monkeypatch):
    monkeypatch.setattr(rr, "MAX_REVISIONS_PER_PROJECTION", 3)
    _make_projection(store)
    store.insert_revision(_rev("p1", 1, summary="upgrade_model"))  # protected, old
    store.insert_revision(_rev("p1", 2, summary="tokens_rotated"))  # protected, old
    for seq in range(3, 11):  # 8 plain revisions
        store.insert_revision(_rev("p1", seq))
    revs = store.list_revisions("p1", limit=100)
    seqs = {r["seq"] for r in revs}
    # the two protected old ones survive despite being outside the recent-3 window
    assert {1, 2} <= seqs
    # the recent window is kept
    assert {8, 9, 10} <= seqs
    # a non-protected old one (e.g. seq 3) was pruned
    assert 3 not in seqs


def test_retention_is_per_projection(store, monkeypatch):
    monkeypatch.setattr(rr, "MAX_REVISIONS_PER_PROJECTION", 2)
    _make_projection(store, pid="p1", slug="s1")
    _make_projection(store, pid="p2", slug="s2")
    for seq in range(1, 6):
        store.insert_revision(_rev("p1", seq))
        store.insert_revision(_rev("p2", seq))
    assert len(store.list_revisions("p1", limit=100)) == 2
    assert len(store.list_revisions("p2", limit=100)) == 2


def test_atomic_update_path_strips_and_prunes(store, monkeypatch):
    # The single-transaction version+revision write (#186) must apply the SAME #179
    # policy: blank the compute snapshot and bound the count.
    monkeypatch.setattr(rr, "MAX_REVISIONS_PER_PROJECTION", 3)
    _make_projection(store)
    for ver in range(1, 8):  # 7 atomic version-checked writes + revisions
        rev = _rev("p1", ver + 1)
        assert store.update_with_version_check_and_revision(
            "p1", ver, {"name": f"n{ver}"}, rev) == 1
    revs = store.list_revisions("p1", limit=100)
    assert len(revs) == 3  # capped
    stored = store._conn.execute(
        "SELECT computed_json, monthly_json FROM revisions WHERE projection_id='p1' "
        "ORDER BY seq DESC LIMIT 1"
    ).fetchone()
    assert stored["computed_json"] == "{}"  # snapshot stripped on the atomic path too
    assert stored["monthly_json"] == "{}"


def test_under_cap_keeps_all_revisions(store, monkeypatch):
    monkeypatch.setattr(rr, "MAX_REVISIONS_PER_PROJECTION", 50)
    _make_projection(store)
    for seq in range(1, 11):
        store.insert_revision(_rev("p1", seq))
    assert len(store.list_revisions("p1", limit=100)) == 10  # nothing pruned

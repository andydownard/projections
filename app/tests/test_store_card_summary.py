"""#178 — owner-list card-summary denormalization (perf).

`list_projections` used `SELECT *` + `json.loads` of the full ~10KB `computed_json`
per row to extract ~6 card fields. These tests pin the fix: a compact `summary_json`
denormalized at write time and a `list_card_summaries` read path that selects ONLY
the small columns (never the heavy JSON blobs), so the owner list never parses a full
compute snapshot per row.

RED-first: `summary_json`, `build_card_summary`, and `list_card_summaries` do not
exist yet.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from app.store.card_summary import build_card_summary
from app.store.sqlite import SqliteStore
from engine.model import COMPUTE_SCHEMA_VERSION, MODEL_VERSION


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


_VM = {
    "model_version": MODEL_VERSION,
    "reco": {"tag": "proceed"},
    "metrics": {"capital": {"raw": 277990, "display": "$277,990"}},
    "kpis": [
        {"label": "Total revenue", "value": {"raw": 426911, "display": "$426,911"}},
        {"label": "Net income", "value": {"raw": 46900, "display": "$46,900"}},
    ],
    "trade_area": {"basis": "city", "geography_name": "Longview city"},
    "location": {"lat": 32.5, "lng": -94.7, "formatted_address": "Longview, TX"},
}


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


def _make(store, *, slug, owner="ownerA", vm=None, name="P"):
    p = {
        "id": "01J" + slug,
        "view_slug": slug,
        "owner_token_hash": owner,
        "name": name,
        "model_version": MODEL_VERSION,
        "compute_schema_version": COMPUTE_SCHEMA_VERSION,
        "computed_json": json.dumps(vm if vm is not None else _VM),
        "created_at": _now(),
        "updated_at": _now(),
    }
    return store.create_projection(p)


def test_build_card_summary_extracts_card_fields():
    s = build_card_summary(_VM)
    assert s["reco_tag"] == "proceed"
    assert s["capital_required"]["display"] == "$277,990"
    assert s["y1_revenue"]["display"] == "$426,911"
    assert s["y1_net"]["display"] == "$46,900"
    assert s["location"] == "Longview city"
    assert s["basis"] == "city"
    assert s["coords"]["lat"] == 32.5


def test_build_card_summary_empty_vm_uses_safe_defaults():
    # A projection with no computed view-model must not crash the list; the card
    # falls back to neutral placeholders (never None money / a misleading 0 reco).
    s = build_card_summary({})
    assert s["location"] == ""
    assert s["basis"] == ""
    assert s["y1_revenue"] == {"raw": 0, "display": "—"}
    assert s["y1_net"] == {"raw": 0, "display": "—"}
    assert s["capital_required"] == {"raw": 0, "display": "—"}
    assert s["reco_tag"] == "revise"
    assert s["coords"] is None


def test_build_card_summary_falls_back_to_formatted_address():
    # When the trade area has no geography_name, the card location uses the resolved
    # location's formatted_address instead.
    vm = {"location": {"formatted_address": "Tyler, TX"}, "trade_area": {"basis": "county"}}
    s = build_card_summary(vm)
    assert s["location"] == "Tyler, TX"
    assert s["basis"] == "county"


def test_build_card_summary_missing_named_kpi_defaults():
    # A view-model whose kpis omit the named card KPI yields the placeholder money.
    vm = {"kpis": [{"label": "Sales / sq ft", "value": {"raw": 61, "display": "$61"}}]}
    assert build_card_summary(vm)["y1_revenue"] == {"raw": 0, "display": "—"}


def test_create_populates_summary_json_from_computed_json(store):
    _make(store, slug="aaa")
    row = store._conn.execute(
        "SELECT summary_json FROM projections WHERE view_slug='aaa'"
    ).fetchone()
    summary = json.loads(row["summary_json"])
    assert summary["reco_tag"] == "proceed"
    assert summary["capital_required"]["display"] == "$277,990"


def test_list_card_summaries_returns_card_fields_without_heavy_blobs(store):
    _make(store, slug="aaa", owner="ownerA")
    rows = store.list_card_summaries("ownerA")
    assert len(rows) == 1
    r = rows[0]
    # identity columns present
    assert r["view_slug"] == "aaa"
    assert r["version"] == 1
    # the heavy blobs are NOT selected (the whole point of #178)
    assert "computed_json" not in r
    assert "inputs_json" not in r
    # the compact summary is available
    summary = json.loads(r["summary_json"])
    assert summary["reco_tag"] == "proceed"


def test_list_card_summaries_is_owner_scoped(store):
    _make(store, slug="aaa", owner="ownerA")
    _make(store, slug="bbb", owner="ownerB")
    a = store.list_card_summaries("ownerA")
    assert [r["view_slug"] for r in a] == ["aaa"]


def test_list_card_summaries_excludes_trashed_by_default(store):
    _make(store, slug="aaa", owner="ownerA")
    store.set_status("01Jaaa", "trashed", 1)
    assert store.list_card_summaries("ownerA") == []
    assert len(store.list_card_summaries("ownerA", include_trashed=True)) == 1


def test_update_refreshes_summary_when_computed_json_changes(store):
    _make(store, slug="aaa", owner="ownerA")
    new_vm = dict(_VM, reco={"tag": "do_not_proceed"})
    store.update_with_version_check(
        "01Jaaa", 1, {"computed_json": json.dumps(new_vm)})
    row = store._conn.execute(
        "SELECT summary_json FROM projections WHERE view_slug='aaa'"
    ).fetchone()
    assert json.loads(row["summary_json"])["reco_tag"] == "do_not_proceed"


def test_create_without_computed_json_leaves_default_summary(store):
    # A row created without a computed_json (rare/legacy) keeps the column default
    # '{}' rather than crashing — the backfill/next save will populate it.
    p = {
        "id": "01Jnone", "view_slug": "none", "owner_token_hash": "ownerA",
        "name": "P", "model_version": MODEL_VERSION,
        "compute_schema_version": COMPUTE_SCHEMA_VERSION,
        "created_at": _now(), "updated_at": _now(),
    }
    store.create_projection(p)
    row = store._conn.execute(
        "SELECT summary_json FROM projections WHERE view_slug='none'"
    ).fetchone()
    assert row["summary_json"] == "{}"


def test_list_card_summaries_orders_by_updated_at_desc(store):
    for slug, ts in (("old", "2020-01-01T00:00:00Z"), ("new", "2099-01-01T00:00:00Z")):
        store.create_projection({
            "id": "01J" + slug, "view_slug": slug, "owner_token_hash": "ownerA",
            "name": "P", "model_version": MODEL_VERSION,
            "compute_schema_version": COMPUTE_SCHEMA_VERSION,
            "computed_json": json.dumps(_VM),
            "created_at": ts, "updated_at": ts,
        })
    rows = store.list_card_summaries("ownerA")
    assert [r["view_slug"] for r in rows] == ["new", "old"]  # most-recent first


def test_backfill_populates_summary_for_legacy_rows(tmp_path):
    # A row written before migration 0008 has summary_json='{}'. On the boot that
    # applies 0008, the backfill must populate it from computed_json so the owner
    # list is correct WITHOUT a re-save.
    db = tmp_path / "legacy.db"
    s1 = SqliteStore(str(db))
    s1.migrate()
    _make(s1, slug="legacy", owner="ownerA")
    # Simulate the pre-0008 state: blank the denormalized column + wipe the ledger
    # row for 0008 so the next boot re-runs its backfill.
    s1._conn.execute("UPDATE projections SET summary_json='{}'")
    s1._conn.execute("DELETE FROM schema_migrations WHERE name='0008_card_summary'")
    s1._conn.commit()

    s2 = SqliteStore(str(db))
    s2.migrate()  # re-applies 0008 -> backfill runs
    rows = s2.list_card_summaries("ownerA")
    assert json.loads(rows[0]["summary_json"])["reco_tag"] == "proceed"

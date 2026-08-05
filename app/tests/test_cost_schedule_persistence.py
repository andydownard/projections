"""W1 data-model spine — schedule/anchor persistence across the projection
lifecycle (#113): GET-verbatim reads, owner-list, the .xlsx export terms gate,
revision history + restore, and multi-edit accumulation. These confirm the new
fields survive every read/write path that touches a projection and that the
denormalized mirror columns stay consistent with the canonical ``inputs_json``.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.deps import hash_token
from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore
from engine.model import default_cost_schedule_v3


# --------------------------------------------------------------------- fixtures
@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


@pytest.fixture()
def client(store):
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


BASE_INPUTS = {
    "org_name": "House of Hope",
    "city": "Longview, Texas",
    "opening_status": "pre_launch",
    "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
    "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
    "source_of_funds": "300000", "occupancy_annual": "120000",
    "lease_type": "nnn", "nnn_opex_annual": "0",
}

SCHEDULE = [
    {"category": "Consultant", "month": 1, "amount": 100000},
    {"category": "Build-out", "month": 2, "amount": 50000},
]


def _body(**input_overrides):
    return {
        "name": "House of Hope",
        "inputs": {**BASE_INPUTS, **input_overrides},
        "trade_area": {"basis": "city", "households": "31798"},
        "assumptions": {"labor_pct": "0.60"},
    }


def _create(client, **input_overrides):
    r = client.post("/api/projections", json=_body(**input_overrides))
    assert r.status_code == 201, r.text
    return r.json()


def _headers(created, if_match):
    return {"Authorization": f"Bearer {created['owner_token']}", "If-Match": str(if_match)}


def _row(store, slug):
    return store.get_projection_by_slug(slug)


def _stored_inputs(store, slug):
    return json.loads(_row(store, slug)["inputs_json"])


def _accept_terms(store, slug):
    pid = _row(store, slug)["id"]
    store._conn.execute(
        "UPDATE projections SET terms_accepted_at = ? WHERE id = ?",
        ("2026-06-27T00:00:00Z", pid),
    )
    store._conn.commit()


# --------------------------------------------------------------- GET verbatim
def test_get_returns_stored_snapshot_with_schedule_intact(client, store):
    created = _create(client, cost_schedule=SCHEDULE, opening_month_number=2)
    slug = created["view_slug"]
    r = client.get(f"/api/projections/{slug}")
    assert r.status_code == 200
    # the schedule lives in inputs_json (engine-facing); the GET returns the stored
    # computed snapshot verbatim, and the row still carries the schedule.
    assert _stored_inputs(store, slug)["cost_schedule"] == SCHEDULE
    assert _row(store, slug)["opening_month_number"] == 2


def test_get_unknown_slug_404(client):
    r = client.get("/api/projections/does-not-exist")
    assert r.status_code == 404


# ----------------------------------------------------------------- owner list
def test_owner_list_includes_projection_with_schedule(client, store):
    created = _create(client, cost_schedule=SCHEDULE)
    r = client.get(
        "/api/projections",
        headers={"Authorization": f"Bearer {created['owner_token']}"},
    )
    assert r.status_code == 200
    slugs = [item["view_slug"] for item in r.json()["projections"]]
    assert created["view_slug"] in slugs


# ------------------------------------------------------------- .xlsx terms gate
def test_xlsx_requires_terms_even_with_schedule(client, store):
    created = _create(client, cost_schedule=SCHEDULE, opening_month_number=2)
    slug = created["view_slug"]
    r = client.get(f"/api/projections/{slug}/xlsx")
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "terms_required"


def test_xlsx_exports_after_terms_with_schedule(client, store):
    created = _create(client, cost_schedule=SCHEDULE, opening_month_number=2)
    slug = created["view_slug"]
    _accept_terms(store, slug)
    r = client.get(f"/api/projections/{slug}/xlsx")
    # the schedule/anchor are filtered before the engine, so export still succeeds
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )


def test_xlsx_exports_for_default_schedule_projection(client, store):
    created = _create(client)  # no schedule -> month-1 lump default downstream
    slug = created["view_slug"]
    _accept_terms(store, slug)
    r = client.get(f"/api/projections/{slug}/xlsx")
    assert r.status_code == 200, r.text


# ------------------------------------------------------ revisions + restore
def test_patch_writes_revision_carrying_schedule(client, store):
    created = _create(client)
    slug = created["view_slug"]
    client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": SCHEDULE, "opening_month_number": 2}},
        headers=_headers(created, 1),
    )
    pid = _row(store, slug)["id"]
    revs = store.list_revisions(pid)
    assert len(revs) == 1
    assert json.loads(revs[0]["inputs_json"])["cost_schedule"] == SCHEDULE


def test_restore_brings_back_schedule_into_inputs_and_columns(client, store):
    created = _create(client, cost_schedule=SCHEDULE, opening_month_number=2)
    slug, owner = created["view_slug"], created["owner_token"]
    # v1 -> v2: replace the schedule
    replacement = [{"category": "Signage", "month": 9, "amount": 13500}]
    client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": replacement, "opening_month_number": 9}},
        headers=_headers(created, 1),
    )
    assert _stored_inputs(store, slug)["cost_schedule"] == replacement
    # v2 -> v3: replace again so a snapshot of the v2 (replacement) state exists
    client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"opening_month_number": 5}},
        headers=_headers(created, 2),
    )
    revs = client.get(
        f"/api/projections/{slug}/revisions",
        headers={"Authorization": f"Bearer {owner}"},
    ).json()["revisions"]
    target = [rv for rv in revs if rv["version"] == 2][0]
    r = client.post(
        f"/api/projections/{slug}/revisions/{target['id']}/restore",
        headers=_headers(created, 3),
    )
    assert r.status_code == 200, r.text
    # the restored inputs_json carries the v2 schedule, and the mirror column agrees
    stored = _stored_inputs(store, slug)
    assert stored["cost_schedule"] == replacement
    assert stored["opening_month_number"] == 9
    assert json.loads(_row(store, slug)["cost_schedule_json"]) == replacement
    assert _row(store, slug)["opening_month_number"] == 9


# ------------------------------------------------------- multi-edit accumulation
def test_sequential_patches_accumulate_schedule_and_anchor(client, store):
    created = _create(client)
    slug = created["view_slug"]
    # set schedule
    client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": SCHEDULE}},
        headers=_headers(created, 1),
    )
    # then set anchor in a later edit; schedule must survive
    client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"opening_month_number": 6, "target_opening_date": "2026-12"}},
        headers=_headers(created, 2),
    )
    stored = _stored_inputs(store, slug)
    assert stored["cost_schedule"] == SCHEDULE
    assert stored["opening_month_number"] == 6
    assert stored["target_opening_date"] == "2026-12"
    row = _row(store, slug)
    assert json.loads(row["cost_schedule_json"]) == SCHEDULE
    assert row["opening_month_number"] == 6


def test_patch_can_clear_target_opening_date_to_null(client, store):
    created = _create(client, target_opening_date="2026-09")
    slug = created["view_slug"]
    client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"target_opening_date": None}},
        headers=_headers(created, 1),
    )
    assert _stored_inputs(store, slug)["target_opening_date"] is None
    assert _row(store, slug)["target_opening_date"] is None


# ----------------------------------------------------------- mirror consistency
def test_mirror_column_matches_inputs_after_create(client, store):
    created = _create(client, cost_schedule=SCHEDULE, opening_month_number=4)
    row = _row(store, created["view_slug"])
    stored = json.loads(row["inputs_json"])
    assert json.loads(row["cost_schedule_json"]) == stored["cost_schedule"]
    assert row["opening_month_number"] == stored["opening_month_number"]


def test_mirror_column_defaults_when_inputs_have_no_schedule(client, store):
    # Model v3 (Task 2.1b): a genuine create with no schedule seeds
    # default_cost_schedule_v3() into BOTH inputs_json and the mirror column (sized
    # to this projection's own stationsInstalled), so the two never disagree.
    created = _create(client, opening_month_number=3)
    row = _row(store, created["view_slug"])
    expected = default_cost_schedule_v3("10000", created["stationsInstalled"])
    assert json.loads(row["inputs_json"])["cost_schedule"] == expected
    assert json.loads(row["cost_schedule_json"]) == expected
    # the explicitly-set anchor is still mirrored
    assert row["opening_month_number"] == 3


def test_cross_owner_cannot_read_schedule_via_list(client, store):
    # owner A creates with a schedule; owner B's list never sees it (owner-scoped).
    created = _create(client, cost_schedule=SCHEDULE)
    other_owner = "someone-elses-token"
    r = client.get(
        "/api/projections",
        headers={"Authorization": f"Bearer {other_owner}"},
    )
    assert r.status_code == 200
    assert r.json()["projections"] == []
    # sanity: the row really is owned by A, not B
    row = _row(store, created["view_slug"])
    assert row["owner_token_hash"] != hash_token(other_owner)

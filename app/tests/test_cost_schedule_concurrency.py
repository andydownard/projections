"""W1 data-model spine — mutation-safety for schedule/anchor edits (#113).

Editing the timed cost schedule is a mutation like any other: it requires a Bearer
owner/edit token + ``If-Match`` and obeys optimistic concurrency (stale -> 409,
missing -> 428, view-only -> 403). These tests pin that the new fields ride the
same Mutation-Safety quad and never bypass it.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore

BASE_INPUTS = {
    "org_name": "House of Hope",
    "city": "Longview, Texas",
    "opening_status": "pre_launch",
    "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
    "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
    "source_of_funds": "300000", "occupancy_annual": "120000",
    "lease_type": "nnn", "nnn_opex_annual": "0",
}
SCHEDULE = [{"category": "Build-out", "month": 2, "amount": 50000}]


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


def _create(client):
    r = client.post(
        "/api/projections",
        json={
            "name": "House of Hope",
            "inputs": dict(BASE_INPUTS),
            "trade_area": {"basis": "city", "households": "31798"},
            "assumptions": {"labor_pct": "0.60"},
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def _stored(store, slug):
    return json.loads(store.get_projection_by_slug(slug)["inputs_json"])


def test_schedule_patch_requires_if_match(client):
    created = _create(client)
    r = client.patch(
        f"/api/projections/{created['view_slug']}",
        json={"inputs": {"cost_schedule": SCHEDULE}},
        headers={"Authorization": f"Bearer {created['owner_token']}"},
    )
    assert r.status_code == 428, r.text


def test_schedule_patch_stale_if_match_returns_409(client, store):
    created = _create(client)
    slug = created["view_slug"]
    # create seeds the Model-v3 default schedule (Task 2.1b); capture it so the
    # "never persisted" assertion below proves the stale write really no-oped,
    # rather than the projection having no schedule to begin with.
    before_schedule = _stored(store, slug)["cost_schedule"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": SCHEDULE}},
        headers={"Authorization": f"Bearer {created['owner_token']}", "If-Match": "99"},
    )
    assert r.status_code == 409, r.text
    # the stale write never persisted the schedule
    assert _stored(store, slug)["cost_schedule"] == before_schedule


def test_schedule_patch_view_only_forbidden(client, store):
    created = _create(client)
    slug = created["view_slug"]
    before_schedule = _stored(store, slug)["cost_schedule"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": SCHEDULE}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 403, r.text
    assert _stored(store, slug)["cost_schedule"] == before_schedule


def test_schedule_patch_wrong_token_forbidden(client, store):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": SCHEDULE}},
        headers={"Authorization": "Bearer not-the-token", "If-Match": "1"},
    )
    assert r.status_code == 403, r.text


def test_edit_token_can_patch_schedule(client, store):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": SCHEDULE, "opening_month_number": 3}},
        headers={"Authorization": f"Bearer {created['edit_token']}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    assert _stored(store, slug)["cost_schedule"] == SCHEDULE


def test_successful_schedule_patch_advances_if_match_chain(client, store):
    created = _create(client)
    slug = created["view_slug"]
    owner = created["owner_token"]
    r1 = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": SCHEDULE}},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
    )
    assert r1.json()["version"] == 2
    # the now-stale If-Match: 1 must be rejected on the next edit
    r_stale = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"opening_month_number": 4}},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
    )
    assert r_stale.status_code == 409
    # the correct If-Match: 2 succeeds
    r2 = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"opening_month_number": 4}},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "2"},
    )
    assert r2.status_code == 200
    assert r2.json()["version"] == 3
    assert store.get_projection_by_slug(slug)["opening_month_number"] == 4

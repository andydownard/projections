"""W1 data-model spine — schedule/anchor over the create/PATCH/preview API (#113).

Acceptance: ``InputsIn`` (create + patch) accepts the timed cost schedule + opening
anchor with server-side validation (``month >= 1``, ``amount >= 0``,
``opening_month_number >= 1``); rejects bad rows; create + PATCH round-trip the new
fields through ``inputs_json`` (engine-facing) and mirror them into the m0005
columns. The schedule/anchor must NOT break engine compute (they are filtered out
before constructing the engine ``Inputs`` dataclass until a later wave consumes
them) and /preview stays read-only.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

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


def _row(store, slug):
    return store.get_projection_by_slug(slug)


def _stored_inputs(store, slug):
    return json.loads(_row(store, slug)["inputs_json"])


SAMPLE_SCHEDULE = [
    {"category": "Consultant", "month": 1, "amount": 100000},
    {"category": "Build-out", "month": 2, "amount": 50000},
    {"category": "Equipment", "month": 3, "amount": 45000},
]


# ---------------------------------------------------------------- create paths
def test_create_persists_schedule_into_inputs_json(client, store):
    created = _create(client, cost_schedule=SAMPLE_SCHEDULE)
    assert _stored_inputs(store, created["view_slug"])["cost_schedule"] == SAMPLE_SCHEDULE


def test_create_persists_anchor_into_inputs_json(client, store):
    created = _create(
        client, target_opening_date="2026-09", opening_month_number=6
    )
    stored = _stored_inputs(store, created["view_slug"])
    assert stored["target_opening_date"] == "2026-09"
    assert stored["opening_month_number"] == 6


def test_create_mirrors_schedule_into_column(client, store):
    created = _create(client, cost_schedule=SAMPLE_SCHEDULE)
    row = _row(store, created["view_slug"])
    assert json.loads(row["cost_schedule_json"]) == SAMPLE_SCHEDULE


def test_create_mirrors_anchor_into_columns(client, store):
    created = _create(
        client, target_opening_date="2026-09", opening_month_number=6
    )
    row = _row(store, created["view_slug"])
    assert row["opening_month_number"] == 6
    assert row["target_opening_date"] == "2026-09"


def test_create_preserves_schedule_row_order(client, store):
    created = _create(client, cost_schedule=SAMPLE_SCHEDULE)
    stored = _stored_inputs(store, created["view_slug"])["cost_schedule"]
    assert [r["category"] for r in stored] == ["Consultant", "Build-out", "Equipment"]


def test_create_without_schedule_defaults_opening_month(client, store):
    created = _create(client)
    assert _row(store, created["view_slug"])["opening_month_number"] == 1


def test_create_without_schedule_backfills_v3_default_schedule_column(client, store):
    # Model v3 (Task 2.1b): a genuinely-new create backfills the NEW 8-line
    # default_cost_schedule_v3(), sized to this projection's own stationsInstalled
    # -- not the old 4-line default_cost_schedule() (still the fallback for
    # duplicate/PATCH/restore/Penny-edit on an EXISTING projection, unaffected here).
    created = _create(client)
    row = _row(store, created["view_slug"])
    expected = default_cost_schedule_v3(
        "10000", created["stationsInstalled"])  # BASE_INPUTS' building_sqft
    assert json.loads(row["cost_schedule_json"]) == expected


def test_create_without_schedule_seeds_v3_schedule_into_inputs_json(client, store):
    created = _create(client)
    stored = _stored_inputs(store, created["view_slug"])
    assert len(stored["cost_schedule"]) == 8
    assert stored["cost_schedule"][0]["category"] == "Thrift Store Consultant"
    assert stored["cost_schedule"][0]["treatment"] == "separate"


def test_create_still_computes_decision_metrics_with_schedule(client):
    created = _create(client, cost_schedule=SAMPLE_SCHEDULE, opening_month_number=2)
    # The schedule/anchor are filtered before the engine Inputs dataclass, so
    # compute succeeds and the view-model still carries its metrics.
    assert "metrics" in created
    assert created["metrics"].get("capital") is not None


def test_create_compute_unaffected_by_schedule_presence(client):
    # Same engine inputs, schedule present vs absent -> identical computed metrics
    # (the schedule does not feed the engine yet; it is filtered out).
    without = _create(client)
    with_sched = _create(client, cost_schedule=SAMPLE_SCHEDULE, opening_month_number=3)
    assert without["metrics"]["capital"]["raw"] == with_sched["metrics"]["capital"]["raw"]


def test_create_accepts_large_schedule(client, store):
    big = [
        {"category": f"Line {i}", "month": i + 1, "amount": 1000 * i}
        for i in range(24)
    ]
    created = _create(client, cost_schedule=big)
    assert _stored_inputs(store, created["view_slug"])["cost_schedule"] == big


def test_create_accepts_empty_schedule_list(client, store):
    # Empty list is valid input and -- same as no schedule at all, matching
    # _schedule_columns' own `if not schedule:` convention -- is Model-v3-seeded on
    # a genuine create (Task 2.1b): an empty array means "no timed costs defined",
    # not "opt out of the default".
    created = _create(client, cost_schedule=[])
    stored = _stored_inputs(store, created["view_slug"])["cost_schedule"]
    row = _row(store, created["view_slug"])
    mirrored = json.loads(row["cost_schedule_json"])
    assert stored == mirrored
    assert len(stored) == 8
    assert stored[0]["category"] == "Thrift Store Consultant"


def test_create_accepts_float_amount(client, store):
    created = _create(
        client, cost_schedule=[{"category": "X", "month": 1, "amount": 1234.56}]
    )
    stored = _stored_inputs(store, created["view_slug"])["cost_schedule"]
    assert stored[0]["amount"] == 1234.56


def test_create_accepts_numeric_string_amount_and_month(client, store):
    # Pydantic coerces numeric strings; the persisted values are numbers.
    created = _create(
        client, cost_schedule=[{"category": "X", "month": "2", "amount": "5000"}]
    )
    stored = _stored_inputs(store, created["view_slug"])["cost_schedule"]
    assert stored[0]["month"] == 2
    assert stored[0]["amount"] == 5000


# ------------------------------------------------------- create boundary values
def test_create_accepts_month_one_boundary(client):
    r = client.post(
        "/api/projections",
        json=_body(cost_schedule=[{"category": "X", "month": 1, "amount": 0}]),
    )
    assert r.status_code == 201, r.text


def test_create_accepts_zero_amount_boundary(client):
    r = client.post(
        "/api/projections",
        json=_body(cost_schedule=[{"category": "X", "month": 5, "amount": 0}]),
    )
    assert r.status_code == 201, r.text


def test_create_accepts_opening_month_one_boundary(client):
    r = client.post("/api/projections", json=_body(opening_month_number=1))
    assert r.status_code == 201, r.text


def test_create_accepts_late_opening_month(client, store):
    created = _create(client, opening_month_number=12)
    assert _row(store, created["view_slug"])["opening_month_number"] == 12


# ----------------------------------------------------------- create rejections
@pytest.mark.parametrize("month", [0, -1, -12])
def test_create_rejects_month_below_one(client, month):
    r = client.post(
        "/api/projections",
        json=_body(cost_schedule=[{"category": "X", "month": month, "amount": 10}]),
    )
    assert r.status_code == 422, r.text


@pytest.mark.parametrize("amount", [-1, -0.01, -50000])
def test_create_rejects_negative_amount(client, amount):
    r = client.post(
        "/api/projections",
        json=_body(cost_schedule=[{"category": "X", "month": 1, "amount": amount}]),
    )
    assert r.status_code == 422, r.text


@pytest.mark.parametrize("opening", [0, -1, -6])
def test_create_rejects_opening_month_below_one(client, opening):
    r = client.post("/api/projections", json=_body(opening_month_number=opening))
    assert r.status_code == 422, r.text


def test_create_rejects_unknown_schedule_field(client):
    # CostScheduleItemIn forbids extra keys (server is the validation authority).
    r = client.post(
        "/api/projections",
        json=_body(cost_schedule=[
            {"category": "X", "month": 1, "amount": 10, "bogus": True}
        ]),
    )
    assert r.status_code == 422, r.text


def test_create_rejects_missing_category(client):
    r = client.post(
        "/api/projections",
        json=_body(cost_schedule=[{"month": 1, "amount": 10}]),
    )
    assert r.status_code == 422, r.text


# ------------------------------------------------------------- PATCH round-trip
def _owner_headers(created, if_match):
    return {"If-Match": str(if_match)}


def test_patch_sets_schedule_into_inputs_json(client, store):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": SAMPLE_SCHEDULE}},
        headers=_owner_headers(created, 1),
    )
    assert r.status_code == 200, r.text
    assert _stored_inputs(store, slug)["cost_schedule"] == SAMPLE_SCHEDULE


def test_patch_mirrors_schedule_into_column(client, store):
    created = _create(client)
    slug = created["view_slug"]
    client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": SAMPLE_SCHEDULE}},
        headers=_owner_headers(created, 1),
    )
    assert json.loads(_row(store, slug)["cost_schedule_json"]) == SAMPLE_SCHEDULE


def test_patch_sets_anchor(client, store):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"opening_month_number": 4, "target_opening_date": "2027-01"}},
        headers=_owner_headers(created, 1),
    )
    assert r.status_code == 200, r.text
    stored = _stored_inputs(store, slug)
    assert stored["opening_month_number"] == 4
    assert stored["target_opening_date"] == "2027-01"
    row = _row(store, slug)
    assert row["opening_month_number"] == 4
    assert row["target_opening_date"] == "2027-01"


def test_patch_anchor_only_keeps_existing_engine_inputs(client, store):
    created = _create(client, cost_schedule=SAMPLE_SCHEDULE)
    slug = created["view_slug"]
    client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"opening_month_number": 7}},
        headers=_owner_headers(created, 1),
    )
    stored = _stored_inputs(store, slug)
    # the previously-saved schedule survives an anchor-only patch (merge semantics)
    assert stored["cost_schedule"] == SAMPLE_SCHEDULE
    assert stored["opening_month_number"] == 7


def test_patch_replaces_schedule(client, store):
    created = _create(client, cost_schedule=SAMPLE_SCHEDULE)
    slug = created["view_slug"]
    replacement = [{"category": "Signage", "month": 6, "amount": 13500}]
    client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": replacement}},
        headers=_owner_headers(created, 1),
    )
    assert _stored_inputs(store, slug)["cost_schedule"] == replacement


def test_patch_bumps_version_with_schedule(client):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": SAMPLE_SCHEDULE}},
        headers=_owner_headers(created, 1),
    )
    assert r.json()["version"] == 2


# --------------------------------------------------------------- PATCH rejects
@pytest.mark.parametrize(
    "bad_inputs",
    [
        {"cost_schedule": [{"category": "X", "month": 0, "amount": 1}]},
        {"cost_schedule": [{"category": "X", "month": -3, "amount": 1}]},
        {"cost_schedule": [{"category": "X", "month": 1, "amount": -1}]},
        {"opening_month_number": 0},
        {"opening_month_number": -2},
    ],
)
def test_patch_rejects_bad_schedule(client, bad_inputs):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": bad_inputs},
        headers=_owner_headers(created, 1),
    )
    assert r.status_code == 422, r.text


def test_patch_rejection_does_not_bump_version(client, store):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"opening_month_number": 0}},
        headers=_owner_headers(created, 1),
    )
    assert r.status_code == 422
    # the failed mutation must not have persisted / bumped the version
    assert _row(store, slug)["version"] == 1


def test_patch_rejection_leaves_schedule_unchanged(client, store):
    created = _create(client, cost_schedule=SAMPLE_SCHEDULE)
    slug = created["view_slug"]
    client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": [{"category": "X", "month": 0, "amount": 1}]}},
        headers=_owner_headers(created, 1),
    )
    assert _stored_inputs(store, slug)["cost_schedule"] == SAMPLE_SCHEDULE


# ------------------------------------------ PATCH row-count cap (#166, DoS guard)
def _cap_rows(n):
    return [{"category": f"L{i}", "month": (i % 12) + 1, "amount": 100}
            for i in range(n)]


def test_patch_accepts_schedule_at_row_cap(client, store):
    from app.routers.projections import MAX_COST_SCHEDULE_ROWS

    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": _cap_rows(MAX_COST_SCHEDULE_ROWS)}},
        headers=_owner_headers(created, 1),
    )
    assert r.status_code == 200, r.text
    assert len(_stored_inputs(store, slug)["cost_schedule"]) == MAX_COST_SCHEDULE_ROWS


def test_patch_rejects_schedule_over_row_cap(client, store):
    from app.routers.projections import MAX_COST_SCHEDULE_ROWS

    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"cost_schedule": _cap_rows(MAX_COST_SCHEDULE_ROWS + 1)}},
        headers=_owner_headers(created, 1),
    )
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "invalid_inputs"
    # rejected over-cap mutation must not persist / bump the version
    assert _row(store, slug)["version"] == 1


# --------------------------------------------------------------------- preview
def test_preview_with_schedule_is_read_only(client, store):
    created = _create(client)
    slug = created["view_slug"]
    # create seeds the v3 default (Task 2.1b); capture it before the preview so the
    # "nothing persisted" assertion below proves the /preview write truly no-oped,
    # not that the projection happened to have no schedule to begin with.
    before_schedule = _stored_inputs(store, slug)["cost_schedule"]
    r = client.post(
        f"/api/projections/{slug}/preview",
        json={"inputs": {"cost_schedule": SAMPLE_SCHEDULE, "opening_month_number": 3}},
            )
    assert r.status_code == 200, r.text
    # nothing persisted: version unchanged and the schedule not written
    row = _row(store, slug)
    assert row["version"] == 1
    assert _stored_inputs(store, slug)["cost_schedule"] == before_schedule


def test_preview_computes_after_view_model(client):
    created = _create(client)
    slug = created["view_slug"]
    r = client.post(
        f"/api/projections/{slug}/preview",
        json={"inputs": {"cost_schedule": SAMPLE_SCHEDULE}},
            )
    body = r.json()
    assert "after" in body
    assert "before" in body

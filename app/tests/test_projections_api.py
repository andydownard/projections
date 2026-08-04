"""M2 API — create / read / owner-list slice (API_SPEC §4.1–4.3).

The server computes via the pure engine and persists the native view-model; reads
return that snapshot verbatim; lists are owner-scoped by the bearer owner token.
RED-first: these were written before app/routers/projections.py.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore
from engine.model import MODEL_VERSION


@pytest.fixture()
def client():
    store = SqliteStore(":memory:")
    store.migrate()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


@pytest.fixture()
def client_store():
    """A client paired with its store, so a test can plant a raw stored row."""
    store = SqliteStore(":memory:")
    store.migrate()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app), store


def _plant_snapshot(store, *, model_version, sentinel):
    """Insert a projection whose computed_json was produced under ``model_version``.

    Returns ``(stored_vm, view_slug)``. The stored view-model carries a unique
    ``_sentinel`` so a read can prove the bytes survived unchanged (no recompute).
    """
    stored_vm = {
        "model_version": model_version,
        "compute_schema_version": "1.0.0-old",
        "reco": {"tag": "proceed", "headline": "Proceed.", "sub": "stored verbatim"},
        "metrics": {"capital": {"raw": 12345, "display": "$12,345"},
                    "cashGap": {"raw": -999, "display": "($999)"}},
        "kpis": [], "rows": [], "monthly": [],
        "flags": {"model_upgrade_available": False},
        "_sentinel": sentinel,
    }
    row = {
        "id": f"id-{sentinel}",
        "view_slug": f"slug-{sentinel}",
        "owner_token_hash": "ownerhash",
        "name": "Planted Snapshot",
        "model_version": model_version,
        "compute_schema_version": "1.0.0-old",
        "computed_json": json.dumps(stored_vm),
        "created_at": "2020-01-01T00:00:00Z",
        "updated_at": "2020-01-01T00:00:00Z",
    }
    store.create_projection(row)
    return stored_vm, row["view_slug"]


VALID_BODY = {
    "name": "House of Hope",
    "inputs": {
        "org_name": "House of Hope",
        "city": "Longview, Texas",
        "opening_status": "pre_launch",
        "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
        "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
        "source_of_funds": "300000", "occupancy_annual": "120000",
        "lease_type": "nnn", "nnn_opex_annual": "0",
    },
    "trade_area": {"basis": "city", "households": "31798"},
    "assumptions": {"labor_pct": "0.60"},
}


def _create(client, body=None):
    return client.post("/api/projections", json=body or VALID_BODY)


def test_create_returns_view_model_version_and_one_time_tokens(client):
    r = _create(client)
    assert r.status_code == 201, r.text
    vm = r.json()
    for key in ("reco", "metrics", "kpis", "rows", "monthly", "settings",
                "model_version", "view_slug", "version"):
        assert key in vm, key
    assert vm["version"] == 1
    assert vm["reco"]["tag"] in {
        "proceed", "revise", "find_cheaper_rent", "raise_cash", "delay", "do_not_proceed"}
    assert vm["owner_token"] and vm["edit_token"]
    # canonical 60% labor reflected in settings
    assert abs(vm["settings"]["laborPct"] - 0.60) < 1e-9


def test_get_by_slug_returns_stored_snapshot_with_etag(client):
    created = _create(client).json()
    slug = created["view_slug"]
    r = client.get(f"/api/projections/{slug}")
    assert r.status_code == 200, r.text
    assert r.headers.get("ETag") == "1"
    got = r.json()
    assert got["view_slug"] == slug
    assert got["version"] == 1
    assert got["reco"]["tag"] == created["reco"]["tag"]  # verbatim, no recompute


def test_get_unknown_slug_404(client):
    assert client.get("/api/projections/does-not-exist").status_code == 404


def test_read_returns_older_snapshot_verbatim_and_surfaces_new_model(client_store):
    # #200 / Regression Registry #12 (Hard Rule): a projection stored under an OLDER
    # model_version is returned byte-for-byte on read — NEVER silently recomputed on
    # the current engine — and the staleness is surfaced as a read-time signal.
    client, store = client_store
    stored_vm, slug = _plant_snapshot(store, model_version="0.0.1-old", sentinel="old")
    r = client.get(f"/api/projections/{slug}")
    assert r.status_code == 200, r.text
    got = r.json()
    # (1) every stored key/value survives verbatim — no recompute mutated the snapshot.
    for k, v in stored_vm.items():
        assert got[k] == v, f"read recomputed/mutated stored {k!r}"
    # (2) the OLDER model_version is preserved, not overwritten with the live engine.
    assert got["model_version"] == "0.0.1-old"
    assert got["model_version"] != MODEL_VERSION
    # (3) staleness is surfaced (the engine has moved on since this snapshot).
    assert got["upgrade_available"] is True


def test_legacy_three_year_snapshot_reads_verbatim_then_auto_extends_on_recompute():
    # 5-year horizon (#redesign-v2). A projection saved under the 3-year engine (2.5.0)
    # has no share_y4/share_y5 in its stored inputs. Two invariants:
    #   (1) reading the stored snapshot is VERBATIM — still 2.5.0, still 3 columns, no
    #       silent recompute onto the live 2.6.0 engine (Regression Registry #12).
    #   (2) an explicit recompute (the upgrade-model path / a PATCH / an .xlsx export)
    #       AUTO-EXTENDS the missing late-year shares to the decelerating-plateau
    #       defaults (0.11 / 0.12) and yields a 5-year 2.6.0 view-model — non-destructive
    #       (the prior 2.5.0 bytes are preserved; upgrade-model writes a NEW revision).
    from app.routers.projections import _compute_view_model_from_dicts

    legacy_inputs = {
        "org_name": "House of Hope", "city": "Longview, Texas",
        "opening_status": "pre_launch",
        "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",  # NO y4/y5
        "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
        "source_of_funds": "300000", "occupancy_annual": "120000", "lease_type": "nnn",
    }
    # (1) verbatim read: a planted 2.5.0 snapshot whose rows have only y1..y3 cells is
    # returned unchanged (no y4/y5 grafted on, model_version not bumped).
    store = SqliteStore(":memory:")
    store.migrate()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    client = TestClient(app)
    legacy_vm = {
        "model_version": "2.5.0", "compute_schema_version": "1.3.0",
        "reco": {"tag": "revise"},
        "rows": [{"label": "Net profit", "group": "expenses",
                  "y1": {"raw": 1, "display": "$1"}, "y2": {"raw": 2, "display": "$2"},
                  "y3": {"raw": 3, "display": "$3"}}],
        "kpis": [], "monthly": [], "flags": {},
    }
    store.create_projection({
        "id": "id-legacy3y", "view_slug": "slug-legacy3y",
        "owner_token_hash": "ownerhash", "name": "Legacy 3-year",
        "model_version": "2.5.0", "compute_schema_version": "1.3.0",
        "computed_json": json.dumps(legacy_vm),
        "created_at": "2020-01-01T00:00:00Z", "updated_at": "2020-01-01T00:00:00Z",
    })
    got = client.get("/api/projections/slug-legacy3y").json()
    assert got["model_version"] == "2.5.0"          # not silently recomputed
    assert got["upgrade_available"] is True          # staleness surfaced
    assert "y4" not in got["rows"][0] and "y5" not in got["rows"][0]  # 3 columns verbatim
    assert got["rows"][0]["label"] == "Net profit"   # the old label is preserved as stored

    # (2) recompute auto-extends the legacy 3-year inputs to a 2.7.0 5-year view-model.
    vm = _compute_view_model_from_dicts(
        legacy_inputs, {"labor_pct": "0.60"}, {},
        {"basis": "city", "households": "31798"}, {})
    assert vm["model_version"] == MODEL_VERSION and MODEL_VERSION == "3.0.0"
    assert vm["compute_schema_version"] == "1.8.0"
    # plateau defaults filled the gap left by the pre-5-year save.
    assert abs(vm["settings"]["shareY4"] - 0.11) < 1e-9
    assert abs(vm["settings"]["shareY5"] - 0.12) < 1e-9
    # every annual row now carries five columns + the renamed total.
    assert all("y5" in r for r in vm["rows"])
    assert any(r["label"] == "Net income" for r in vm["rows"])
    assert len(vm["incomeSeries"]) == 5


def test_read_does_not_flag_upgrade_when_snapshot_is_current(client_store):
    # The flag must be a TRUE comparison against the live engine, not always-on: a
    # snapshot already at the current model_version is not stale.
    client, store = client_store
    _stored_vm, slug = _plant_snapshot(store, model_version=MODEL_VERSION, sentinel="cur")
    got = client.get(f"/api/projections/{slug}").json()
    assert got["model_version"] == MODEL_VERSION
    assert got["upgrade_available"] is False


def test_list_is_owner_scoped(client):
    created = _create(client).json()
    owner = created["owner_token"]
    # the owner sees exactly their projection
    r = client.get("/api/projections", headers={"Authorization": f"Bearer {owner}"})
    assert r.status_code == 200
    items = r.json()["projections"]
    assert len(items) == 1 and items[0]["view_slug"] == created["view_slug"]
    # a different owner sees nothing (no global index)
    other = client.get("/api/projections", headers={"Authorization": "Bearer someone-else"})
    assert other.json()["projections"] == []
    # no token -> empty
    assert client.get("/api/projections").json()["projections"] == []


def test_second_create_with_same_owner_token_joins_workspace(client):
    first = _create(client).json()
    owner = first["owner_token"]
    second = client.post(
        "/api/projections", json=VALID_BODY,
        headers={"Authorization": f"Bearer {owner}"},
    ).json()
    # joining an existing workspace does not mint a new owner token
    assert "owner_token" not in second
    listing = client.get(
        "/api/projections", headers={"Authorization": f"Bearer {owner}"}
    ).json()["projections"]
    assert len(listing) == 2


def test_invalid_inputs_return_422(client):
    bad = {**VALID_BODY, "inputs": {**VALID_BODY["inputs"]}}
    bad["inputs"].pop("occupancy_annual")  # no occupancy AND no rent_per_sqft -> engine raises
    r = _create(client, bad)
    assert r.status_code == 422, r.text

# PATCH / autosave / If-Match / 409 are covered comprehensively in
# test_projections_patch.py (the canonical mutation-quad contract).


# ------------------------------------------------ Model v3 Phase 2 (Task 2.1b):
# a genuinely-new create is seeded with default_cost_schedule_v3(); every OTHER
# path (duplicate/PATCH/restore/Penny-edit) stays on the untouched legacy
# default_cost_schedule() so an existing projection's numbers never silently move.
from app.deps import hash_token  # noqa: E402
from engine.model import PRODUCTION_STATION_COST, default_cost_schedule  # noqa: E402

_V3_INCLUDED_CATEGORIES = {
    "Equipment & Fixtures",
    "Build-out / Renovations / Tenant Improvements",
    "Legal, Permits, Insurance Setup, Signage",
    "POS checkout lanes",
    "Production stations",
    "Pre-opening hiring & training payroll",
    "Utilities/security deposits & setup",
}


def test_create_without_schedule_seeds_v3_default_cost_schedule(client_store):
    """POST /projections with NO cost_schedule -> the STORED schedule (the canonical
    copy in inputs_json, mirrored into the cost_schedule_json column) is the new
    8-line Model-v3 default, sized to this projection's OWN peak staffing, with the
    Consultant line marked "separate" -- not the old 4-line legacy default."""
    client, store = client_store
    created = _create(client).json()
    stations_installed = created["stationsInstalled"]
    assert stations_installed > 0  # House of Hope has real revenue -> real staffing

    row = store.get_projection_by_slug(created["view_slug"])
    stored_inputs = json.loads(row["inputs_json"])
    schedule = stored_inputs["cost_schedule"]
    mirrored = json.loads(row["cost_schedule_json"])
    assert schedule == mirrored  # denormalized column agrees with the canonical copy

    assert len(schedule) == 8
    by_category = {item["category"]: item for item in schedule}
    assert set(by_category) == _V3_INCLUDED_CATEGORIES | {"Thrift Store Consultant"}

    consultant = by_category["Thrift Store Consultant"]
    assert consultant["treatment"] == "separate"
    assert consultant["note"] == (
        "Handled under a separate consulting agreement — attach the signed "
        "proposal for the actual figure once available."
    )
    for category in _V3_INCLUDED_CATEGORIES:
        assert by_category[category]["treatment"] == "included"

    # "Production stations" is sized off THIS projection's real stationsInstalled,
    # not a fixed default count.
    assert by_category["Production stations"]["amount"] == (
        PRODUCTION_STATION_COST * stations_installed)


def test_new_v3_seeded_projection_survives_an_unrelated_patch(client_store):
    """Regression guard: a brand-new (v3-seeded) projection's OWN stored schedule
    must re-validate cleanly on the very next autosave. apply_projection_patch calls
    _validate_schedule_inputs() on every PATCH (even one that never touches
    cost_schedule), so a schedule row carrying "treatment"/"note" must round-trip
    through CostScheduleItemIn without 422ing on its own seed data."""
    client, store = client_store
    created = _create(client).json()
    slug, owner = created["view_slug"], created["owner_token"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.55"}},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    # the schedule is untouched by the unrelated patch
    stored = json.loads(store.get_projection_by_slug(slug)["inputs_json"])
    assert len(stored["cost_schedule"]) == 8


def _plant_legacy_projection(store, *, slug, edit_token):
    """Simulate a projection created BEFORE Task 2.1b shipped: a full valid
    ``inputs_json`` with NO ``cost_schedule`` key at all (exactly what every
    pre-existing row looks like -- the v3 seed only ever writes into a NEW create)."""
    now = "2020-01-01T00:00:00Z"
    inputs = {**VALID_BODY["inputs"]}
    assert "cost_schedule" not in inputs
    row = {
        "id": f"id-{slug}",
        "view_slug": slug,
        "owner_token_hash": hash_token("legacy-owner-token"),
        "edit_token_hash": hash_token(edit_token),
        "name": "Legacy Projection",
        "model_version": MODEL_VERSION,
        "compute_schema_version": "1.8.0",
        "inputs_json": json.dumps(inputs),
        "assumptions_json": json.dumps({"labor_pct": "0.60"}),
        "trade_area_json": json.dumps(VALID_BODY["trade_area"]),
        "computed_json": json.dumps({}),
        "created_at": now,
        "updated_at": now,
    }
    store.create_projection(row)
    return row


def test_patch_on_pre_existing_projection_does_not_gain_v3_schedule_lines(client_store):
    """A projection created BEFORE this change (no cost_schedule in its stored
    inputs_json) that gets PATCHed on an unrelated field must NOT gain any new
    cost-schedule lines -- apply_projection_patch/_schedule_columns are untouched
    by Task 2.1b, so it still falls back to the OLD 4-line default_cost_schedule(),
    never default_cost_schedule_v3()."""
    client, store = client_store
    edit_token = "legacy-edit-token"
    _plant_legacy_projection(store, slug="legacy-slug-1", edit_token=edit_token)

    r = client.patch(
        "/api/projections/legacy-slug-1",
        json={"assumptions": {"labor_pct": "0.62"}},
        headers={"Authorization": f"Bearer {edit_token}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text

    row = store.get_projection_by_slug("legacy-slug-1")
    stored_inputs = json.loads(row["inputs_json"])
    mirrored_schedule = json.loads(row["cost_schedule_json"])
    assert mirrored_schedule == default_cost_schedule()
    assert len(mirrored_schedule) == 4  # still the legacy row count, not 8
    categories = {item["category"] for item in mirrored_schedule}
    assert "POS checkout lanes" not in categories
    assert "Production stations" not in categories
    # legacy rows carry no "treatment" key at all (byte-identical to pre-v3)
    assert all("treatment" not in item for item in mirrored_schedule)
    # the unrelated PATCH did land (proves the schedule check above isn't vacuous)
    assert stored_inputs.get("cost_schedule") is None
    assert row["version"] == 2

"""M2 API — PATCH/autosave/concurrency slice (API_SPEC §1.3, §1.4, §4.4).

This project has no authentication (owner decision, 2026-09-13): every mutation
requires only If-Match. The server recomputes on the merged inputs/assumptions/
overrides, bumps version, and writes one revision snapshot per settle. Stale
If-Match -> 409 with current state; missing -> 428. RED-first: written before the
PATCH endpoint exists.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


@pytest.fixture()
def client(store):
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    # raise_server_exceptions=False (repo convention, test_projections_atomic_revision.py):
    # the F1 non-finite-bricking probes below assert on an actual 500 *response*
    # (Starlette's ServerErrorMiddleware re-raises by default), not a raised exception.
    return TestClient(app, raise_server_exceptions=False)


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


def _create(client):
    r = client.post("/api/projections", json=VALID_BODY)
    assert r.status_code == 201, r.text
    return r.json()


def _pid(store, slug):
    return store.get_projection_by_slug(slug)["id"]


def test_patch_autosave_bumps_version_and_recomputes(client, store):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.45"}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    vm = r.json()
    assert vm["version"] == 2
    assert r.headers.get("ETag") == "2"
    assert abs(vm["settings"]["laborPct"] - 0.45) < 1e-9
    # one revision snapshot written per settle
    assert len(store.list_revisions(_pid(store, slug))) == 1


def test_patch_stale_if_match_returns_409_with_current_state(client):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.45"}},
        headers={"If-Match": "99"},
    )
    assert r.status_code == 409, r.text
    body = r.json()["detail"] if "detail" in r.json() else r.json()
    assert body["error"] == "version_conflict"
    assert body["current_version"] == 1
    assert body["your_version"] == 99
    assert "reco" in body["current_state"]
    assert body["current_state"]["version"] == 1
    assert "reload" in body["recovery"]


def test_patch_missing_if_match_returns_428(client):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.45"}},
    )
    assert r.status_code == 428, r.text
    body = r.json().get("detail", r.json())
    assert body["error"] == "if_match_required"


def test_patch_unknown_slug_404(client):
    r = client.patch(
        "/api/projections/does-not-exist",
        json={"name": "x"},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 404, r.text


def test_patch_labor_pct_nan_string_is_422_not_500(client):
    # Decimal("nan") PARSES fine, but any bounds comparison (< lo / > hi) raises
    # InvalidOperation — which is NOT a ValueError, so pydantic used to let it 500.
    # A NaN knob must be rejected at the boundary like any other bad value (422).
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "nan"}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 422, r.text


def test_patch_labor_pct_nan_json_float_is_422_not_500(client):
    # The deployed numeric wire shape can carry a bare JSON `NaN` token (Python's
    # json.loads accepts it), which coerces to the string "nan" before the bounds
    # check. Same fail-closed 422 as the string form — never a 500.
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        content='{"assumptions": {"labor_pct": NaN}}',
        headers={"If-Match": "1", "Content-Type": "application/json"},
    )
    assert r.status_code == 422, r.text


# ------------------------------------------------------- F1: ±Infinity bricking
# `_require_min` (basket, utilities_per_sqft) only checked `is_nan()`; Decimal("inf")
# PARSES and COMPARES cleanly (`inf >= 0` is True), so it sailed past the lower-bound
# check straight into the engine and the stored `computed_json` — 500 on this request
# (Starlette's JSONResponse renders with allow_nan=False) AND every subsequent GET /
# revision-restore of the row (the value is already persisted). Proven live before the
# fix: PATCH basket:"inf" -> 500, then GET the same slug -> 500 (permanently bricked;
# the recovery surface itself 500s). The fix is one predicate: `is_finite()` covers
# NaN AND ±Infinity in both `_require_fraction` and `_require_min`.
def test_patch_basket_inf_string_is_422_not_500(client):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"basket": "inf"}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 422, r.text


def test_patch_basket_negative_inf_string_is_422_not_500(client):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"basket": "-inf"}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 422, r.text


def test_patch_basket_infinity_word_string_is_422_not_500(client):
    # Decimal accepts the spelled-out "Infinity" token too (case-insensitively) —
    # same non-finite value, a different wire spelling.
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"basket": "Infinity"}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 422, r.text


def test_patch_basket_inf_json_float_is_422_not_500(client):
    # The bare JSON `Infinity` token (json.loads accepts it) coerces to the string
    # "inf" before the bounds check, same as the NaN-float sibling test above.
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        content='{"assumptions": {"basket": Infinity}}',
        headers={"If-Match": "1", "Content-Type": "application/json"},
    )
    assert r.status_code == 422, r.text


def test_patch_utilities_per_sqft_inf_string_is_422_not_500(client):
    # utilities_per_sqft is the other `_require_min` (lower-bound-only) knob.
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"utilities_per_sqft": "inf"}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 422, r.text


def test_patch_labor_pct_inf_string_is_422_not_500(client):
    # `_require_fraction` (the [0,1] bounded knobs) happens to reject +Infinity via
    # its upper-bound check even before this fix (inf > hi), but the explicit
    # `is_finite()` guard now rejects it directly too — pin the behavior either way.
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "inf"}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 422, r.text


def test_patch_basket_inf_rejected_row_still_readable_after(client):
    # The proven damage: before the fix, the 500 above was not just a bad response —
    # the non-finite value had ALREADY persisted, so every subsequent GET of the same
    # row 500'd too (permanently bricked, no recovery). With the fix the bad PATCH is
    # rejected at the boundary (422) BEFORE any write, so the row is untouched and a
    # plain GET afterward is a clean 200 with the original (pre-PATCH) state.
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"basket": "inf"}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 422, r.text
    g = client.get(f"/api/projections/{slug}")
    assert g.status_code == 200, g.text
    assert g.json()["version"] == 1, "the rejected PATCH must not have bumped version"


# --------------------------------------------------- F1 class-kill: persist-path guard
# Even with every known field-level validator closed, `json.dumps(..., allow_nan=False)`
# at each persist site is the fail-closed backstop: a non-finite value that slips PAST
# validation by some future bypass must raise (failing the *request*, never silently
# writing a bricked row) rather than the stdlib default `allow_nan=True` quietly
# encoding `Infinity`/`NaN` into the stored JSON column. `CostScheduleItemIn.amount`
# (review F2) is exactly such a bypass today: it is typed `float = Field(ge=0)`, and
# `inf >= 0` is True, so a schedule row with `amount: Infinity` sails past
# `_validate_schedule_inputs` untouched (a different model than the assumptions knobs
# F1 fixes). Proves the persist-path guard, not the field-level one, catches this class.
def test_patch_cost_schedule_amount_inf_cannot_persist(client, store):
    created = _create(client)
    slug = created["view_slug"]
    r = client.patch(
        f"/api/projections/{slug}",
        content=(
            '{"inputs": {"cost_schedule": '
            '[{"category": "Equipment & Fixtures", "month": 1, "amount": Infinity}]}}'
        ),
        headers={"If-Match": "1", "Content-Type": "application/json"},
    )
    # Fail-closed: never a 200 that silently stored a non-JSON-standard Infinity.
    assert r.status_code != 200, r.text
    # And critically: the row was NOT mutated (version unchanged) — the persist-path
    # guard raises before the store's version-checked UPDATE is ever issued.
    assert store.get_projection_by_slug(slug)["version"] == 1

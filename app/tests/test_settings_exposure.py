"""Task 1.3 — expose reserve_buffer / fixed_annual / sensitivity_delta via the API,
and re-validate the MERGED PATCH assumptions/inputs with bounds.

Each newly exposed knob's DEFAULT reproduces today's output byte-for-byte (the anchor
invariant; goldens regen only for the added settings keys, never changed numbers).
These assert the knob is (a) settable at create + PATCH, (b) echoed in the view-model
settings block, (c) moves the decision math by exactly the documented amount, and
(d) bounds-rejected with 422 at the API boundary — BEFORE the engine, never a 500.

A raw-dict PATCH bypasses the create-time Pydantic body validation (`dict.update`
is blind to bounds), so `_merge_patch` re-validates the merged surface through the
same `AssumptionsIn`/`InputsIn` models. Engine-only keys that are NOT model fields
(e.g. `assumptions.startup`) are FILTERED out of the check — never rejected — and
still flow to the engine.
"""
import json

import pytest

from app.tests.conftest import create_projection


def _hdr(token, version):
    return {"Authorization": f"Bearer {token}", "If-Match": str(version)}


def _row_y1_raw(vm, label):
    row = next(r for r in vm["rows"] if r["label"] == label)
    return row["y1"]["raw"]


# ---- (a) reserve_buffer moves capital by exactly its delta ---------------------
def test_patch_reserve_buffer_shifts_capital_by_delta(client):
    slug, owner, version, body = create_projection(client)
    before = body["metrics"]["capital"]["raw"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"reserve_buffer": 40000}},
        headers=_hdr(owner, version),
    )
    assert r.status_code == 200, r.text
    vm = r.json()
    assert vm["settings"]["reserveBuffer"] == 40000
    # capital = |peak cash shortfall| + reserve_buffer (decision.py); only the buffer
    # term moves, 25000 -> 40000, so capital rises by exactly +15000.
    assert vm["metrics"]["capital"]["raw"] == pytest.approx(before + 15000)


# ---- (b) a PARTIAL fixed_annual MERGES over defaults; only the named line moves --
def test_patch_fixed_annual_merges_and_shifts_expenses(client):
    slug, owner, version, body = create_projection(client)
    before_exp = _row_y1_raw(body, "Total Expenses")
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"fixed_annual": {"Pest control": 600}}},
        headers=_hdr(owner, version),
    )
    assert r.status_code == 200, r.text
    vm = r.json()
    fa = vm["settings"]["fixedAnnual"]
    assert fa["Pest control"] == 600            # the edited line
    assert fa["Insurance liability"] == 2000    # the other defaults SURVIVE the merge
    # Pest control 300 -> 600 with revenue unchanged -> Y1 total expenses +300 exactly.
    assert _row_y1_raw(vm, "Total Expenses") == pytest.approx(before_exp + 300)


# ---- review 1.3f (f2): SEQUENTIAL single-line PATCHes must ACCUMULATE, not replace.
# _merge_patch's dict.update REPLACED the whole stored fixed_annual map on every
# PATCH, so PATCH#2's single line silently reverted PATCH#1's line back to its
# engine default. The fix deep-merges fixed_annual: incoming keys layer over the
# STORED map (which itself may already carry prior accumulated edits).
def test_patch_fixed_annual_accumulates_across_sequential_patches(client):
    slug, owner, version, body = create_projection(client)
    before_exp = _row_y1_raw(body, "Total Expenses")

    r1 = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"fixed_annual": {"Pest control": 600}}},
        headers=_hdr(owner, version),
    )
    assert r1.status_code == 200, r1.text
    vm1 = r1.json()
    assert vm1["settings"]["fixedAnnual"]["Pest control"] == 600

    r2 = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"fixed_annual": {"Insurance liability": 3000}}},
        headers=_hdr(owner, vm1["version"]),
    )
    assert r2.status_code == 200, r2.text
    vm2 = r2.json()
    fa = vm2["settings"]["fixedAnnual"]
    # PATCH#1's line must SURVIVE PATCH#2 (accumulate), not silently revert to 300.
    assert fa["Pest control"] == 600
    assert fa["Insurance liability"] == 3000
    # Pest control 300->600 (+300) and Insurance liability 2000->3000 (+1000) both
    # land in Total Expenses -- +1300 total vs the pre-patch baseline.
    assert _row_y1_raw(vm2, "Total Expenses") == pytest.approx(before_exp + 300 + 1000)


# ---- (c) an off-allowlist fixed_annual key is rejected (422, not an engine crash)
def test_patch_fixed_annual_unknown_key_422(client):
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"fixed_annual": {"Rocket fuel": 1}}},
        headers=_hdr(owner, version),
    )
    assert r.status_code == 422, r.text


def test_patch_fixed_annual_negative_value_422(client):
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"fixed_annual": {"Pest control": -5}}},
        headers=_hdr(owner, version),
    )
    assert r.status_code == 422, r.text


# ---- review 1.3f (f3): ge=0 bounds on donations_per_hh / basket / utilities_per_sqft
def test_patch_donations_per_hh_negative_422(client):
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"donations_per_hh": -1}},
        headers=_hdr(owner, version),
    )
    assert r.status_code == 422, r.text


def test_patch_basket_negative_422(client):
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"basket": "-5"}},
        headers=_hdr(owner, version),
    )
    assert r.status_code == 422, r.text


def test_patch_utilities_per_sqft_negative_422(client):
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"utilities_per_sqft": "-1"}},
        headers=_hdr(owner, version),
    )
    assert r.status_code == 422, r.text


# ---- (d) an out-of-range percent is rejected at the boundary --------------------
def test_patch_labor_pct_out_of_range_422(client):
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "5.0"}},  # 500% > 1
        headers=_hdr(owner, version),
    )
    assert r.status_code == 422, r.text


def test_patch_labor_pct_upper_bound_one_is_allowed(client):
    # labor_pct == 1 is intentionally in-band (the advisory band flag warns; the hard
    # cap only rejects a nonsensical > 100% share).
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "1.0"}},
        headers=_hdr(owner, version),
    )
    assert r.status_code == 200, r.text


# ---- (e) sensitivity_delta narrows/widens the ± stress; delta echoes ------------
def test_patch_sensitivity_delta_changes_downside(client):
    slug, owner, version, body = create_projection(client)
    before_down = body["sensitivity"]["downside"]["net"]["raw"]
    assert body["sensitivity"]["delta"] == pytest.approx(0.25)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"sensitivity_delta": "0.10"}},
        headers=_hdr(owner, version),
    )
    assert r.status_code == 200, r.text
    vm = r.json()
    assert vm["settings"]["sensitivityDelta"] == pytest.approx(0.10)
    assert vm["sensitivity"]["delta"] == pytest.approx(0.10)
    # a smaller ± fraction -> a less-severe downside -> a different downside net.
    assert vm["sensitivity"]["downside"]["net"]["raw"] != before_down


def test_patch_sensitivity_delta_above_bound_422(client):
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"sensitivity_delta": "1.5"}},  # > 0.9 -> negative mult
        headers=_hdr(owner, version),
    )
    assert r.status_code == 422, r.text


# ---- (f) create-time reserve_buffer flows into the decision math ----------------
def test_create_time_reserve_buffer(client):
    _, _, _, base = create_projection(client)
    base_cap = base["metrics"]["capital"]["raw"]
    _, _, _, body = create_projection(
        client, assumptions={"labor_pct": "0.60", "reserve_buffer": 40000})
    assert body["settings"]["reserveBuffer"] == 40000
    assert body["metrics"]["capital"]["raw"] == pytest.approx(base_cap + 15000)


def test_create_rejects_out_of_range_assumption_422(client):
    r = client.post("/api/projections", json={
        "name": "Bad", "inputs": {
            "org_name": "X", "city": "Longview, Texas", "opening_status": "pre_launch",
            "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
            "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
            "source_of_funds": "300000", "occupancy_annual": "120000",
        },
        "trade_area": {"basis": "city", "households": "31798"},
        "assumptions": {"sensitivity_delta": "2.0"},  # > 0.9
    })
    assert r.status_code == 422, r.text


# ---- legacy recompute: a row created with MINIMAL assumptions (no new keys) still
# recomputes on an unrelated PATCH — the merged dict lacks reserve_buffer/etc and
# they fall back to the frozen-dataclass defaults, never a KeyError/422. -----------
def test_legacy_minimal_assumptions_recompute_on_unrelated_patch(client):
    # create with ONLY labor_pct — mirrors a pre-1.3 snapshot lacking the new keys.
    slug, owner, version, _ = create_projection(
        client, assumptions={"labor_pct": "0.55"})
    r = client.patch(
        f"/api/projections/{slug}",
        json={"name": "Renamed"},  # an unrelated field forces a full recompute
        headers=_hdr(owner, version),
    )
    assert r.status_code == 200, r.text
    assert r.json()["settings"]["reserveBuffer"] == 25000  # engine default fills the gap


# ---- an engine-only assumptions key already in the stored dict (`startup`, a valid
# engine Assumptions field but NOT an AssumptionsIn field) is FILTERED out of the
# merge re-validation — never rejected — and still flows to the engine intact. ------
def test_stored_engine_only_key_survives_revalidation(client_store):
    client, store = client_store
    slug, owner, version, _ = create_projection(client)
    row = store.get_projection_by_slug(slug)
    a = json.loads(row["assumptions_json"])
    a["startup"] = {"Thrift Store Consultant": 100000,
                    "Equipment & Fixtures": 45000,
                    "Build-out / Renovations / Tenant Improvements": 50000,
                    "Legal, Permits, Insurance Setup, Signage": 13500}
    store._conn.execute(
        "UPDATE projections SET assumptions_json = ? WHERE id = ?",
        (json.dumps(a), row["id"]),
    )
    store._conn.commit()
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.55"}},
        headers=_hdr(owner, version),
    )
    assert r.status_code == 200, r.text

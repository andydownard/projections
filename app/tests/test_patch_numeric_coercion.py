"""Fix 1.3g — the PATCH revalidation must accept the NUMERIC wire shapes the deployed
frontend has always sent, and the stored-float rows deployed-era PATCHes already wrote.

The deployed ``SettingsTab`` ``buildBody`` sends the legacy cost/share/donation drivers
as JSON NUMBERS (``humanValue / scale`` — a float, or a rounded int for donations/hh),
so a live autosave posts ``{"assumptions": {"labor_pct": 0.45}}`` and
``{"inputs": {"donation_value": 60}}``. The wave's merge re-validation re-runs
``AssumptionsIn``/``InputsIn`` over the MERGED stored+incoming dict, and pydantic 2.13
does NOT coerce float/int -> ``Optional[str]`` — so every legacy-driver autosave 422'd,
and any deployed-era row that already STORED those drivers as floats in
``assumptions_json``/``inputs_json`` became permanently un-PATCHable (even a rename
revalidates the stored dict).

The fix coerces int/float -> str for the str-typed fields at the revalidation boundary
(``mode="before"`` validators on both models) WITHOUT loosening the bounds/allowlist
checks, and WITHOUT letting a bool through (``bool`` is an ``int`` subclass).
"""
import json

import pytest

from app.tests.conftest import create_projection


def _hdr(token, version):
    return {"Authorization": f"Bearer {token}", "If-Match": str(version)}


# ---- (1) a numeric labor_pct (the deployed assumptions wire shape) saves ---------
def test_patch_assumptions_labor_pct_json_number_ok(client):
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": 0.45}},  # JSON number, not "0.45"
        headers=_hdr(owner, version),
    )
    assert r.status_code == 200, r.text
    assert r.json()["settings"]["laborPct"] == pytest.approx(0.45)


# ---- (2) a numeric donation_value (the deployed inputs wire shape) saves ---------
def test_patch_inputs_donation_value_json_number_ok(client):
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"donation_value": 60}},  # JSON number, not "60"
        headers=_hdr(owner, version),
    )
    assert r.status_code == 200, r.text
    assert r.json()["settings"]["donationValue"] == pytest.approx(60)


# ---- (3) a deployed-era row that STORED labor_pct as a float is still PATCHable ---
# Even a rename revalidates the stored assumptions dict, so a stored float made the
# whole row un-editable pre-fix. Plant one and PATCH an UNRELATED field.
def test_stored_float_assumptions_row_patchable(client_store):
    client, store = client_store
    slug, owner, version, _ = create_projection(client)
    row = store.get_projection_by_slug(slug)
    a = json.loads(row["assumptions_json"])
    a["labor_pct"] = 0.45  # a real JSON FLOAT, as a deployed-era PATCH would have stored
    store._conn.execute(
        "UPDATE projections SET assumptions_json = ? WHERE id = ?",
        (json.dumps(a), row["id"]),
    )
    store._conn.commit()
    r = client.patch(
        f"/api/projections/{slug}",
        json={"name": "Renamed"},  # unrelated field — must not trip the revalidation
        headers=_hdr(owner, version),
    )
    assert r.status_code == 200, r.text
    # the recompute preserves the stored 0.45 (the float survives the coercion round-trip)
    assert r.json()["settings"]["laborPct"] == pytest.approx(0.45)


# ---- (3b) the same for a stored-float INPUTS row (donation_value) -----------------
def test_stored_float_inputs_row_patchable(client_store):
    client, store = client_store
    slug, owner, version, _ = create_projection(client)
    row = store.get_projection_by_slug(slug)
    i = json.loads(row["inputs_json"])
    i["donation_value"] = 60.0  # a real JSON FLOAT
    store._conn.execute(
        "UPDATE projections SET inputs_json = ? WHERE id = ?",
        (json.dumps(i), row["id"]),
    )
    store._conn.commit()
    r = client.patch(
        f"/api/projections/{slug}",
        json={"name": "Renamed"},
        headers=_hdr(owner, version),
    )
    assert r.status_code == 200, r.text
    assert r.json()["settings"]["donationValue"] == pytest.approx(60)


# ---- (4) bounds are STILL enforced on a coerced number (not loosened) ------------
def test_patch_labor_pct_number_out_of_range_still_422(client):
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": 5.0}},  # 500% as a NUMBER — still rejected
        headers=_hdr(owner, version),
    )
    assert r.status_code == 422, r.text


# ---- (5) a bool must NOT pass as a number (bool is an int subclass) ---------------
def test_patch_labor_pct_bool_422(client):
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": True}},  # JSON true — never a valid pct
        headers=_hdr(owner, version),
    )
    assert r.status_code == 422, r.text


# ---- pin the Penny int-like-string contract for the genuinely-INT knobs -----------
# reserve_buffer / donations_per_hh are Optional[int] and are DELIBERATELY NOT coerced
# by this fix (the fix only touches str-typed fields). The revalidation is a GATE, not
# a normalizer: it validates the merged surface (pydantic 2.13 laxly accepts an
# int-like string for an int field, so no 422) but the RAW value flows to the engine,
# where every use wraps it in D() (decision.py capital = |peak| + D(reserve_buffer);
# compute.py D(donations_per_hh)). So an int-like string is ACCEPTED and computes
# CORRECTLY; it is echoed VERBATIM (as the string sent) since the engine stores the raw
# knob. VERIFIED + pinned below (Penny/FE normally send true ints, which echo as ints).
def test_patch_reserve_buffer_intlike_string_ok(client):
    slug, owner, version, body = create_projection(client)
    before_cap = body["metrics"]["capital"]["raw"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"reserve_buffer": "40000"}},  # int-like string
        headers=_hdr(owner, version),
    )
    assert r.status_code == 200, r.text  # accepted, never 422
    vm = r.json()
    # the string is NOT coerced to int (int field left untouched) -> echoes verbatim,
    # but D() makes the decision math correct: capital rises by exactly 40000 - 25000.
    assert vm["settings"]["reserveBuffer"] == "40000"
    assert vm["metrics"]["capital"]["raw"] == pytest.approx(before_cap + 15000)


def test_patch_donations_per_hh_intlike_string_ok(client):
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"donations_per_hh": "4"}},  # int-like string
        headers=_hdr(owner, version),
    )
    assert r.status_code == 200, r.text  # accepted, never 422
    assert r.json()["settings"]["donationsPerHouseholdPerYear"] == "4"  # verbatim


# ---- and an actual INT for those knobs echoes as an int (the FE/Penny normal path)
def test_patch_reserve_buffer_int_ok(client):
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"reserve_buffer": 40000, "donations_per_hh": 4}},
        headers=_hdr(owner, version),
    )
    assert r.status_code == 200, r.text
    s = r.json()["settings"]
    assert s["reserveBuffer"] == 40000
    assert s["donationsPerHouseholdPerYear"] == 4


# ---- (6) THE INTEGRATION CLASS THAT WAS MISSING: the FE's exact numeric buildBody
# shape for EVERY legacy driver, in ONE body, saves and echoes each -----------------
def test_patch_fe_numeric_buildbody_all_legacy_drivers(client):
    slug, owner, version, _ = create_projection(client)
    r = client.patch(
        f"/api/projections/{slug}",
        json={
            "assumptions": {
                "labor_pct": 0.45,
                "marketing_pct": 0.04,
                "supplies_pct": 0.06,
                "card_pct": 0.025,
                "payroll_tax_pct": 0.08,
                "salvage_pct": 0.01,
                "escalator": 0.035,
                "donations_per_hh": 4,   # buildBody rounds decimals:0 -> a JS int
            },
            "inputs": {
                "share_y1": 0.07,
                "donation_value": 65,
            },
        },
        headers=_hdr(owner, version),
    )
    assert r.status_code == 200, r.text
    s = r.json()["settings"]
    assert s["laborPct"] == pytest.approx(0.45)
    assert s["marketingPct"] == pytest.approx(0.04)
    assert s["suppliesPct"] == pytest.approx(0.06)
    assert s["cardPct"] == pytest.approx(0.025)
    assert s["payrollTaxPct"] == pytest.approx(0.08)
    assert s["salvagePct"] == pytest.approx(0.01)
    assert s["escalator"] == pytest.approx(0.035)
    assert s["shareY1"] == pytest.approx(0.07)
    assert s["donationValue"] == pytest.approx(65)
    assert s["donationsPerHouseholdPerYear"] == 4

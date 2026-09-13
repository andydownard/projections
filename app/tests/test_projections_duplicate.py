"""POST /api/projections/{view_slug}/duplicate — server-side copy (API_SPEC §4.5).

The 409 modal's "Save as copy" was a client-side no-op and "Overwrite" replayed
only the name: a conflicting edit was silently lost while the UI claimed "saved"
(audited P0). The real fix is a server endpoint that copies a projection into a
FRESH row — new id / view_slug (never the source's) — and applies the optional
conflicted edit to the copy before compute, so save-as-copy carries the user's
unsaved change instead of dropping it.

This project has no authentication (owner decision, 2026-09-13): duplicate is
reachable with no bearer at all. Duplicate is a create-shaped endpoint (it makes a
NEW row; it never mutates the source), so the Mutation Safety Quad instantiates as:
  (c) rate limit     — per-IP, reusing create's 20/hr budget (§10.1);
  (d) copy-fidelity  — the copy carries the source's inputs/assumptions/overrides
                       verbatim, appends ONE revision, and the optional
                       {"patch": ...} flows through the SAME apply/validation
                       path as PATCH (fixed_annual accumulates identically).

If-Match/409 (the fourth classic quad leg) is N/A: duplicate creates a new row and
never version-mutates the source, exactly like create (no If-Match on create).

RED-first against app/routers/projections.py (the endpoint does not exist yet).
"""
import json

import pytest

import app.routers.projections as P
from app.tests.conftest import CANONICAL_BODY, create_projection


def _dup(client, slug, patch=None, headers=None):
    body = {"patch": patch} if patch is not None else {}
    return client.post(f"/api/projections/{slug}/duplicate", json=body, headers=headers or {})


def test_duplicate_unknown_slug_404(client):
    _slug, _v, _body = create_projection(client)
    r = _dup(client, "does-not-exist")
    assert r.status_code == 404, r.text


# ---------------------------------------------------------- quad (c) rate limit
def test_duplicate_rate_limited_429(client, monkeypatch):
    slug, _v, _body = create_projection(client)
    monkeypatch.setattr(P, "_DUPLICATE_IP_LIMIT", 3, raising=False)
    for _ in range(3):
        assert _dup(client, slug).status_code == 201
    r = _dup(client, slug)
    assert r.status_code == 429, r.text
    assert r.json()["error"] == "rate_limited"
    assert int(r.headers["Retry-After"]) >= 1


# ------------------------------------------------------- quad (d) copy fidelity
def test_duplicate_copies_fields_mints_fresh_id_and_appends_revision(client_store):
    client, store = client_store
    slug, _v, created = create_projection(client)
    src = store.get_projection_by_slug(slug)

    r = _dup(client, slug)
    assert r.status_code == 201, r.text
    out = r.json()

    # Fresh id/slug — NEVER the source's (a copy sharing a view_slug would collide).
    assert out["view_slug"] != slug
    assert "owner_token" not in out and "edit_token" not in out
    assert out["version"] == 1
    assert out["name"] == f"{created['name']} (copy)"

    copy = store.get_projection_by_slug(out["view_slug"])
    assert copy["id"] != src["id"]
    # Editable surface copied verbatim.
    for col in ("inputs_json", "assumptions_json", "demand_drivers_json",
                "trade_area_json", "overrides_json"):
        assert copy[col] == src[col], col
    # A fresh revision snapshot exists for the copy (seq 1, "duplicated").
    revs = store.list_revisions(copy["id"])
    assert len(revs) == 1
    assert revs[0]["seq"] == 1
    assert "duplicat" in (revs[0].get("change_summary") or "")

    # The source is untouched (still version 1, no revision).
    src_after = store.get_projection_by_slug(slug)
    assert src_after["version"] == 1
    assert len(store.list_revisions(src["id"])) == 0

    # Both appear in the (global) list.
    listing = client.get("/api/projections").json()["projections"]
    slugs = {p["view_slug"] for p in listing}
    assert slug in slugs and out["view_slug"] in slugs


def test_duplicate_copies_overrides(client_store):
    client, store = client_store
    slug, _v, _created = create_projection(client)
    # Pin Payroll Y1 via the real override PATCH path, then duplicate.
    pr = client.patch(
        f"/api/projections/{slug}",
        json={"overrides": {"set": [
            {"node": "Payroll", "year": 1, "value": "150000", "note": "hire"}]}},
        headers={"If-Match": "1"})
    assert pr.status_code == 200, pr.text
    src_overrides = json.loads(store.get_projection_by_slug(slug)["overrides_json"])
    assert src_overrides  # the pin landed

    r = _dup(client, slug)
    assert r.status_code == 201, r.text
    copy = store.get_projection_by_slug(r.json()["view_slug"])
    assert json.loads(copy["overrides_json"]) == src_overrides


def test_duplicate_applies_optional_patch_before_compute(client_store):
    client, store = client_store
    slug, _v, _created = create_projection(client)  # labor_pct 0.60
    src = store.get_projection_by_slug(slug)
    assert json.loads(src["assumptions_json"])["labor_pct"] == "0.60"

    # Save-as-copy carries the conflicted edit: labor 0.60 -> 0.45 on the COPY only.
    r = _dup(client, slug, patch={"assumptions": {"labor_pct": "0.45"}})
    assert r.status_code == 201, r.text
    out = r.json()

    copy = store.get_projection_by_slug(out["view_slug"])
    assert json.loads(copy["assumptions_json"])["labor_pct"] == "0.45"
    # The copy's stored compute echoes the patched setting (server is the math
    # authority — the copy is recomputed with the patch applied). settings.laborPct
    # is the raw fraction the client wraps for display.
    assert out["settings"]["laborPct"] == pytest.approx(0.45)

    # The SOURCE is untouched — the edit landed on the copy only.
    assert json.loads(store.get_projection_by_slug(slug)["assumptions_json"])[
        "labor_pct"] == "0.60"


def test_duplicate_patch_uses_same_validation_path_422_on_bad_value(client):
    slug, _v, _body = create_projection(client)
    before = {p["view_slug"] for p in client.get("/api/projections").json()["projections"]}
    # An out-of-range labor_pct (> 1) must 422 through the SAME AssumptionsIn bounds
    # that guard PATCH — the patch flows through _merge_patch, not a bypass.
    r = _dup(client, slug, patch={"assumptions": {"labor_pct": "5.0"}})
    assert r.status_code == 422, r.text
    # M2 (3.2f): the 422 fires in _merge_patch/_validate_schedule_inputs BEFORE any
    # durable write, so NO orphan copy row leaks into the list. The validation guards
    # the CREATE (not merely the response), so the list is byte-for-byte unchanged
    # across the rejected duplicate.
    after = {p["view_slug"] for p in client.get("/api/projections").json()["projections"]}
    assert after == before


def test_duplicate_patch_rejects_pinning_a_derived_node_422(client):
    slug, _v, _body = create_projection(client)
    # A derived/total node is non-pinnable — rejected server-side (regression #4),
    # same as PATCH, because the copy's patch goes through the override DAG.
    r = _dup(client, slug,
             patch={"overrides": {"set": [{"node": "net", "year": 1, "value": "1"}]}})
    assert r.status_code == 422, r.text


def test_duplicate_patch_fixed_annual_accumulates_over_source(client_store):
    client, store = client_store
    # Source already carries one fixed_annual line; the copy's patch sets a DIFFERENT
    # line. The merge must ACCUMULATE (both survive) exactly like the PATCH path.
    slug, _v, _created = create_projection(
        client, assumptions={"labor_pct": "0.60",
                             "fixed_annual": {"Insurance liability": 3000}})
    r = _dup(client, slug,
             patch={"assumptions": {"fixed_annual": {"Pest control": 600}}})
    assert r.status_code == 201, r.text
    copy = store.get_projection_by_slug(r.json()["view_slug"])
    merged = json.loads(copy["assumptions_json"])["fixed_annual"]
    assert merged.get("Insurance liability") == 3000
    assert merged.get("Pest control") == 600


def test_duplicate_no_patch_is_verbatim_copy(client_store):
    client, store = client_store
    slug, _v, _created = create_projection(client)
    r = _dup(client, slug)  # no patch body
    assert r.status_code == 201, r.text
    src = store.get_projection_by_slug(slug)
    copy = store.get_projection_by_slug(r.json()["view_slug"])
    assert copy["computed_json"] == src["computed_json"]
    assert copy["assumptions_json"] == src["assumptions_json"]


def test_duplicate_inherits_terms_acceptance(client_store):
    client, store = client_store
    payload = {**CANONICAL_BODY, "terms_accepted": True}
    r0 = client.post("/api/projections", json=payload)
    assert r0.status_code == 201, r0.text
    created = r0.json()
    slug = created["view_slug"]

    r = _dup(client, slug)
    assert r.status_code == 201, r.text
    copy = store.get_projection_by_slug(r.json()["view_slug"])
    # The source already accepted the planning-estimates caveat for this data; the copy
    # inherits it so exports (.xlsx/packet) are reachable without re-accepting.
    assert copy["terms_accepted_at"] is not None


def test_duplicate_of_a_trashed_source_pins_current_behavior(client_store):
    """CHARACTERIZATION — pins the CURRENT behavior of duplicating a TRASHED source.

    ``get_projection_by_slug`` filters only ``deleted_at`` (hard delete), NOT ``status``
    — so a *trashed* row is still resolvable. The copy is then created with the schema
    default ``status='active'``. This test pins that as-built behavior; it does NOT
    bless it.

    OPEN PRODUCT DECISION — FLAGGED TO THE OWNER (do not change here): whether
    duplicating a trashed projection should be *allowed as an undo/recovery path*
    (current) or *rejected* (404/409, like a gone resource) is an unresolved question
    surfaced in review slice 3.2f. If the decision is to reject, change the behavior and
    THIS test together, deliberately — never silently.
    """
    client, store = client_store
    slug, _v, _created = create_projection(client)
    # Trash the source (If-Match required).
    tr = client.post(
        f"/api/projections/{slug}/trash",
        headers={"If-Match": "1"},
    )
    assert tr.status_code == 200, tr.text
    assert store.get_projection_by_slug(slug)["status"] == "trashed"

    r = _dup(client, slug)
    # AS-BUILT: the trashed source is still duplicable (allow-as-recovery). Pinned, not
    # endorsed — see the docstring's flagged decision.
    assert r.status_code == 201, r.text
    copy = store.get_projection_by_slug(r.json()["view_slug"])
    # The copy is a normal ACTIVE projection (schema default), NOT trashed.
    assert copy["status"] == "active"
    # Duplicating never resurrects the source: it stays trashed.
    assert store.get_projection_by_slug(slug)["status"] == "trashed"

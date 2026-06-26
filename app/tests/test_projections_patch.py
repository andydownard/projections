"""M2 API — PATCH/autosave/concurrency slice (API_SPEC §1.3, §1.4, §4.4).

Every mutation requires Bearer (owner or edit) + If-Match. The server recomputes
on the merged inputs/assumptions/overrides, bumps version, and writes one revision
snapshot per settle. Stale If-Match -> 409 with current state; missing -> 428;
view-only -> 403. RED-first: written before the PATCH endpoint exists.
"""
from app.tests.conftest import _create, _pid


def test_patch_autosave_bumps_version_and_recomputes(client, store):
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.45"}},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
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
    slug, owner = created["view_slug"], created["owner_token"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.45"}},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "99"},
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
    slug, owner = created["view_slug"], created["owner_token"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.45"}},
        headers={"Authorization": f"Bearer {owner}"},
    )
    assert r.status_code == 428, r.text
    body = r.json().get("detail", r.json())
    assert body["error"] == "if_match_required"


def test_edit_token_can_patch(client):
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    r = client.patch(
        f"/api/projections/{slug}",
        json={"name": "Renamed via edit token"},
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2
    assert r.json()["name"] == "Renamed via edit token"


def test_view_only_cannot_patch(client, store):
    created = _create(client)
    slug = created["view_slug"]
    # no bearer at all -> view-only -> 403, version unchanged
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.45"}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 403, r.text
    # a wrong/unknown bearer is also rejected
    r2 = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.45"}},
        headers={"Authorization": "Bearer not-the-token", "If-Match": "1"},
    )
    assert r2.status_code == 403, r2.text
    assert store.get_projection_by_slug(slug)["version"] == 1


def test_patch_unknown_slug_404(client):
    r = client.patch(
        "/api/projections/does-not-exist",
        json={"name": "x"},
        headers={"Authorization": "Bearer whatever", "If-Match": "1"},
    )
    assert r.status_code == 404, r.text

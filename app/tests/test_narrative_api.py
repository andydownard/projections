"""M5 narrative + packet API (API_SPEC §6.1, §6.4).

  - GET   …/narrative            -> stored prose + staleness (owner/edit/view)
  - PUT   …/narrative            -> save user-edited prose, sanitized (owner/edit)
  - POST  …/narrative:regenerate -> regenerate from computed_json, grounded
  - GET   …/packet               -> board/funder/advisor packet (terms-gated)

HARD invariants tested adversarially:
  - hallucinated-figure rejection: regenerate w/ ungrounded prose -> 409, prior
    narrative NOT overwritten.
  - sanitization: PUT body_md is allowlist-sanitized before storage.
  - stale detection: editing the projection makes GET report stale + a diff,
    without clobbering the saved prose.
  - AI opt-out: regenerate -> 409 ai_disabled; GET reports ai_disabled; compute /
    save / xlsx still work with all AI keys unset.

RED-first: written before the endpoints exist.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore

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
    r = client.post("/api/projections", json=VALID_BODY)
    assert r.status_code in (200, 201), r.text
    return r.json()


def _accept_terms(store, slug):
    row = store.get_projection_by_slug(slug)
    store._conn.execute(
        "UPDATE projections SET terms_accepted_at = ? WHERE id = ?",
        ("2026-06-24T00:00:00Z", row["id"]),
    )
    store._conn.commit()


def _grounded_figures(client, slug):
    vm = client.get(f"/api/projections/{slug}").json()
    figs = []
    for m in ("capital", "cashGap", "breakeven"):
        figs.append(vm["metrics"][m]["display"])
    return vm, figs


# ----------------------------------------------------------------- GET empty
def test_get_narrative_empty_when_none(client):
    created = _create(client)
    r = client.get(f"/api/projections/{created['view_slug']}/narrative")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["body_md"] == ""
    assert body["edited"] is False
    assert body["ai_disabled"] is False


# ----------------------------------------------------------------- PUT save
def test_put_narrative_sanitizes_and_requires_edit(client):
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    # view-only (no token) cannot write
    r = client.put(f"/api/projections/{slug}/narrative",
                   json={"body_md": "<p>hi</p>"}, headers={"If-Match": "1"})
    assert r.status_code == 403

    # edit token: stored sanitized
    dirty = '<p>ok</p><script>steal(localStorage.token)</script>' \
            '<a href="javascript:alert(1)" onclick="x()">x</a>'
    r = client.put(
        f"/api/projections/{slug}/narrative",
        json={"body_md": dirty},
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    saved = r.json()["body_md"]
    assert "<script" not in saved.lower()
    assert "steal" not in saved
    assert "javascript:" not in saved.lower()
    assert "onclick" not in saved.lower()
    assert "<p>ok</p>" in saved

    # GET returns it, edited:true
    g = client.get(f"/api/projections/{slug}/narrative").json()
    assert g["edited"] is True
    assert "<p>ok</p>" in g["body_md"]


# -------------------------------------------------------- regenerate grounded
def test_regenerate_produces_grounded_prose(client):
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    r = client.post(
        f"/api/projections/{slug}/narrative:regenerate",
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["body_md"]
    assert body["edited"] is False
    # every figure in the generated prose exists in computed_json
    from app.narrative import validate_grounding
    vm = client.get(f"/api/projections/{slug}").json()
    validate_grounding(body["body_md"], vm)  # must not raise


def test_regenerate_rejects_hallucinated_figure_without_clobbering(client, monkeypatch):
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    # seed a saved narrative first
    client.put(
        f"/api/projections/{slug}/narrative",
        json={"body_md": "<p>original prose</p>"},
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )
    # force the generator to emit an ungrounded figure
    import app.routers.projections as proj
    monkeypatch.setattr(
        proj, "_generate_narrative_md",
        lambda vm, role=None: "The store needs $9,999,999 in capital.")
    r = client.post(
        f"/api/projections/{slug}/narrative:regenerate",
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "grounding_failed"
    assert "$9,999,999" in r.json()["detail"]["ungrounded_figures"]
    # prior narrative untouched
    g = client.get(f"/api/projections/{slug}/narrative").json()
    assert "original prose" in g["body_md"]


# ----------------------------------------------------------- stale detection
def test_stale_detection_without_clobbering_edits(client):
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    vm, _ = _grounded_figures(client, slug)
    cap = vm["metrics"]["capital"]["display"]
    # save grounded edited prose
    body = f"<p>The store needs {cap} in capital.</p>"
    client.put(
        f"/api/projections/{slug}/narrative",
        json={"body_md": body},
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )
    g = client.get(f"/api/projections/{slug}/narrative").json()
    assert g["stale"] is False

    # mutate the projection so the headline figures (capital/gap/break-even) move
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"share_y1": "0.12"}},
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text

    g2 = client.get(f"/api/projections/{slug}/narrative").json()
    assert g2["stale"] is True
    assert g2["stale_diff"]  # at least one changed figure
    # the user's prose was NOT overwritten
    assert cap in g2["body_md"]


# --------------------------------------------------------------- AI opt-out
def _set_ai_opt_out(store, slug):
    row = store.get_projection_by_slug(slug)
    store._conn.execute(
        "UPDATE projections SET ai_opt_out = 1 WHERE id = ?", (row["id"],))
    store._conn.commit()


def test_ai_opt_out_blocks_regenerate_but_not_compute_or_export(client, store):
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    _set_ai_opt_out(store, slug)

    g = client.get(f"/api/projections/{slug}/narrative").json()
    assert g["ai_disabled"] is True

    r = client.post(
        f"/api/projections/{slug}/narrative:regenerate",
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "ai_disabled"

    # compute (read) + save + xlsx still work with zero AI
    assert client.get(f"/api/projections/{slug}").status_code == 200
    _accept_terms(store, slug)
    x = client.get(f"/api/projections/{slug}/xlsx")
    assert x.status_code == 200, x.text


# --------------------------------------------------------------------- packet
def test_packet_requires_terms_then_downloads(client, store):
    created = _create(client)
    slug = created["view_slug"]
    r = client.get(f"/api/projections/{slug}/packet")
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "terms_required"

    _accept_terms(store, slug)
    r = client.get(f"/api/projections/{slug}/packet")
    assert r.status_code == 200, r.text
    cd = r.headers.get("content-disposition", "")
    assert "attachment" in cd
    # the real capital figure is grounded into the packet body
    vm, _ = _grounded_figures(client, slug)
    assert vm["metrics"]["capital"]["display"] in r.text


def test_packet_role_variants(client, store):
    created = _create(client)
    slug = created["view_slug"]
    _accept_terms(store, slug)
    board = client.get(f"/api/projections/{slug}/packet?role=board")
    funder = client.get(f"/api/projections/{slug}/packet?role=funder")
    assert board.status_code == 200
    assert funder.status_code == 200
    # role-specific framing differs
    assert board.text != funder.text


def test_packet_unknown_slug_404(client):
    r = client.get("/api/projections/nope/packet")
    assert r.status_code == 404

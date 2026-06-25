"""epic-N N11 — stale coupling + packet uses the CURRENT stored body (M5/N).

The narrative is the board packet's trust surface. Two coupled invariants:

  1. ANY change to ``computed_json`` flips the stored narrative to ``stale`` via
     ``computed_hash`` divergence — on EVERY mutation path (PATCH autosave,
     evidence attach, model upgrade). Staleness is a stored-hash vs live-hash
     compare in ``_narrative_response``; because every mutation rewrites
     ``computed_json`` with new figures, the next GET reports stale and surfaces a
     was->now diff WITHOUT clobbering the user's prose.

  2. The packet / .docx export uses the CURRENT stored (possibly ``edited:true``)
     sanitized ``body_md`` — never silently dropped just because it is stale. The
     packet is the human's last-edited prose, sanitized, verbatim.

  3. The was->now diff (narrative stale_diff AND the /preview changed[] list) is
     produced by ONE shared formatter (``format_was_now``) so the two surfaces
     never drift in shape.

RED-first: written before the packet-uses-edited body change and before the
shared formatter is extracted.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.narrative import compute_hash
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


def _save_grounded(client, slug, edit, version=1):
    """Save a grounded, edited narrative referencing the live capital figure."""
    vm = client.get(f"/api/projections/{slug}").json()
    cap = vm["metrics"]["capital"]["display"]
    body = f"<p>The store needs {cap} in startup capital.</p>"
    r = client.put(
        f"/api/projections/{slug}/narrative",
        json={"body_md": body},
        headers={"Authorization": f"Bearer {edit}", "If-Match": str(version)},
    )
    assert r.status_code == 200, r.text
    return cap


# ------------------------------------------------ N11.1: PATCH flips to stale
def test_patch_flips_narrative_stale(client):
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    cap = _save_grounded(client, slug, edit)

    assert client.get(f"/api/projections/{slug}/narrative").json()["stale"] is False

    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"share_y1": "0.12"}},
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text

    g = client.get(f"/api/projections/{slug}/narrative").json()
    assert g["stale"] is True
    assert g["stale_diff"], "a moved figure must surface in the was->now diff"
    # the prose is never clobbered
    assert cap in g["body_md"]
    assert g["edited"] is True


# ------------------------ N11.1: ANY computed_json mutation diverges the hash
def test_any_computed_json_change_diverges_hash(client, store):
    """Evidence attach / model upgrade rewrite computed_json -> hash divergence.

    We don't depend on those endpoints existing yet; the invariant is that the
    STORED narrative hash is taken from the computed_json at save time, so the
    instant a mutation path writes a different computed_json the GET reports
    stale. We exercise the store-level write that every such path funnels through.
    """
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    _save_grounded(client, slug, edit)
    assert client.get(f"/api/projections/{slug}/narrative").json()["stale"] is False

    # Simulate an evidence/upgrade mutation: rewrite computed_json with a moved
    # capital figure (this is exactly what those paths persist).
    row = store.get_projection_by_slug(slug)
    vm = json.loads(row["computed_json"])
    vm["metrics"]["capital"] = {"raw": 999999.0, "display": "$999,999"}
    new_hash = compute_hash(vm)
    old_hash = compute_hash(json.loads(row["computed_json"]))
    assert new_hash != old_hash, "moving a fact must change the computed_hash"
    store._conn.execute(
        "UPDATE projections SET computed_json = ? WHERE id = ?",
        (json.dumps(vm), row["id"]))
    store._conn.commit()

    g = client.get(f"/api/projections/{slug}/narrative").json()
    assert g["stale"] is True


# --------------------- N11.2: packet uses the CURRENT stored (edited) body_md
def test_packet_uses_current_stored_edited_body(client, store):
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    _save_grounded(client, slug, edit)
    _accept_terms(store, slug)

    # Edit the prose with a distinctive, GROUNDED sentence the engine never wrote.
    vm = client.get(f"/api/projections/{slug}").json()
    cap = vm["metrics"]["capital"]["display"]
    marker = "Board-reviewed and approved by the finance committee."
    edited = f"<p>{marker} Capital required is {cap}.</p>"
    r = client.put(
        f"/api/projections/{slug}/narrative",
        json={"body_md": edited},
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text

    pkt = client.get(f"/api/projections/{slug}/packet")
    assert pkt.status_code == 200, pkt.text
    # the human's edited prose travels into the packet verbatim
    assert marker in pkt.text


def test_packet_uses_edited_body_even_when_stale(client, store):
    """A stale (but edited) narrative is NOT dropped — the board's last prose ships."""
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    _accept_terms(store, slug)

    vm = client.get(f"/api/projections/{slug}").json()
    cap = vm["metrics"]["capital"]["display"]
    marker = "Reviewed narrative the operator hand-edited."
    edited = f"<p>{marker} Needs {cap}.</p>"
    client.put(
        f"/api/projections/{slug}/narrative",
        json={"body_md": edited},
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )

    # mutate so the narrative goes stale
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"share_y1": "0.12"}},
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    assert client.get(f"/api/projections/{slug}/narrative").json()["stale"] is True

    pkt = client.get(f"/api/projections/{slug}/packet")
    assert pkt.status_code == 200, pkt.text
    # stale or not, the operator's edited prose still ships in the packet
    assert marker in pkt.text


# ---------------------------------------------------------- N11.3: .docx export
def test_packet_docx_format(client, store):
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    _save_grounded(client, slug, edit)
    _accept_terms(store, slug)

    r = client.get(f"/api/projections/{slug}/packet?format=docx")
    assert r.status_code == 200, r.text
    cd = r.headers.get("content-disposition", "")
    assert "attachment" in cd
    assert cd.endswith('.docx"') or ".docx" in cd
    # a .docx is a zip container (PK magic bytes)
    assert r.content[:2] == b"PK"


def test_packet_docx_carries_edited_body(client, store):
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    _accept_terms(store, slug)

    vm = client.get(f"/api/projections/{slug}").json()
    cap = vm["metrics"]["capital"]["display"]
    marker = "Distinctive board-edited sentence for docx."
    client.put(
        f"/api/projections/{slug}/narrative",
        json={"body_md": f"<p>{marker} Capital {cap}.</p>"},
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )

    r = client.get(f"/api/projections/{slug}/packet?format=docx")
    assert r.status_code == 200, r.text
    # the docx XML (inside the zip) carries the edited prose
    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        doc_xml = zf.read("word/document.xml").decode("utf-8")
    assert marker in doc_xml


# ---------------------------------------------- N11.3: shared was->now formatter
def test_shared_was_now_formatter():
    """One formatter backs both stale_diff and /preview changed[] (no drift)."""
    from app.narrative import format_was_now

    rows = format_was_now([
        {"field": "capital", "was": "$262,400", "now": "$277,990"},
    ])
    assert rows == [
        {"field": "capital", "was": "$262,400", "now": "$277,990"},
    ]


def test_was_now_formatter_used_by_stale_diff_and_preview(client):
    """stale_diff and preview changed[] both expose was+now keys (shared shape)."""
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    _save_grounded(client, slug, edit)
    client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"share_y1": "0.12"}},
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )
    diff = client.get(f"/api/projections/{slug}/narrative").json()["stale_diff"]
    assert diff
    for d in diff:
        assert "was" in d and "now" in d

    pv = client.post(
        f"/api/projections/{slug}/preview",
        json={"inputs": {"share_y1": "0.20"}},
        headers={"Authorization": f"Bearer {edit}"},
    )
    assert pv.status_code == 200, pv.text
    for c in pv.json()["changed"]:
        assert "was" in c and "now" in c

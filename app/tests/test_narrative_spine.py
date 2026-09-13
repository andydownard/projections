"""Slice 11 (epic-N N3+N4+N6) — grounded narrative spine.

N3: a CANONICAL grounded-figure list with DISPLAY VARIANTS derived from
    computed_json (NOT a client regex): $277,990 / $278k / ($41,200) all map to
    one canonical figure, so the grounding validator and the client share one
    server-built list.
N4: PUT …/narrative — edit_origin classification, bleach-style allowlist sanitize,
    numeric-grounding FAIL-CLOSED (an ungrounded figure rejects the save and
    leaves the prior narrative untouched), edited=true, If-Match required.
N6: POST …/narrative:regenerate — Anthropic primary -> OpenAI fallback, the
    edited-flag confirm-before-discard gate, grounding fail-closed, AI
    unavailable/disabled paths, and a provider field that reflects the actual
    provider used.

RED-first: written before the N3 helpers / edit_origin / provider plumbing exist.
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


# ===================================================================== N3
# Canonical grounded-figure list + display variants, server-derived.
def test_canonical_figures_emit_thousands_and_accounting_variants():
    from app.narrative import canonical_grounded_figures

    vm = {
        "metrics": {
            "capital": {"raw": 277990.0, "display": "$277,990"},
            "cashGap": {"raw": -41200.0, "display": "($41,200)"},
        },
    }
    figs = canonical_grounded_figures(vm)
    by_raw = {round(f["raw"]): f for f in figs}
    # capital: canonical display + a $278k short form variant
    cap = by_raw[277990]
    assert cap["display"] == "$277,990"
    assert "$278k" in cap["variants"]
    # cashGap: the accounting-negative variant is preserved
    gap = by_raw[-41200]
    assert "($41,200)" in gap["variants"]


def test_grounding_accepts_a_server_listed_display_variant():
    """A $278k short form is grounded because the SERVER built that variant — not
    a client regex inventing it."""
    from app.narrative import validate_grounding

    vm = {"metrics": {"capital": {"raw": 277990.0, "display": "$277,990"}}}
    # the short-form variant must validate without raising
    validate_grounding("<p>About $278k is needed.</p>", vm)


def test_get_narrative_exposes_server_grounded_figure_list(client):
    created = _create(client)
    slug = created["view_slug"]
    g = client.get(f"/api/projections/{slug}/narrative").json()
    assert "grounded_figures" in g
    assert isinstance(g["grounded_figures"], list)
    # each entry is the server-built canonical figure with variants
    assert all("display" in f and "variants" in f for f in g["grounded_figures"])
    # the capital figure is present and grounded
    vm = client.get(f"/api/projections/{slug}").json()
    cap = vm["metrics"]["capital"]["display"]
    assert any(cap == f["display"] for f in g["grounded_figures"])


# ===================================================================== N4
def test_put_narrative_classifies_edit_origin_human(client):
    created = _create(client)
    slug = created["view_slug"]
    vm = client.get(f"/api/projections/{slug}").json()
    cap = vm["metrics"]["capital"]["display"]
    r = client.put(
        f"/api/projections/{slug}/narrative",
        json={"body_md": f"<p>The plan needs {cap}.</p>"},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["edited"] is True
    assert body["edit_origin"] == "human"
    g = client.get(f"/api/projections/{slug}/narrative").json()
    assert g["edit_origin"] == "human"


def test_put_narrative_fails_closed_on_ungrounded_figure(client):
    """An ungrounded figure in a HUMAN edit rejects the save and leaves the prior
    narrative untouched (fail-closed, SECURITY §6.3)."""
    created = _create(client)
    slug = created["view_slug"]
    # seed a valid prior narrative (a successful narrative write bumps the version 1->2)
    vm = client.get(f"/api/projections/{slug}").json()
    cap = vm["metrics"]["capital"]["display"]
    client.put(
        f"/api/projections/{slug}/narrative",
        json={"body_md": f"<p>original {cap}</p>"},
        headers={"If-Match": "1"},
    )
    # now PUT prose with a hallucinated figure (at the current version 2)
    r = client.put(
        f"/api/projections/{slug}/narrative",
        json={"body_md": "<p>The plan needs $9,999,999.</p>"},
        headers={"If-Match": "2"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "grounding_failed"
    assert "$9,999,999" in r.json()["detail"]["ungrounded_figures"]
    # prior narrative untouched
    g = client.get(f"/api/projections/{slug}/narrative").json()
    assert "original" in g["body_md"]


def test_put_narrative_requires_if_match(client):
    created = _create(client)
    slug = created["view_slug"]
    r = client.put(
        f"/api/projections/{slug}/narrative",
        json={"body_md": "<p>ok</p>"},
    )
    assert r.status_code == 428
    assert r.json()["detail"]["error"] == "if_match_required"


# ===================================================================== N6
def test_regenerate_reports_provider_anthropic_when_primary_succeeds(client, monkeypatch):
    created = _create(client)
    slug = created["view_slug"]
    import app.narrative_provider as prov

    def fake_anthropic(vm, role=None):
        cap = (vm.get("metrics") or {}).get("capital", {}).get("display", "")
        return f"<p>Anthropic says {cap}.</p>"

    monkeypatch.setattr(prov, "_call_anthropic", fake_anthropic)
    monkeypatch.setattr(prov, "_anthropic_available", lambda: True)
    r = client.post(
        f"/api/projections/{slug}/narrative:regenerate",
        headers={"If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["provider"] == "anthropic"


def test_regenerate_flips_to_openai_when_anthropic_fails(client, monkeypatch):
    created = _create(client)
    slug = created["view_slug"]
    import app.narrative_provider as prov

    def boom(vm, role=None):
        raise RuntimeError("anthropic down")

    def fake_openai(vm, role=None):
        cap = (vm.get("metrics") or {}).get("capital", {}).get("display", "")
        return f"<p>OpenAI says {cap}.</p>"

    monkeypatch.setattr(prov, "_anthropic_available", lambda: True)
    monkeypatch.setattr(prov, "_openai_available", lambda: True)
    monkeypatch.setattr(prov, "_call_anthropic", boom)
    monkeypatch.setattr(prov, "_call_openai", fake_openai)
    r = client.post(
        f"/api/projections/{slug}/narrative:regenerate",
        headers={"If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["provider"] == "openai"


def test_regenerate_503_when_both_providers_fail(client, monkeypatch):
    created = _create(client)
    slug = created["view_slug"]
    import app.narrative_provider as prov

    def boom(vm, role=None):
        raise RuntimeError("provider down")

    monkeypatch.setattr(prov, "_anthropic_available", lambda: True)
    monkeypatch.setattr(prov, "_openai_available", lambda: True)
    monkeypatch.setattr(prov, "_call_anthropic", boom)
    monkeypatch.setattr(prov, "_call_openai", boom)
    r = client.post(
        f"/api/projections/{slug}/narrative:regenerate",
        headers={"If-Match": "1"},
    )
    assert r.status_code == 503, r.text
    assert r.json()["detail"]["error"] == "ai_unavailable"


def test_regenerate_over_edited_requires_confirm(client):
    """Confirm-before-discard gate: regenerating over a user-edited narrative
    without ?confirm=true is rejected so user prose is never silently discarded."""
    created = _create(client)
    slug = created["view_slug"]
    vm = client.get(f"/api/projections/{slug}").json()
    cap = vm["metrics"]["capital"]["display"]
    # user hand-edits the narrative (a successful narrative write bumps the version 1->2)
    client.put(
        f"/api/projections/{slug}/narrative",
        json={"body_md": f"<p>hand written {cap}</p>"},
        headers={"If-Match": "1"},
    )
    # regenerate without confirm -> blocked, prose intact. The confirm-required 409 is
    # rejected before the write, so the version stays 2 for the confirmed retry below.
    r = client.post(
        f"/api/projections/{slug}/narrative:regenerate",
        headers={"If-Match": "2"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "edited_confirm_required"
    g = client.get(f"/api/projections/{slug}/narrative").json()
    assert "hand written" in g["body_md"]

    # regenerate WITH confirm -> proceeds and replaces, edited resets to false
    r2 = client.post(
        f"/api/projections/{slug}/narrative:regenerate?confirm=true",
        headers={"If-Match": "2"},
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["edited"] is False
    g2 = client.get(f"/api/projections/{slug}/narrative").json()
    assert "hand written" not in g2["body_md"]


def test_regenerate_opt_out_blocks_with_ai_disabled(client, store):
    created = _create(client)
    slug = created["view_slug"]
    row = store.get_projection_by_slug(slug)
    store._conn.execute(
        "UPDATE projections SET ai_opt_out = 1 WHERE id = ?", (row["id"],))
    store._conn.commit()
    r = client.post(
        f"/api/projections/{slug}/narrative:regenerate",
        headers={"If-Match": "1"},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "ai_disabled"

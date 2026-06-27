"""PE2 — GET /api/projections/{view_slug}/penny/transcript (Spec §7/§12; #121).

A read seam (the POST tool-use loop is PE5). Owner/edit Bearer scoped: the auth
quad — owner 200, this projection's edit token 200, view-only/no-token 403, a
different owner's token 403, unknown slug 404. No cross-owner leakage. Returns the
persisted transcript turns verbatim (server is the one shape authority).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore


@pytest.fixture()
def client():
    store = SqliteStore(":memory:")
    store.migrate()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


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


def _store(client):
    return list(client.app.dependency_overrides.values())[0]()


def _create(client):
    r = client.post("/api/projections", json=VALID_BODY)
    assert r.status_code == 201, r.text
    return r.json()


def _seed_turn(client, view_slug, **turn):
    store = _store(client)
    row = store.get_projection_by_slug(view_slug)
    base = {"role": "user", "content": "hi", "ts": "2026-06-27T00:00:00Z"}
    base.update(turn)
    store.append_transcript_turn(row["id"], base)


def _url(view_slug):
    return f"/api/projections/{view_slug}/penny/transcript"


# ----------------------------------------------------------- auth quad
def test_owner_can_read_transcript(client):
    p = _create(client)
    r = client.get(_url(p["view_slug"]),
                   headers={"Authorization": f"Bearer {p['owner_token']}"})
    assert r.status_code == 200, r.text
    assert r.json()["turns"] == []


def test_edit_token_can_read_transcript(client):
    p = _create(client)
    r = client.get(_url(p["view_slug"]),
                   headers={"Authorization": f"Bearer {p['edit_token']}"})
    assert r.status_code == 200, r.text


def test_view_only_no_token_is_forbidden(client):
    p = _create(client)
    r = client.get(_url(p["view_slug"]))
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "forbidden"


def test_other_owner_token_is_forbidden(client):
    p1 = _create(client)
    p2 = _create(client)  # a different projection / different owner token
    r = client.get(_url(p1["view_slug"]),
                   headers={"Authorization": f"Bearer {p2['owner_token']}"})
    assert r.status_code == 403


def test_unknown_slug_is_404(client):
    r = client.get(_url("does-not-exist"),
                   headers={"Authorization": "Bearer whatever"})
    assert r.status_code == 404


# ----------------------------------------------------------- content round-trip
def test_returns_persisted_turns(client):
    p = _create(client)
    _seed_turn(client, p["view_slug"], role="user", content="Set Y1 share to 8%")
    _seed_turn(client, p["view_slug"], role="assistant", content="Done — now 8%.",
               provider="anthropic")
    r = client.get(_url(p["view_slug"]),
                   headers={"Authorization": f"Bearer {p['owner_token']}"})
    assert r.status_code == 200
    turns = r.json()["turns"]
    assert [t["content"] for t in turns] == ["Set Y1 share to 8%", "Done — now 8%."]
    assert turns[1]["provider"] == "anthropic"


def test_empty_transcript_returns_empty_turns(client):
    p = _create(client)
    r = client.get(_url(p["view_slug"]),
                   headers={"Authorization": f"Bearer {p['owner_token']}"})
    assert r.status_code == 200
    assert r.json()["turns"] == []


def test_no_cross_projection_leak(client):
    p1 = _create(client)
    p2 = _create(client)
    _seed_turn(client, p2["view_slug"], content="P2-secret")
    r = client.get(_url(p1["view_slug"]),
                   headers={"Authorization": f"Bearer {p1['owner_token']}"})
    assert r.status_code == 200
    assert "P2-secret" not in r.text

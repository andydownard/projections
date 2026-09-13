"""SLICE 10 — epic-N N1: dry-run /preview (API_SPEC §4.4-adjacent, read-only).

POST /api/projections/{view_slug}/preview merges an editable-surface partial,
recomputes via the engine, and returns {before, after, changed[], reco_before,
reco_after}. It is READ-ONLY: no persist, no version bump, no revision. Same 422
rejections as PATCH (invalid input, non-pinnable node). This project has no
authentication (owner decision, 2026-09-13); no If-Match either. Rate-limited on
the read bucket.

RED-first: written before the /preview endpoint exists.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.ratelimit import reset_rate_limits
from app.store import get_store
from app.store.sqlite import SqliteStore


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


@pytest.fixture()
def client(store):
    reset_rate_limits()
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


def _create(client):
    r = client.post("/api/projections", json=VALID_BODY)
    assert r.status_code == 201, r.text
    return r.json()


def _pid(store, slug):
    return store.get_projection_by_slug(slug)["id"]


def test_preview_returns_before_after_changed_and_reco(client, store):
    created = _create(client)
    slug = created["view_slug"]
    r = client.post(
        f"/api/projections/{slug}/preview",
        json={"assumptions": {"labor_pct": "0.45"}},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # the three decision metrics show up before/after
    assert "before" in body and "after" in body
    assert "capital" in body["before"] and "capital" in body["after"]
    assert "reco_before" in body and "reco_after" in body
    # changed[] carries {label, was, now, sign}
    assert isinstance(body["changed"], list) and len(body["changed"]) >= 1
    sample = body["changed"][0]
    for k in ("label", "was", "now", "sign"):
        assert k in sample, sample
    assert sample["sign"] in ("up", "down", "flat")


def test_preview_does_not_persist_or_bump_version_or_write_revision(client, store):
    created = _create(client)
    slug = created["view_slug"]
    before_row = store.get_projection_by_slug(slug)
    r = client.post(
        f"/api/projections/{slug}/preview",
        json={"assumptions": {"labor_pct": "0.45"}},
    )
    assert r.status_code == 200, r.text
    after_row = store.get_projection_by_slug(slug)
    # NO mutation: version unchanged, stored computed_json unchanged
    assert after_row["version"] == before_row["version"] == 1
    assert after_row["computed_json"] == before_row["computed_json"]
    assert after_row["assumptions_json"] == before_row["assumptions_json"]
    # NO revision written
    assert len(store.list_revisions(_pid(store, slug))) == 0


def test_preview_requires_no_if_match(client):
    created = _create(client)
    slug = created["view_slug"]
    # NO If-Match header at all -> still 200 (preview is read-only)
    r = client.post(
        f"/api/projections/{slug}/preview",
        json={"assumptions": {"labor_pct": "0.45"}},
    )
    assert r.status_code == 200, r.text


def test_preview_rejects_non_pinnable_node_422(client, store):
    created = _create(client)
    slug = created["view_slug"]
    r = client.post(
        f"/api/projections/{slug}/preview",
        json={"overrides": {"set": [{"node": "Net income", "year": 2, "value": "1"}]}},
    )
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "node_not_pinnable"
    # nothing persisted
    assert store.get_projection_by_slug(slug)["version"] == 1


def test_preview_rejects_invalid_input_422(client):
    created = _create(client)
    slug = created["view_slug"]
    r = client.post(
        f"/api/projections/{slug}/preview",
        json={"inputs": {"building_sqft": "not-a-number"}},
    )
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "invalid_inputs"


def test_preview_unknown_slug_404(client):
    r = client.post(
        "/api/projections/does-not-exist/preview",
        json={"name": "x"},
    )
    assert r.status_code == 404, r.text


def test_preview_rate_limited_on_read_bucket(client, monkeypatch):
    created = _create(client)
    slug = created["view_slug"]
    # shrink the read bucket so the cap is reachable in a test
    import app.routers.projections as P
    monkeypatch.setattr(P, "_PREVIEW_IP_LIMIT", 3, raising=False)
    body = {"assumptions": {"labor_pct": "0.45"}}
    seen_429 = False
    for _ in range(10):
        r = client.post(f"/api/projections/{slug}/preview", json=body)
        if r.status_code == 429:
            seen_429 = True
            assert r.json()["error"] == "rate_limited"
            assert "retry_after_seconds" in r.json()
            break
    assert seen_429, "preview never hit the read-bucket rate limit"

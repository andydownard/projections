"""M6 intent capture -> CRM (API_SPEC §8.2, IDEA_FAB §0, PRD §6.1).

Intent is a SEPARATE endpoint, SEPARATE store, SEPARATE destination from
feedback. It may carry an email and explicit consent; it NEVER carries the
projection's financial detail. CRM delivery is stubbed and graceful-degrades
when CRM_API_KEY is unset (persisted, not sent). Rate-limited per IP.
"""
import pytest
from fastapi.testclient import TestClient

import app.routers.intent as intent_mod
from app.main import create_app
from app.ratelimit import reset_rate_limits
from app.store import get_store
from app.store.sqlite import SqliteStore


@pytest.fixture()
def client():
    reset_rate_limits()
    store = SqliteStore(":memory:")
    store.migrate()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


PAYLOAD = {
    "email": "ed@hopechurch.org",
    "role": "ED",
    "reason": "Need a board-ready case",
    "opening_timeline": "3-6mo",
    "request_expert_review": True,
    "follow_up_consent": True,
}


def test_intent_accepts_and_returns_received(client):
    r = client.post("/api/intent", json=PAYLOAD)
    assert r.status_code == 201, r.text
    assert r.json() == {"received": True}


def test_intent_persists_to_its_own_store(client):
    client.post("/api/intent", json=PAYLOAD)
    store = list(client.app.dependency_overrides.values())[0]()
    row = store._conn.execute("SELECT * FROM intent").fetchone()
    assert row["email"] == "ed@hopechurch.org"
    assert row["role"] == "ED"


def test_intent_carries_no_financial_fields(client):
    client.post("/api/intent", json=PAYLOAD)
    store = list(client.app.dependency_overrides.values())[0]()
    row = store._conn.execute("SELECT * FROM intent").fetchone()
    blob = " ".join(str(v) for v in dict(row).values())
    for leak in ("capital", "revenue", "computed_json", "view_slug", "$"):
        assert leak not in blob


def test_intent_crm_stub_invoked(client, monkeypatch):
    calls = []
    monkeypatch.setattr(intent_mod, "send_to_crm", lambda p: calls.append(p))
    r = client.post("/api/intent", json=PAYLOAD)
    assert r.status_code == 201
    assert len(calls) == 1
    assert calls[0]["email"] == "ed@hopechurch.org"


def test_intent_graceful_degrade_when_crm_unset(client, monkeypatch):
    # send_to_crm degrades to None when CRM_API_KEY is unset; never a 500.
    monkeypatch.delenv("CRM_API_KEY", raising=False)
    r = client.post("/api/intent", json=PAYLOAD)
    assert r.status_code == 201
    assert r.json() == {"received": True}


def test_intent_validation_requires_email(client):
    r = client.post("/api/intent", json={"role": "ED"})
    assert r.status_code in (400, 422)


def test_intent_rate_limited(client):
    limited = False
    for _ in range(40):
        r = client.post("/api/intent", json=PAYLOAD)
        if r.status_code == 429:
            limited = True
            assert r.headers.get("Retry-After")
            break
    assert limited

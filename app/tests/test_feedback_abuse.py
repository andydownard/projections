"""M6 feedback abuse controls + the Tier-1 leak gate (IDEA_FAB §4/§6, PRD §22).

The leak test stuffs a feedback request with a real view_slug, owner token,
edit-link fragment, recovery code, resolvable URL, and financial strings, then
asserts the EXACT GitHub payload the server would send carries NONE of them.
The GitHub call is stubbed so the payload is captured deterministically.

Abuse controls: honeypot silently drops; per-IP/per-token rate limits return
429 + Retry-After and make NO GitHub call past the limit; length caps bound the
issue body.
"""
import json

import pytest
from fastapi.testclient import TestClient

import app.routers.feedback as feedback_mod
from app.main import create_app
from app.ratelimit import reset_rate_limits
from app.store import get_store
from app.store.sqlite import SqliteStore


@pytest.fixture()
def captured(monkeypatch):
    """Stub the GitHub issue filer; capture the exact outbound payload."""
    calls = []

    def _fake_file(payload: dict) -> str:
        calls.append(payload)
        return "https://github.com/rallytasks/projections/issues/123"

    monkeypatch.setattr(feedback_mod, "file_github_issue", _fake_file)
    return calls


@pytest.fixture()
def client():
    reset_rate_limits()
    store = SqliteStore(":memory:")
    store.migrate()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


LEAKY = {
    "type": "bug",
    "title": "see p_8xSECRETslug capital $277,990",
    "description": (
        "My edit link https://projections.thriftly.com/p/p_8xSECRETslug/edit"
        "#edit-9LpQ2vR7sT4uW6yA1bC3dE5fG0hJ2kL broke. "
        "Recovery code REC-8x9LpQ2vR7sT4uW. Revenue $426,911, share 6%."
    ),
    "email": "me@example.org",
    "route": "/p/p_8xSECRETslug/edit#edit-9LpQ2vR7sT4uW6yA1bC3dE5fG0hJ2kL",
    "context": {"view_slug": "p_8xSECRETslug", "model_version": "2.0.0"},
}

_FORBIDDEN = [
    "p_8xSECRETslug",
    "9LpQ2vR7sT4uW6yA1bC3dE5fG0hJ2kL",
    "REC-8x9LpQ2vR7sT4uW",
    "me@example.org",
    "$277,990",
    "$426,911",
    "projections.thriftly.com",
]


def test_github_payload_leaks_nothing(client, captured):
    r = client.post("/api/feedback", json=LEAKY)
    assert r.status_code == 201, r.text
    assert len(captured) == 1, "GitHub filer must be invoked once"
    blob = json.dumps(captured[0])
    for leak in _FORBIDDEN:
        assert leak not in blob, f"{leak!r} leaked into the GitHub payload"
    # The support_id IS allowed (it grants nothing).
    assert r.json()["support_id"] in blob


def test_github_issue_url_not_returned_to_client(client, captured):
    r = client.post("/api/feedback", json=LEAKY)
    assert "github_issue_url" not in r.json()


def test_honeypot_silently_drops(client, captured):
    r = client.post(
        "/api/feedback",
        json={"type": "bug", "title": "t", "description": "d", "route": "/", "hp": "i-am-a-bot"},
    )
    assert r.status_code == 201
    assert r.json()["support_id"].startswith("SUP-")
    # No GitHub call, no DB row.
    assert captured == []
    store = list(client.app.dependency_overrides.values())[0]()
    rows = store._conn.execute("SELECT COUNT(*) c FROM feedback").fetchone()
    assert rows["c"] == 0


def test_rate_limit_returns_429_and_no_github_call(client, captured):
    ok = 0
    limited = False
    for _ in range(40):
        r = client.post(
            "/api/feedback",
            json={"type": "bug", "title": "t", "description": "d", "route": "/"},
        )
        if r.status_code == 201:
            ok += 1
        elif r.status_code == 429:
            limited = True
            assert r.headers.get("Retry-After")
            assert r.json()["error"] == "rate_limited"
            break
    assert limited, "expected a 429 after the per-IP cap"
    # GitHub calls only happened for the accepted submissions.
    assert len(captured) == ok


def test_title_and_body_capped(client, captured):
    r = client.post(
        "/api/feedback",
        json={
            "type": "bug",
            "title": "T" * 500,
            "description": "B" * 9000,
            "route": "/",
        },
    )
    assert r.status_code == 201
    payload = captured[0]
    assert len(payload["title"]) <= 200
    assert len(payload["body"]) <= 4100

"""Epic F (#265) — live GitHub-issue filing for /api/feedback.

`file_github_issue()` was a stub that returned None after its env guard, so the
Idea/App-suggestion button persisted feedback but never opened a GitHub issue.
These tests pin the live behavior with a STUBBED httpx client (NO real GitHub
call, ever — conftest clears the filing creds, and an injected MockTransport
serves every response):

  * a clean issue is POSTed on success and `github_issue_url` is set;
  * the outbound HTTP body carries ONLY the redacted payload (no slug/token/
    link/$/% — redaction confirmed intact at the wire, not just in the dict);
  * owner/repo resolves from GITHUB_REPO ("owner/repo") OR GITHUB_ORG+GITHUB_REPO;
  * the token reads GITHUB_TOKEN OR GH_PAT;
  * a GitHub failure / timeout still yields 201 + null url (never a 500).
"""
import json
import re

import httpx
import pytest
from fastapi.testclient import TestClient

import app.routers.feedback as feedback_mod
from app.main import create_app
from app.ratelimit import reset_rate_limits
from app.store import get_store
from app.store.sqlite import SqliteStore

# Mirror the fuzz suite's leak-class matchers so "redaction intact" is asserted
# against the ACTUAL bytes we hand to httpx, not just the in-router dict.
_LEAK_CLASSES = {
    "money": re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?"),
    "percent": re.compile(r"\b\d+(?:\.\d+)?\s?%"),
    "url": re.compile(r"https?://", re.IGNORECASE),
    "bearer": re.compile(r"\bBearer\b", re.IGNORECASE),
    "hientropy_token": re.compile(
        r"\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{22,}\b"
    ),
    "recovery": re.compile(r"\bREC-[A-Za-z0-9]{6,}\b"),
    "email": re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
}

_LIVE_SLUG = "p_8xKQ9mZ2vR7sT4uW6yA1bC3"
_OWNER_TOKEN = "9LpQ2vR7sT4uW6yA1bC3dE5fG0hJ2kL4mN6pQ8rS0tU"
_RESOLVABLE_URL = f"https://projections.thriftly.com/p/{_LIVE_SLUG}/edit#edit-7sT4uW"
_OWNER_EMAIL = "treasurer@hopechurch.org"


def _assert_no_leaks(blob: str) -> None:
    for name, rx in _LEAK_CLASSES.items():
        m = rx.search(blob)
        assert m is None, f"leak-class {name!r} matched {m.group(0)!r}; blob={blob!r}"
    for lit in (_LIVE_SLUG, _OWNER_TOKEN, _OWNER_EMAIL):
        assert lit not in blob, f"literal leak {lit!r} survived; blob={blob!r}"


@pytest.fixture()
def client():
    reset_rate_limits()
    store = SqliteStore(":memory:")
    store.migrate()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app), store


def _stub_client(captured, *, html_url, status=201, raise_exc=None):
    """A factory returning an httpx.Client wired to a MockTransport (no egress)."""

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if raise_exc is not None:
            raise raise_exc
        return httpx.Response(status, json={"html_url": html_url, "number": 123})

    return lambda: httpx.Client(transport=httpx.MockTransport(handler))


# --- owner/repo + token resolution -------------------------------------------
def test_resolve_owner_repo_accepts_owner_slash_repo(monkeypatch):
    monkeypatch.setenv("GITHUB_REPO", "rallytasks/projections")
    assert feedback_mod._resolve_owner_repo() == "rallytasks/projections"


def test_resolve_owner_repo_combines_org_and_repo(monkeypatch):
    monkeypatch.setenv("GITHUB_ORG", "rallytasks")
    monkeypatch.setenv("GITHUB_REPO", "projections")
    assert feedback_mod._resolve_owner_repo() == "rallytasks/projections"


def test_resolve_owner_repo_unset_is_none():
    assert feedback_mod._resolve_owner_repo() is None


# --- success path -------------------------------------------------------------
def test_clean_issue_posted_on_success(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_testtoken")
    monkeypatch.setenv("GITHUB_REPO", "rallytasks/projections")
    captured: list[httpx.Request] = []
    url = "https://github.com/rallytasks/projections/issues/777"

    payload = {
        "support_id": "SUP-ABC234",
        "type": "idea",
        "title": "dark mode please",
        "body": "Add a dark mode toggle to the dashboard.",
        "context": {
            "route": "/p/:slug/edit",
            "app_version": "deadbeef",
            "model_version": "2.1.0",
            "type": "idea",
            "ts": "2026-06-28T00:00:00Z",
        },
    }
    out = feedback_mod.file_github_issue(
        payload, _client_factory=_stub_client(captured, html_url=url)
    )
    assert out == url
    assert len(captured) == 1
    req = captured[0]
    assert req.method == "POST"
    assert str(req.url) == "https://api.github.com/repos/rallytasks/projections/issues"
    assert req.headers["authorization"] == "Bearer ghp_testtoken"
    sent = json.loads(req.content)
    # Title from support_id + type; body carries support_id + safe context + desc.
    assert "SUP-ABC234" in sent["title"]
    assert "idea" in sent["title"].lower()
    assert "SUP-ABC234" in sent["body"]
    assert "Add a dark mode toggle" in sent["body"]
    assert "2.1.0" in sent["body"]
    assert sent["labels"]  # at least one label applied
    assert "app-suggestion" in sent["labels"]


def test_token_falls_back_to_gh_pat(monkeypatch):
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setenv("GH_PAT", "ghp_via_pat")
    monkeypatch.setenv("GITHUB_ORG", "rallytasks")
    monkeypatch.setenv("GITHUB_REPO", "projections")
    captured: list[httpx.Request] = []
    out = feedback_mod.file_github_issue(
        {
            "support_id": "SUP-AAA222", "type": "bug", "title": "t", "body": "b",
            "context": {
                "route": "/", "app_version": "x", "model_version": "y",
                "type": "bug", "ts": "t",
            },
        },
        _client_factory=_stub_client(
            captured, html_url="https://github.com/o/r/issues/1"
        ),
    )
    assert out == "https://github.com/o/r/issues/1"
    assert captured[0].headers["authorization"] == "Bearer ghp_via_pat"
    assert (
        str(captured[0].url)
        == "https://api.github.com/repos/rallytasks/projections/issues"
    )


# --- graceful degrade ---------------------------------------------------------
def test_unset_creds_returns_none_without_calling():
    captured: list[httpx.Request] = []
    out = feedback_mod.file_github_issue(
        {
            "support_id": "SUP-NOENV", "type": "bug", "title": "t", "body": "b",
            "context": {},
        },
        _client_factory=_stub_client(captured, html_url="x"),
    )
    assert out is None
    assert captured == []  # never built a client / never called GitHub


def test_github_5xx_yields_none(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_x")
    monkeypatch.setenv("GITHUB_REPO", "rallytasks/projections")
    captured: list[httpx.Request] = []
    out = feedback_mod.file_github_issue(
        {
            "support_id": "SUP-FAIL00", "type": "bug", "title": "t", "body": "b",
            "context": {},
        },
        _client_factory=_stub_client(captured, html_url="x", status=500),
    )
    assert out is None
    assert len(captured) == 1  # it tried, then degraded on the 5xx


def test_github_timeout_yields_none(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_x")
    monkeypatch.setenv("GITHUB_REPO", "rallytasks/projections")
    captured: list[httpx.Request] = []
    out = feedback_mod.file_github_issue(
        {
            "support_id": "SUP-TMO000", "type": "bug", "title": "t", "body": "b",
            "context": {},
        },
        _client_factory=_stub_client(
            captured, html_url="x", raise_exc=httpx.TimeoutException("slow")
        ),
    )
    assert out is None


# --- end-to-end through the endpoint -----------------------------------------
def test_endpoint_files_issue_and_persists_url(client, monkeypatch):
    tc, store = client
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_endpoint")
    monkeypatch.setenv("GITHUB_ORG", "rallytasks")
    monkeypatch.setenv("GITHUB_REPO", "projections")
    captured: list[httpx.Request] = []
    url = "https://github.com/rallytasks/projections/issues/900"
    monkeypatch.setattr(
        feedback_mod, "_default_client", _stub_client(captured, html_url=url)
    )

    r = tc.post(
        "/api/feedback",
        json={
            "type": "idea",
            "title": "marker off",
            "description": "The chart marker is off by one month.",
            "route": "/p/example/edit",
        },
        headers={"x-forwarded-for": "203.0.113.20"},
    )
    assert r.status_code == 201, r.text
    sid = r.json()["support_id"]
    assert "github_issue_url" not in r.json()  # never returned to the client
    assert len(captured) == 1
    # Outbound bytes are clean (redaction intact at the wire).
    _assert_no_leaks(captured[0].content.decode())
    row = store._conn.execute(
        "SELECT github_issue_url FROM feedback WHERE support_id = ?", (sid,)
    ).fetchone()
    assert row["github_issue_url"] == url


def test_endpoint_redaction_intact_on_leaky_input(client, monkeypatch):
    tc, store = client
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_endpoint")
    monkeypatch.setenv("GITHUB_REPO", "rallytasks/projections")
    captured: list[httpx.Request] = []
    monkeypatch.setattr(
        feedback_mod,
        "_default_client",
        _stub_client(captured, html_url="https://github.com/o/r/issues/1"),
    )

    r = tc.post(
        "/api/feedback",
        json={
            "type": "bug",
            "title": f"broken near {_OWNER_TOKEN}",
            "description": (
                f"see {_RESOLVABLE_URL} email {_OWNER_EMAIL} capital $277,990 share 6.0%"
            ),
            "route": f"/p/{_LIVE_SLUG}/edit#edit-secret",
            "context": {"view_slug": _LIVE_SLUG},
        },
        headers={"x-forwarded-for": "203.0.113.21"},
    )
    assert r.status_code == 201, r.text
    assert len(captured) == 1
    _assert_no_leaks(captured[0].content.decode())


def test_endpoint_still_201_when_github_down(client, monkeypatch):
    tc, store = client
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_endpoint")
    monkeypatch.setenv("GITHUB_REPO", "rallytasks/projections")
    captured: list[httpx.Request] = []
    monkeypatch.setattr(
        feedback_mod,
        "_default_client",
        _stub_client(captured, html_url="x", raise_exc=httpx.ConnectError("down")),
    )

    r = tc.post(
        "/api/feedback",
        json={"type": "idea", "description": "Add CSV export."},
        headers={"x-forwarded-for": "203.0.113.22"},
    )
    assert r.status_code == 201, r.text  # GitHub outage NEVER 500s the user
    sid = r.json()["support_id"]
    row = store._conn.execute(
        "SELECT github_issue_url FROM feedback WHERE support_id = ?", (sid,)
    ).fetchone()
    assert row["github_issue_url"] is None  # persisted with null url

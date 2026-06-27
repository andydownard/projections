"""M0 smoke test — the app boots and serves /api/health (API_SPEC §10).

Written RED first (TDD Iron Law, CLAUDE.md §2). It asserts the health endpoint
returns the API_SPEC-shaped payload AND that the security headers (CSP / CORS /
noindex / HSTS) are present on every response (M0.5).
"""
import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    # Dev/test is permissive (SECURITY.md §4): no required secrets needed to boot.
    monkeypatch.setenv("APP_ENV", "test")
    from app.main import create_app

    return TestClient(create_app())


def test_health_returns_api_spec_shape(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    # API_SPEC §10 response shape.
    assert body["status"] == "ok"
    assert "build_sha" in body
    assert body["model_version"] == "2.3.0"
    assert "db" in body
    assert "litestream" in body


def test_security_headers_present_on_every_response(client):
    resp = client.get("/api/health")
    # M0.5 / SECURITY.md §8 — enforcing CSP, noindex, locked CORS, HSTS.
    csp = resp.headers.get("content-security-policy", "")
    assert "default-src 'self'" in csp
    assert "object-src 'none'" in csp
    assert "frame-ancestors 'none'" in csp
    assert "'unsafe-inline'" not in csp
    assert resp.headers.get("x-robots-tag") == "noindex, nofollow"
    assert "max-age=" in resp.headers.get("strict-transport-security", "")


def test_csp_connect_src_is_self_only(client):
    # #167 — all AI is server-proxied (hard rule 7); the browser only ever calls the
    # app's own /penny endpoint, never a provider. So connect-src must NOT list the
    # provider origins — they were needless post-XSS exfil / SSRF-pivot surface.
    resp = client.get("/api/health")
    csp = resp.headers.get("content-security-policy", "")
    assert "connect-src 'self'" in csp
    assert "api.anthropic.com" not in csp
    assert "api.openai.com" not in csp


def test_robots_disallow_all(client):
    resp = client.get("/robots.txt")
    assert resp.status_code == 200
    assert "Disallow: /" in resp.text

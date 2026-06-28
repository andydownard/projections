"""POST /api/research — location-grounded market rent (app/routers/research.py).

Adversarial M3 invariants, all with stubbed providers / fetchers (no network, no
key): AI-off labeled benchmark, unfetched-citation rejection at the router, a
provider outage degrading to the benchmark, the location+size+basis cache, the
per-IP rate limit, and no key/secret in any response.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import ratelimit
from app.research.provider import RentProviderError
from app.research.snippets import Snippet
from app.routers import research as research_router

LOCATION = {
    "geography_name": "Longview city",
    "formatted_address": "Longview, TX, USA",
}


def _fetched_snippet(url="https://www.loopnet.com/longview"):
    return Snippet(
        url=url, title="Longview retail", text="NNN asking rent $11.00/sq ft",
        fetch_date="2026-06-01", source_date="2026-05", source_tier="listing")


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    # AI OFF by default (all provider keys unset) unless a test opts in.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("AI_DISABLED", raising=False)
    research_router.reset_research_cache()
    ratelimit.reset_rate_limits()
    from app.main import create_app

    return TestClient(create_app())


def test_ai_off_returns_labeled_regional_benchmark(client):
    r = client.post("/api/research",
                    json={"building_sqft": "10000", "location": LOCATION})
    assert r.status_code == 200
    body = r.json()
    assert body["ai_enabled"] is False
    # The benchmark pins the $12/sq ft golden-parity default.
    assert body["rent_per_sqft"] == 12.0
    assert body["confidence"] == "low"
    assert body["verified"] is False
    assert body["provenance"] == "estimated"
    assert body["sources"] == []


def test_response_carries_no_key_or_secret(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-SUPERSECRET")
    # Stub the fetch so the test is hermetic (provider is unwired -> benchmark).
    monkeypatch.setattr(research_router, "build_rent_snippets", lambda *a, **k: [])
    r = client.post("/api/research",
                    json={"building_sqft": "10000", "location": LOCATION})
    text = r.text.lower()
    for marker in ("sk-ant", "supersecret", "api_key", "anthropic_api_key", "authorization"):
        assert marker not in text


def test_ai_on_grounded_extraction_is_verified(client, monkeypatch):
    snip = _fetched_snippet()
    monkeypatch.setattr(research_router, "build_rent_snippets", lambda *a, **k: [snip])

    def fake_provider(prompt, snippets):
        return {
            "estimate": 11.0, "low": 9.0, "high": 13.0, "rent_type": "nnn",
            "opex": 3.0, "confidence": "high",
            "sources": [{"url": snip.url, "source_date": "2026-05"}],
        }

    monkeypatch.setattr(research_router, "make_rent_provider", lambda: fake_provider)
    body = client.post(
        "/api/research", json={"building_sqft": "10000", "location": LOCATION}).json()
    assert body["ai_enabled"] is True
    assert body["rent_per_sqft"] == 11.0
    assert body["low"] == 9.0 and body["high"] == 13.0
    assert body["verified"] is True
    assert body["provenance"] == "verified"
    assert [s["url"] for s in body["sources"]] == [snip.url]


def test_router_rejects_unfetched_citation(client, monkeypatch):
    snip = _fetched_snippet("https://fetched.example/a")
    monkeypatch.setattr(research_router, "build_rent_snippets", lambda *a, **k: [snip])

    def hallucinating_provider(prompt, snippets):
        return {
            "estimate": 9.0, "low": 7.0, "high": 11.0, "rent_type": "nnn",
            "opex": 2.5, "confidence": "high",
            "sources": [{"url": "https://hallucinated.example/x"}],
        }

    monkeypatch.setattr(research_router, "make_rent_provider", lambda: hallucinating_provider)
    body = client.post(
        "/api/research", json={"building_sqft": "10000", "location": LOCATION}).json()
    # The unfetched citation is dropped; with nothing grounded, it is not "verified".
    assert all("hallucinated" not in s["url"] for s in body["sources"])
    assert body["verified"] is False
    assert body["provenance"] == "estimated"


def test_provider_outage_degrades_to_benchmark(client, monkeypatch):
    snip = _fetched_snippet()
    monkeypatch.setattr(research_router, "build_rent_snippets", lambda *a, **k: [snip])

    def boom(prompt, snippets):
        raise RentProviderError("provider 503")

    monkeypatch.setattr(research_router, "make_rent_provider", lambda: boom)
    body = client.post(
        "/api/research", json={"building_sqft": "10000", "location": LOCATION}).json()
    assert body["rent_per_sqft"] == 12.0  # benchmark fallback, never a 500
    assert body["verified"] is False


def test_cache_hit_short_circuits_the_fetch(client, monkeypatch):
    # AI on (a stub provider) so the SSRF fetch path actually runs and the cache can
    # short-circuit it on the second identical request.
    monkeypatch.setattr(research_router, "make_rent_provider", lambda: (lambda p, s: {}))
    calls = {"n": 0}

    def counting_build(*a, **k):
        calls["n"] += 1
        return []

    monkeypatch.setattr(research_router, "build_rent_snippets", counting_build)
    payload = {"building_sqft": "10000", "location": LOCATION}
    r1 = client.post("/api/research", json=payload).json()
    r2 = client.post("/api/research", json=payload).json()
    assert r1["cached"] is False
    assert r2["cached"] is True
    assert calls["n"] == 1  # second request served from cache; no re-fetch


def test_cache_key_includes_size_and_basis(client, monkeypatch):
    monkeypatch.setattr(research_router, "make_rent_provider", lambda: (lambda p, s: {}))
    monkeypatch.setattr(research_router, "build_rent_snippets", lambda *a, **k: [])
    base = {"location": LOCATION}
    client.post("/api/research", json={**base, "building_sqft": "10000"})
    # A different size is a distinct cache key -> a fresh (uncached) computation.
    r = client.post("/api/research", json={**base, "building_sqft": "20000"})
    assert r.json()["cached"] is False


def test_per_ip_rate_limit_returns_429(client, monkeypatch):
    monkeypatch.setattr(research_router, "_IP_LIMIT", 2)
    monkeypatch.setattr(research_router, "build_rent_snippets", lambda *a, **k: [])
    payload = {"building_sqft": "10000", "location": LOCATION}
    assert client.post("/api/research", json=payload).status_code == 200
    assert client.post("/api/research", json=payload).status_code == 200
    r = client.post("/api/research", json=payload)
    assert r.status_code == 429
    assert "Retry-After" in r.headers
    assert r.json()["error"] == "rate_limited"


def test_per_token_rate_limit_returns_429(client, monkeypatch):
    monkeypatch.setattr(research_router, "_TOKEN_LIMIT", 1)
    monkeypatch.setattr(research_router, "build_rent_snippets", lambda *a, **k: [])
    payload = {"building_sqft": "10000", "location": LOCATION}
    headers = {"Authorization": "Bearer owner-secret-xyz"}
    assert client.post("/api/research", json=payload, headers=headers).status_code == 200
    r = client.post("/api/research", json=payload, headers=headers)
    assert r.status_code == 429
    # The raw token never appears in the 429 body.
    assert "owner-secret-xyz" not in r.text


def test_missing_building_sqft_is_422(client):
    r = client.post("/api/research", json={"location": LOCATION})
    assert r.status_code == 422


def test_location_label_string_is_accepted(client, monkeypatch):
    monkeypatch.setattr(research_router, "build_rent_snippets", lambda *a, **k: [])
    r = client.post("/api/research",
                    json={"building_sqft": "10000", "location_label": "Longview, TX"})
    assert r.status_code == 200
    assert r.json()["rent_per_sqft"] == 12.0


def test_ai_off_skips_the_fetch_entirely(client, monkeypatch):
    # AI off -> snippets would be unused, so the SSRF fetch must NOT run (cost + the
    # network are avoided). If it were called, this would raise and 500 the request.
    def must_not_run(*a, **k):
        raise AssertionError("build_rent_snippets must not run when AI is off")

    monkeypatch.setattr(research_router, "build_rent_snippets", must_not_run)
    r = client.post("/api/research",
                    json={"building_sqft": "10000", "location": LOCATION})
    assert r.status_code == 200
    assert r.json()["ai_enabled"] is False


def test_invalid_basis_normalizes_to_nnn(client, monkeypatch):
    monkeypatch.setattr(research_router, "build_rent_snippets", lambda *a, **k: [])
    r = client.post("/api/research",
                    json={"building_sqft": "10000", "location": LOCATION, "basis": "weird"})
    assert r.status_code == 200
    # Benchmark rent_type is nnn; an unknown basis never leaks through.
    assert r.json()["rent_type"] == "nnn"


def test_response_carries_the_full_prefill_contract(client):
    body = client.post(
        "/api/research", json={"building_sqft": "10000", "location": LOCATION}).json()
    for key in ("rent_per_sqft", "estimate", "low", "high", "rent_type", "opex",
                "basis", "confidence", "verified", "provenance", "sources",
                "ai_enabled", "cached"):
        assert key in body, key


def test_grounded_low_confidence_is_not_verified(client, monkeypatch):
    # A fetched + cited source but the model reports LOW confidence -> estimated, not
    # verified (the badge must not over-claim on a weak source).
    snip = _fetched_snippet()
    monkeypatch.setattr(research_router, "build_rent_snippets", lambda *a, **k: [snip])

    def low_conf_provider(prompt, snippets):
        return {
            "estimate": 10.0, "low": 8.0, "high": 12.0, "rent_type": "nnn",
            "opex": 2.0, "confidence": "low",
            "sources": [{"url": snip.url, "source_date": "2026-05"}],
        }

    monkeypatch.setattr(research_router, "make_rent_provider", lambda: low_conf_provider)
    body = client.post(
        "/api/research", json={"building_sqft": "10000", "location": LOCATION}).json()
    assert body["confidence"] == "low"
    assert body["verified"] is False
    assert body["provenance"] == "estimated"

"""GET /api/metrics — owner/admin-gated rolling counters (M7.7, #95).

OPS_RUNBOOK §6.3: a lightweight, owner/admin-gated metrics surface exposing the
per-provider rolling counters. The gate is a dedicated server-env METRICS_TOKEN
(secrets are server-env only; no fallback chain). When the token is unset the
endpoint does not exist (404 — no info leak); when set, access requires a
constant-time bearer match (401 unauthenticated, 403 wrong token).

Mutation-Safety-style auth assertions: the read is rejected for every caller
that is not the holder of METRICS_TOKEN, the auth check leaks nothing, and the
response never carries a plaintext secret.

RED-first against app/routers/metrics.py.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app import metrics


@pytest.fixture(autouse=True)
def _fresh_metrics():
    metrics.reset()
    yield
    metrics.reset()


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    from app.main import create_app

    return TestClient(create_app())


def test_metrics_disabled_returns_404_when_token_unset(client, monkeypatch):
    monkeypatch.delenv("METRICS_TOKEN", raising=False)
    r = client.get("/api/metrics")
    assert r.status_code == 404


def test_metrics_requires_authorization(client, monkeypatch):
    monkeypatch.setenv("METRICS_TOKEN", "metrics-owner-secret-123")
    r = client.get("/api/metrics")
    assert r.status_code == 401


def test_metrics_rejects_wrong_token(client, monkeypatch):
    monkeypatch.setenv("METRICS_TOKEN", "metrics-owner-secret-123")
    r = client.get("/api/metrics", headers={"Authorization": "Bearer not-the-token"})
    assert r.status_code == 403


def test_metrics_returns_rolling_counters_for_owner(client, monkeypatch):
    monkeypatch.setenv("METRICS_TOKEN", "metrics-owner-secret-123")
    metrics.record_provider_call(metrics.PROVIDER_PLACES, latency_ms=12.0, ok=True)
    metrics.record_provider_call(metrics.PROVIDER_CENSUS, latency_ms=8.0, ok=False)
    metrics.record_llm_usage(
        metrics.PROVIDER_ANTHROPIC, input_tokens=1000, output_tokens=500
    )
    metrics.incr(metrics.COUNTER_NARRATIVE_CACHE_HIT)

    r = client.get(
        "/api/metrics", headers={"Authorization": "Bearer metrics-owner-secret-123"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["providers"][metrics.PROVIDER_PLACES]["calls"] == 1
    assert body["providers"][metrics.PROVIDER_CENSUS]["errors"] == 1
    assert body["providers"][metrics.PROVIDER_ANTHROPIC]["input_tokens"] == 1000
    assert body["counters"][metrics.COUNTER_NARRATIVE_CACHE_HIT] == 1
    assert "llm_cost_usd" in body["totals"]


def test_metrics_is_read_only(client, monkeypatch):
    monkeypatch.setenv("METRICS_TOKEN", "metrics-owner-secret-123")
    r = client.post(
        "/api/metrics", headers={"Authorization": "Bearer metrics-owner-secret-123"}
    )
    assert r.status_code == 405


def test_metrics_response_carries_no_secret(client, monkeypatch):
    monkeypatch.setenv("METRICS_TOKEN", "metrics-owner-secret-123")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-RESPONSE-CANARY-9")
    metrics.record_llm_usage(
        metrics.PROVIDER_ANTHROPIC, input_tokens=10, output_tokens=5
    )
    r = client.get(
        "/api/metrics", headers={"Authorization": "Bearer metrics-owner-secret-123"}
    )
    blob = json.dumps(r.json())
    assert "sk-ant-RESPONSE-CANARY-9" not in blob
    assert "metrics-owner-secret-123" not in blob


def test_metrics_rejects_non_bearer_scheme(client, monkeypatch):
    monkeypatch.setenv("METRICS_TOKEN", "metrics-owner-secret-123")
    r = client.get(
        "/api/metrics",
        headers={"Authorization": "Basic metrics-owner-secret-123"},
    )
    assert r.status_code == 401


def test_metrics_disabled_404_outranks_a_valid_looking_bearer(client, monkeypatch):
    """An unset token wins even when a plausible bearer is presented — the
    endpoint never leaks that it exists."""
    monkeypatch.delenv("METRICS_TOKEN", raising=False)
    r = client.get(
        "/api/metrics", headers={"Authorization": "Bearer anything-at-all"}
    )
    assert r.status_code == 404


def test_metrics_exposes_full_provider_matrix_and_counters(client, monkeypatch):
    monkeypatch.setenv("METRICS_TOKEN", "metrics-owner-secret-123")
    r = client.get(
        "/api/metrics", headers={"Authorization": "Bearer metrics-owner-secret-123"}
    )
    body = r.json()
    assert set(body["providers"]) == set(metrics.PROVIDERS)
    for name in metrics.COUNTERS:
        assert name in body["counters"]
    assert set(body["totals"]) == {
        "llm_input_tokens",
        "llm_output_tokens",
        "llm_cost_usd",
    }

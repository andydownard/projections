"""app/metrics.py — per-provider observability + LLM cost metrics (M7.7, #95).

OPS_RUNBOOK §6.3 / PRD §27: emit structured latency, error rate, and call volume
per external provider (Anthropic, OpenAI, Google Places, US Census, GitHub, CRM)
plus LLM token/cost counters, with a HARD no-secrets-in-metrics invariant.

These are RED-first unit tests against the pure metrics emitter:
  * per-provider matrix: a stubbed call to each provider records latency,
    increments call volume, and increments error count on failure, tagged with
    the correct provider label (one case per provider);
  * LLM token + cost counters surface (server-computed cost, no client math);
  * cost-control verification counters (research/narrative cache hit/miss, the
    narrative regeneration-blocked counter);
  * the no-secrets invariant — neither the snapshot nor a logged provider
    breadcrumb may carry a plaintext token / key / fragment / financial field;
  * AI opt-out: with the AI providers never called (keys unset), no AI-provider
    metrics are emitted, while the non-AI compute path still records.
"""
from __future__ import annotations

import json

import pytest

from app import metrics


@pytest.fixture(autouse=True)
def _fresh_metrics():
    metrics.reset()
    yield
    metrics.reset()


# --------------------------------------------------------------------------- #
# Per-provider emission matrix (latency, volume, error) — one case per provider
# --------------------------------------------------------------------------- #
ALL_PROVIDERS = (
    metrics.PROVIDER_ANTHROPIC,
    metrics.PROVIDER_OPENAI,
    metrics.PROVIDER_PLACES,
    metrics.PROVIDER_CENSUS,
    metrics.PROVIDER_GITHUB,
    metrics.PROVIDER_CRM,
)


@pytest.mark.parametrize("provider", ALL_PROVIDERS)
def test_track_records_latency_and_volume_per_provider(provider):
    """A stubbed successful provider call increments volume and records latency,
    tagged with the right provider label — for every external provider."""
    with metrics.track(provider):
        pass  # a (stubbed) successful upstream call

    snap = metrics.snapshot()["providers"][provider]
    assert snap["calls"] == 1
    assert snap["errors"] == 0
    assert snap["avg_latency_ms"] >= 0.0
    # No other provider was touched.
    others = [p for p in ALL_PROVIDERS if p != provider]
    assert all(metrics.snapshot()["providers"][o]["calls"] == 0 for o in others)


@pytest.mark.parametrize("provider", ALL_PROVIDERS)
def test_track_increments_error_count_on_failure(provider):
    """A provider call that raises increments the error counter AND the call
    volume (an attempt happened), and the exception still propagates."""
    with pytest.raises(RuntimeError):
        with metrics.track(provider):
            raise RuntimeError("upstream down")

    snap = metrics.snapshot()["providers"][provider]
    assert snap["calls"] == 1
    assert snap["errors"] == 1
    assert snap["error_rate"] == 1.0


def test_record_provider_call_accumulates_latency_and_error_rate():
    metrics.record_provider_call(metrics.PROVIDER_PLACES, latency_ms=10.0, ok=True)
    metrics.record_provider_call(metrics.PROVIDER_PLACES, latency_ms=30.0, ok=False)
    snap = metrics.snapshot()["providers"][metrics.PROVIDER_PLACES]
    assert snap["calls"] == 2
    assert snap["errors"] == 1
    assert snap["error_rate"] == 0.5
    assert snap["avg_latency_ms"] == 20.0


# --------------------------------------------------------------------------- #
# LLM token + cost counters (server-computed cost)
# --------------------------------------------------------------------------- #
def test_llm_usage_accumulates_tokens_and_server_computed_cost():
    # Default Anthropic pricing is $5/MTok input, $25/MTok output (Opus-tier).
    metrics.record_llm_usage(
        metrics.PROVIDER_ANTHROPIC, input_tokens=1_000_000, output_tokens=1_000_000
    )
    snap = metrics.snapshot()
    prov = snap["providers"][metrics.PROVIDER_ANTHROPIC]
    assert prov["input_tokens"] == 1_000_000
    assert prov["output_tokens"] == 1_000_000
    # 1M in * $5 + 1M out * $25 = $30.00, computed server-side.
    assert prov["cost_usd"] == pytest.approx(30.0)
    assert snap["totals"]["llm_cost_usd"] == pytest.approx(30.0)


def test_llm_pricing_is_env_overridable(monkeypatch):
    monkeypatch.setenv("LLM_PRICE_ANTHROPIC_INPUT", "10")
    monkeypatch.setenv("LLM_PRICE_ANTHROPIC_OUTPUT", "40")
    cost = metrics.cost_usd(
        metrics.PROVIDER_ANTHROPIC, input_tokens=1_000_000, output_tokens=1_000_000
    )
    assert cost == pytest.approx(50.0)


def test_estimate_tokens_is_a_bounded_heuristic():
    assert metrics.estimate_tokens("") == 0
    assert metrics.estimate_tokens("a" * 400) == 100


# --------------------------------------------------------------------------- #
# Cost-control verification counters (research/narrative caching, regen cap)
# --------------------------------------------------------------------------- #
def test_cache_and_regen_counters_increment():
    metrics.incr(metrics.COUNTER_RESEARCH_CACHE_HIT)
    metrics.incr(metrics.COUNTER_RESEARCH_CACHE_HIT)
    metrics.incr(metrics.COUNTER_RESEARCH_CACHE_MISS)
    metrics.incr(metrics.COUNTER_NARRATIVE_REGEN_BLOCKED, 3)
    counters = metrics.snapshot()["counters"]
    assert counters[metrics.COUNTER_RESEARCH_CACHE_HIT] == 2
    assert counters[metrics.COUNTER_RESEARCH_CACHE_MISS] == 1
    assert counters[metrics.COUNTER_NARRATIVE_REGEN_BLOCKED] == 3


# --------------------------------------------------------------------------- #
# No-secrets invariant
# --------------------------------------------------------------------------- #
def test_scrub_removes_tokens_keys_and_financial_fields(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-SUPERSECRETKEY12345abcdef")
    leaky = (
        "Authorization: Bearer 8x9LpQ2vR7sT4uW6yA1bC3dE5fG0hJ2kL "
        "key=sk-ant-SUPERSECRETKEY12345abcdef capital=$277,990 share=11.0%"
    )
    out = metrics.scrub(leaky)
    assert "8x9LpQ2vR7sT4uW6yA1bC3dE5fG0hJ2kL" not in out
    assert "sk-ant-SUPERSECRETKEY12345abcdef" not in out
    assert "$277,990" not in out
    assert "11.0%" not in out
    assert "[redacted]" in out


def test_scrub_walks_nested_structures(monkeypatch):
    monkeypatch.setenv("GOOGLE_PLACES_API_KEY", "AIzaPLACESKEYdonotleak0001")
    payload = {
        "provider": "google_places",
        "url": "https://maps.googleapis.com/x?key=AIzaPLACESKEYdonotleak0001",
        "nested": ["Bearer tok_ABCDEF123456GHIJKL789", {"amount": "$42,000"}],
    }
    out = metrics.scrub(payload)
    blob = json.dumps(out)
    assert "AIzaPLACESKEYdonotleak0001" not in blob
    assert "tok_ABCDEF123456GHIJKL789" not in blob
    assert "$42,000" not in blob
    # The benign provider label survives.
    assert out["provider"] == "google_places"


def test_snapshot_carries_no_plaintext_secret(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-LEAKCANARY-0001")
    metrics.record_provider_call(metrics.PROVIDER_ANTHROPIC, latency_ms=5.0, ok=True)
    metrics.record_llm_usage(
        metrics.PROVIDER_ANTHROPIC, input_tokens=100, output_tokens=50
    )
    blob = json.dumps(metrics.snapshot())
    assert "sk-ant-LEAKCANARY-0001" not in blob
    assert "Bearer" not in blob
    assert "$" not in blob  # no financial display strings in metrics


def test_log_event_scrubs_secret_breadcrumb(monkeypatch, caplog):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-CANARY-7777")
    with caplog.at_level("INFO", logger="app.metrics"):
        metrics.log_event(
            metrics.PROVIDER_OPENAI,
            "call",
            authorization="Bearer sk-openai-CANARY-7777",
            ok=True,
        )
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "sk-openai-CANARY-7777" not in logged
    assert metrics.PROVIDER_OPENAI in logged


def test_log_event_never_raises_without_sentry():
    # Best-effort breadcrumb: absence of sentry_sdk must not break the call path.
    metrics.log_event(metrics.PROVIDER_CENSUS, "call", latency_ms=12.0, ok=True)


# --------------------------------------------------------------------------- #
# AI opt-out interaction (M5.5): keys unset -> no AI-provider metrics emitted
# --------------------------------------------------------------------------- #
def test_ai_opt_out_emits_no_ai_provider_metrics(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    # The keyless compute path still hits the non-AI providers...
    with metrics.track(metrics.PROVIDER_PLACES):
        pass
    with metrics.track(metrics.PROVIDER_CENSUS):
        pass
    snap = metrics.snapshot()["providers"]
    assert snap[metrics.PROVIDER_PLACES]["calls"] == 1
    assert snap[metrics.PROVIDER_CENSUS]["calls"] == 1
    # ...but no AI provider was ever called, so no AI metric is emitted.
    assert snap[metrics.PROVIDER_ANTHROPIC]["calls"] == 0
    assert snap[metrics.PROVIDER_OPENAI]["calls"] == 0
    assert metrics.snapshot()["totals"]["llm_cost_usd"] == 0.0


def test_snapshot_always_exposes_the_full_provider_matrix():
    providers = metrics.snapshot()["providers"]
    assert set(providers) == set(ALL_PROVIDERS)
    for label in ALL_PROVIDERS:
        assert set(providers[label]) >= {
            "calls",
            "errors",
            "error_rate",
            "avg_latency_ms",
            "input_tokens",
            "output_tokens",
            "cost_usd",
        }


# --------------------------------------------------------------------------- #
# Latency / volume edge cases
# --------------------------------------------------------------------------- #
def test_track_records_latency_even_on_error():
    """The latency of a failed call is still recorded (an attempt happened)."""
    with pytest.raises(ValueError):
        with metrics.track(metrics.PROVIDER_GITHUB):
            raise ValueError("boom")
    snap = metrics.snapshot()["providers"][metrics.PROVIDER_GITHUB]
    assert snap["calls"] == 1
    assert snap["avg_latency_ms"] >= 0.0


def test_track_custom_event_label_reaches_the_breadcrumb(caplog):
    with caplog.at_level("INFO", logger="app.metrics"):
        with metrics.track(metrics.PROVIDER_CRM, event="crm_sync"):
            pass
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "crm_sync" in logged
    assert metrics.PROVIDER_CRM in logged


def test_providers_constant_is_the_full_canonical_set():
    assert set(metrics.PROVIDERS) == set(ALL_PROVIDERS)
    assert set(metrics.LLM_PROVIDERS) == {
        metrics.PROVIDER_ANTHROPIC,
        metrics.PROVIDER_OPENAI,
    }


# --------------------------------------------------------------------------- #
# Token + cost counters — both AI providers, env override, explicit cost
# --------------------------------------------------------------------------- #
def test_openai_default_pricing_is_distinct_from_anthropic():
    # Default OpenAI pricing is $2.50/MTok input, $10/MTok output.
    cost = metrics.cost_usd(
        metrics.PROVIDER_OPENAI, input_tokens=1_000_000, output_tokens=1_000_000
    )
    assert cost == pytest.approx(12.5)


def test_openai_pricing_is_env_overridable(monkeypatch):
    monkeypatch.setenv("LLM_PRICE_OPENAI_INPUT", "1")
    monkeypatch.setenv("LLM_PRICE_OPENAI_OUTPUT", "2")
    cost = metrics.cost_usd(
        metrics.PROVIDER_OPENAI, input_tokens=2_000_000, output_tokens=1_000_000
    )
    assert cost == pytest.approx(4.0)


def test_record_llm_usage_accepts_an_explicit_provider_reported_cost():
    metrics.record_llm_usage(
        metrics.PROVIDER_ANTHROPIC, input_tokens=10, output_tokens=5, cost_usd=0.99
    )
    prov = metrics.snapshot()["providers"][metrics.PROVIDER_ANTHROPIC]
    assert prov["cost_usd"] == pytest.approx(0.99)


def test_totals_aggregate_cost_across_both_ai_providers():
    metrics.record_llm_usage(
        metrics.PROVIDER_ANTHROPIC, input_tokens=1_000_000, output_tokens=0
    )  # $5
    metrics.record_llm_usage(
        metrics.PROVIDER_OPENAI, input_tokens=0, output_tokens=1_000_000
    )  # $10
    totals = metrics.snapshot()["totals"]
    assert totals["llm_input_tokens"] == 1_000_000
    assert totals["llm_output_tokens"] == 1_000_000
    assert totals["llm_cost_usd"] == pytest.approx(15.0)


def test_incr_defaults_to_one_and_accumulates():
    metrics.incr(metrics.COUNTER_NARRATIVE_CACHE_HIT)
    metrics.incr(metrics.COUNTER_NARRATIVE_CACHE_HIT)
    assert (
        metrics.snapshot()["counters"][metrics.COUNTER_NARRATIVE_CACHE_HIT] == 2
    )


def test_snapshot_counters_include_every_canonical_name_at_zero():
    counters = metrics.snapshot()["counters"]
    for name in metrics.COUNTERS:
        assert counters[name] == 0


# --------------------------------------------------------------------------- #
# Scrub — additional shapes and non-secret pass-through
# --------------------------------------------------------------------------- #
def test_scrub_redacts_github_and_crm_key_shapes():
    leaky = "token=ghp_ABCDEFGHIJKLMNOP012345 pat=github_pat_11ABCDE_fghij67890"
    out = metrics.scrub(leaky)
    assert "ghp_ABCDEFGHIJKLMNOP012345" not in out
    assert "github_pat_11ABCDE_fghij67890" not in out


def test_scrub_preserves_non_secret_scalars_and_short_labels():
    assert metrics.scrub(42) == 42
    assert metrics.scrub(0.5) == 0.5
    assert metrics.scrub(None) is None
    assert metrics.scrub(True) is True
    # Benign provider labels and short words survive untouched.
    assert metrics.scrub("google_places") == "google_places"
    assert metrics.scrub("call") == "call"


def test_log_event_carries_provider_event_and_safe_fields(caplog):
    with caplog.at_level("INFO", logger="app.metrics"):
        metrics.log_event(
            metrics.PROVIDER_PLACES, "call", latency_ms=12.5, ok=True
        )
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert metrics.PROVIDER_PLACES in logged
    assert "latency_ms" in logged


# --------------------------------------------------------------------------- #
# Registry mechanics — reset, rounding, unpriced provider, concurrency
# --------------------------------------------------------------------------- #
def test_reset_clears_all_counters():
    metrics.record_provider_call(metrics.PROVIDER_PLACES, latency_ms=5.0, ok=False)
    metrics.record_llm_usage(
        metrics.PROVIDER_ANTHROPIC, input_tokens=100, output_tokens=10
    )
    metrics.incr(metrics.COUNTER_RESEARCH_CACHE_HIT)
    metrics.reset()
    snap = metrics.snapshot()
    assert snap["providers"][metrics.PROVIDER_PLACES]["calls"] == 0
    assert snap["totals"]["llm_cost_usd"] == 0.0
    assert snap["counters"][metrics.COUNTER_RESEARCH_CACHE_HIT] == 0


def test_avg_latency_is_rounded_to_three_places():
    metrics.record_provider_call(metrics.PROVIDER_CENSUS, latency_ms=1.0, ok=True)
    metrics.record_provider_call(metrics.PROVIDER_CENSUS, latency_ms=2.0, ok=True)
    # mean of 1 and 2 = 1.5 exactly; the contract is a clean rounded float.
    assert metrics.snapshot()["providers"][metrics.PROVIDER_CENSUS][
        "avg_latency_ms"
    ] == 1.5


def test_cost_for_an_unpriced_provider_is_zero():
    # Non-LLM providers have no pricing row -> cost is zero, never a KeyError.
    assert metrics.cost_usd(
        metrics.PROVIDER_PLACES, input_tokens=1_000_000, output_tokens=1_000_000
    ) == 0.0


def test_record_provider_call_is_thread_safe():
    import threading

    def worker():
        for _ in range(200):
            metrics.record_provider_call(
                metrics.PROVIDER_GITHUB, latency_ms=1.0, ok=True
            )

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # 8 threads * 200 increments, no lost updates under the lock.
    assert metrics.snapshot()["providers"][metrics.PROVIDER_GITHUB]["calls"] == 1600

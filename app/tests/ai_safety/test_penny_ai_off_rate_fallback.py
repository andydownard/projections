"""PE11 §11 — AI-off / rate / fallback (CI-blocking; issue #130, extends N12).

Invariant: *``ai_opt_out`` → zero provider calls (→ 409); both providers down → 503;
LLM bucket rate-limit → 429 ``retry_after_seconds``; a provider parse-failure degrades
to a plain answer, never a 500.* These are pinned on the **Penny loop + provider chain**
(PE3) with **stubbed transports** — no real ``api.anthropic.com`` / ``api.openai.com``
call ever happens (the ``_no_real_network`` autouse guard would raise on one).

The loop raises typed errors that PE5's router maps to HTTP status:
``AIDisabledError`` → 409, ``AIUnavailableError`` → 503, ``RateLimitedError`` → 429.
"""
from __future__ import annotations

import pytest

from app.aisafety import ai_disabled, ai_keys_present
from app.penny.loop import AIDisabledError, RateLimitedError, run_turn
from app.penny.providers import AIUnavailableError, build_provider_chain
from app.penny.tools import build_registry

from .harness import (
    ScriptedChain,
    anthropic_text_payload,
    make_ctx,
    openai_text_payload,
    stub_transport,
    text_resp,
)


def _registry(store):
    return build_registry(store)


# ----------------------------------------------------- AI opt-out → zero calls (409)
def test_ai_opt_out_makes_zero_provider_calls(store, projection):
    chain = ScriptedChain(text_resp("never"))
    with pytest.raises(AIDisabledError):
        run_turn(
            user_message="hi",
            chain=chain,
            registry=_registry(store),
            context=make_ctx(projection),
            ai_disabled=True,
        )
    assert chain.calls == []  # not one provider call was made


def test_no_api_key_means_empty_chain_and_zero_calls(store, projection):
    """With AI keys unset the chain is empty → the loop is AI-disabled, zero calls."""
    chain = build_provider_chain(env={}, transport=stub_transport(lambda u, b: (200, {})))
    assert chain.providers == []
    with pytest.raises(AIDisabledError):
        run_turn(
            user_message="hi",
            chain=chain,
            registry=_registry(store),
            context=make_ctx(projection),
        )


def test_ai_opt_out_flag_forces_disabled_even_with_a_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert ai_keys_present() is True
    # the per-projection opt-out flag short-circuits regardless of keys
    assert ai_disabled({"ai_opt_out": 1}) is True
    assert ai_disabled({"ai_opt_out": 0}) is False


def test_ai_disabled_with_all_keys_unset(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("AI_DISABLED", raising=False)
    assert ai_keys_present() is False
    assert ai_disabled(None) is True  # no key configured ⇒ AI off


# ---------------------------------------------------- both providers down → 503
def test_both_providers_down_surfaces_ai_unavailable_not_500(store, projection):
    transport = stub_transport(lambda url, body: (503, {}))  # every provider 503s
    chain = build_provider_chain(
        env={"ANTHROPIC_API_KEY": "a", "OPENAI_API_KEY": "b"}, transport=transport
    )
    with pytest.raises(AIUnavailableError):
        run_turn(
            user_message="hi",
            chain=chain,
            registry=_registry(store),
            context=make_ctx(projection),
        )
    # the chain went through the injected STUB (both providers tried), not the network
    assert len(transport.calls) == 2
    assert any("anthropic" in c["url"] for c in transport.calls)
    assert any("openai" in c["url"] for c in transport.calls)


# ------------------------------------------------------ rate limit → 429 retry_after
def test_rate_limit_surfaces_429_with_retry_after_and_zero_calls(store, projection):
    chain = ScriptedChain(text_resp("never"))
    with pytest.raises(RateLimitedError) as exc:
        run_turn(
            user_message="hi",
            chain=chain,
            registry=_registry(store),
            context=make_ctx(projection),
            rate_limiter=lambda: (False, 37),
        )
    assert exc.value.retry_after_seconds == 37
    assert chain.calls == []  # 429 surfaces BEFORE any provider work


# ------------------------------------------------ parse failure degrades, never 500
def test_provider_parse_failure_degrades_to_plain_answer(store, projection):
    # a 200 with a body the Anthropic parser cannot read → degrade (no raise).
    transport = stub_transport(lambda url, body: (200, {"unexpected": "shape"}))
    chain = build_provider_chain(env={"ANTHROPIC_API_KEY": "a"}, transport=transport)
    res = run_turn(
        user_message="hi",
        chain=chain,
        registry=_registry(store),
        context=make_ctx(projection),
    )
    assert res.stop_reason == "parse_degraded"
    assert res.final_text  # a plain answer, not an exception / 500
    assert res.provider == "anthropic"


# --------------------------------------------- fallback flips disclosure to actual provider
def test_fallback_to_openai_reports_the_actual_provider(store, projection):
    def router(url, body):
        if "anthropic" in url:
            return 503, {}  # primary unavailable
        return 200, openai_text_payload("Hi from the fallback.")

    transport = stub_transport(router)
    chain = build_provider_chain(
        env={"ANTHROPIC_API_KEY": "a", "OPENAI_API_KEY": "b"}, transport=transport
    )
    res = run_turn(
        user_message="hi",
        chain=chain,
        registry=_registry(store),
        context=make_ctx(projection),
    )
    # disclosure reflects the provider that ACTUALLY answered (N12 invariant 8).
    assert res.provider == "openai"
    assert res.final_text == "Hi from the fallback."
    # both providers were tried through the stub (anthropic 503 → openai 200).
    assert any("anthropic" in c["url"] for c in transport.calls)
    assert any("openai" in c["url"] for c in transport.calls)


def test_primary_anthropic_answers_when_available(store, projection):
    """Positive control: the primary answers and is disclosed as anthropic."""
    transport = stub_transport(lambda url, body: (200, anthropic_text_payload("Hi from primary.")))
    chain = build_provider_chain(
        env={"ANTHROPIC_API_KEY": "a", "OPENAI_API_KEY": "b"}, transport=transport
    )
    res = run_turn(
        user_message="hi",
        chain=chain,
        registry=_registry(store),
        context=make_ctx(projection),
    )
    assert res.provider == "anthropic"
    assert res.final_text == "Hi from primary."
    # the fallback was never consulted (primary pinned on first success).
    assert all("anthropic" in c["url"] for c in transport.calls)

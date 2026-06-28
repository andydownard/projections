"""Rent-extraction provider seam (app/research/provider.py).

Anthropic primary → OpenAI fallback, keys read at call time, AI-disabled-safe. The
SDK seams are injected as deterministic stubs so the suite is hermetic (no network,
no key required for the AI-off path).
"""
from __future__ import annotations

import pytest

from app.research import provider as prov


def _clear_ai(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("AI_DISABLED", raising=False)


def test_no_keys_returns_none(monkeypatch):
    _clear_ai(monkeypatch)
    assert prov.make_rent_provider() is None


def test_kill_switch_returns_none_even_with_a_key(monkeypatch):
    _clear_ai(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-anthropic-xxx")
    monkeypatch.setenv("AI_DISABLED", "1")
    assert prov.make_rent_provider() is None


def test_anthropic_is_primary(monkeypatch):
    _clear_ai(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-a")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-o")
    provider = prov.make_rent_provider(
        anthropic=lambda p, s: {"estimate": 9.0, "via": "anthropic"},
        openai=lambda p, s: {"estimate": 1.0, "via": "openai"},
    )
    assert provider("prompt", [])["via"] == "anthropic"


def test_openai_fallback_when_anthropic_raises(monkeypatch):
    _clear_ai(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-a")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-o")

    def down(p, s):
        raise RuntimeError("anthropic 529 overloaded")

    provider = prov.make_rent_provider(
        anthropic=down, openai=lambda p, s: {"estimate": 1.0, "via": "openai"})
    assert provider("prompt", [])["via"] == "openai"


def test_openai_only_when_only_openai_keyed(monkeypatch):
    _clear_ai(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-o")
    provider = prov.make_rent_provider(openai=lambda p, s: {"via": "openai"})
    assert provider("prompt", [])["via"] == "openai"


def test_all_providers_failing_raises_provider_error(monkeypatch):
    _clear_ai(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-a")

    def down(p, s):
        raise RuntimeError("down")

    provider = prov.make_rent_provider(anthropic=down)
    with pytest.raises(prov.RentProviderError):
        provider("prompt", [])


def test_unwired_default_seams_raise_provider_error(monkeypatch):
    # Keys present but no SDK wired (default seams) -> RentProviderError, which the
    # router degrades to the labeled benchmark. The model never invents a number.
    _clear_ai(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-a")
    provider = prov.make_rent_provider()
    assert provider is not None
    with pytest.raises(prov.RentProviderError):
        provider("prompt", [])


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "Yes"])
def test_kill_switch_truthy_values_disable(monkeypatch, value):
    _clear_ai(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-a")
    monkeypatch.setenv("AI_DISABLED", value)
    assert prov.make_rent_provider() is None


@pytest.mark.parametrize("value", ["0", "false", "no", ""])
def test_kill_switch_falsey_values_do_not_disable(monkeypatch, value):
    _clear_ai(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-a")
    monkeypatch.setenv("AI_DISABLED", value)
    provider = prov.make_rent_provider(anthropic=lambda p, s: {"via": "anthropic"})
    assert provider is not None
    assert provider("p", [])["via"] == "anthropic"


def test_provider_passes_prompt_and_snippets_through(monkeypatch):
    _clear_ai(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-a")
    seen = {}

    def capture(prompt, snippets):
        seen["prompt"] = prompt
        seen["snippets"] = snippets
        return {"estimate": 9.0}

    provider = prov.make_rent_provider(anthropic=capture)
    out = provider("the-prompt", ["s1", "s2"])
    assert out == {"estimate": 9.0}
    assert seen["prompt"] == "the-prompt"
    assert seen["snippets"] == ["s1", "s2"]


def test_anthropic_unkeyed_falls_through_to_openai(monkeypatch):
    # Only OpenAI keyed: Anthropic is not even in the chain (not just failing).
    _clear_ai(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-o")
    calls = {"anthropic": 0}

    def anthropic(p, s):
        calls["anthropic"] += 1
        return {"via": "anthropic"}

    provider = prov.make_rent_provider(
        anthropic=anthropic, openai=lambda p, s: {"via": "openai"})
    assert provider("p", [])["via"] == "openai"
    assert calls["anthropic"] == 0  # unkeyed provider is never called

"""app/research/provider.py — rent-extraction provider seam (PRD §16/§21).

The injectable ``extract.py`` ``Provider`` for market-rent extraction, with the
SAME failover contract as ``app/narrative_provider.py``: **Anthropic primary →
OpenAI fallback**, keys read at CALL TIME (never cached at import — SECURITY.md §4,
no fallback chains), and the live SDK wiring landing behind thin monkeypatchable
seams so the suite runs hermetically with all AI keys unset.

A provider returns the ``extract.py`` shape ``{estimate, low, high, rent_type,
opex, confidence, sources[]}`` — but EVERY number must come from the server-fetched
snippets; ``extract_rent`` validates the citations after the call and forces low
confidence on anything ungrounded. The model is never a source of truth, only an
extractor.

``make_rent_provider()`` returns ``None`` when AI is disabled (the ``AI_DISABLED``
kill switch, or no provider key configured) so ``extract_rent`` falls back to the
labeled regional benchmark at low confidence — the AI-opt-out path, off the compute
hot path and safe end-to-end.
"""
from __future__ import annotations

import os
from typing import Callable

# Provider(prompt, snippets) -> dict, matching app.research.extract.Provider.
RentProvider = Callable[[str, list], dict]


class RentProviderError(Exception):
    """Raised when every available AI provider failed to extract a rent estimate.

    The router degrades this to the labeled benchmark (same surface as AI-off), so a
    transient provider outage never 500s the wizard or blocks a manual rent entry.
    """


def _anthropic_available() -> bool:
    """True iff the Anthropic key is configured (read at call time)."""
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _openai_available() -> bool:
    """True iff the OpenAI key is configured (read at call time)."""
    return bool(os.environ.get("OPENAI_API_KEY"))


def _ai_kill_switch() -> bool:
    """True iff the deployment-wide AI kill switch is set (SECURITY.md §6.4)."""
    return os.environ.get("AI_DISABLED", "").lower() in ("1", "true", "yes")


def _call_anthropic(prompt: str, snippets: list) -> dict:
    """Extract via Anthropic (primary). Seam: monkeypatched in tests / SDK later."""
    raise RentProviderError("anthropic SDK not wired")


def _call_openai(prompt: str, snippets: list) -> dict:
    """Extract via OpenAI (fallback). Seam: monkeypatched in tests / SDK later."""
    raise RentProviderError("openai SDK not wired")


def make_rent_provider(
    *,
    anthropic: RentProvider | None = None,
    openai: RentProvider | None = None,
) -> RentProvider | None:
    """Return a ``Provider`` callable (Anthropic primary → OpenAI fallback), or None.

    ``None`` is the AI-disabled signal: ``extract_rent(snippets, provider=None)``
    returns the labeled benchmark at low confidence. AI is disabled when the
    ``AI_DISABLED`` kill switch is set OR no provider key is configured.

    When a provider is returned, calling it tries Anthropic first, then OpenAI; if
    every available provider raises, it raises ``RentProviderError`` (the router
    degrades that to the benchmark too). The ``anthropic`` / ``openai`` seams let
    tests inject deterministic stubs without a network or an SDK.
    """
    if _ai_kill_switch():
        return None
    chain: list[RentProvider] = []
    if _anthropic_available():
        chain.append(anthropic or _call_anthropic)
    if _openai_available():
        chain.append(openai or _call_openai)
    if not chain:
        return None

    def provider(prompt: str, snippets: list) -> dict:
        last: Exception | None = None
        for fn in chain:
            try:
                return fn(prompt, snippets)
            except Exception as exc:  # provider down -> try the next one
                last = exc
                continue
        raise RentProviderError(str(last) if last else "no provider")

    return provider

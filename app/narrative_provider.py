"""app/narrative_provider.py — grounded narrative generation with provider failover.

Slice 11 (epic-N N6). The narrative is generated low-temperature from
computed_json with **Anthropic primary -> OpenAI fallback** (SECURITY.md §4 line
138, PRD §17). The contract here is a single ``generate`` entry point that:

  - tries each AVAILABLE provider in order (Anthropic, then OpenAI),
  - returns ``(body_md, provider)`` from the first that succeeds, so the API can
    record the ACTUAL provider used,
  - raises ``AIUnavailableError`` when every available provider fails (the API
    maps that to ``503 ai_unavailable`` — compute/save/.xlsx still work, §21).

The provider call functions are deliberately thin and monkeypatchable so the
grounding/failover tests run hermetically with no network and no SDK in the path.
Keys are read at CALL TIME, never cached at import (SECURITY.md §4 — no fallback
chains, no module-load caching). The actual SDK wiring lands behind these seams
without changing the failover contract.

Every provider's output passes the SAME post-generation grounding gate in the
caller (router), so a provider swap can never weaken the figure-grounding
invariant.
"""
from __future__ import annotations

import os
from typing import Any, Optional


class AIUnavailableError(Exception):
    """Raised when no AI provider could produce prose (-> 503 ai_unavailable)."""


def _anthropic_available() -> bool:
    """True iff the Anthropic key is configured (read at call time)."""
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _openai_available() -> bool:
    """True iff the OpenAI key is configured (read at call time)."""
    return bool(os.environ.get("OPENAI_API_KEY"))


def _figures_paragraph(vm: dict[str, Any]) -> str:
    """Grounded prose drawn verbatim from computed_json display strings.

    This is the deterministic, no-network seed used when no live SDK is wired
    (and the body the test providers stand in for). Because every figure is
    copied from a computed_json display string, the output is grounded BY
    CONSTRUCTION; the validator that runs after generation is a hard backstop.
    """
    metrics = vm.get("metrics") or {}
    reco = vm.get("reco") or {}
    cap = (metrics.get("capital") or {}).get("display", "")
    gap = (metrics.get("cashGap") or {}).get("display", "")
    be = (metrics.get("breakeven") or {}).get("display", "")
    headline = reco.get("headline", "")
    parts = [f"<p><strong>{headline}</strong></p>"] if headline else []
    sentence = "<p>The plan requires "
    if cap:
        sentence += f"{cap} in startup capital"
    if be:
        sentence += (f" and reaches break-even at {be}" if cap
                     else f"Break-even is reached at {be}")
    sentence += ".</p>"
    parts.append(sentence)
    if gap:
        parts.append(
            f"<p>The most-negative first-year cash position is {gap}; "
            "estimated figures (e.g. market rent) are planning ranges, "
            "not quotes.</p>")
    return "".join(parts)


def _call_anthropic(vm: dict[str, Any], role: Optional[str] = None) -> str:
    """Generate via Anthropic (primary). Seam: monkeypatched in tests / SDK later."""
    return _figures_paragraph(vm)


def _call_openai(vm: dict[str, Any], role: Optional[str] = None) -> str:
    """Generate via OpenAI (fallback). Seam: monkeypatched in tests / SDK later."""
    return _figures_paragraph(vm)


def generate(
    vm: dict[str, Any],
    role: Optional[str] = None,
    *,
    generator: Any = None,
) -> tuple[str, str]:
    """Generate narrative prose, Anthropic primary -> OpenAI fallback.

    Returns ``(body_md, provider)`` for the first available provider that
    succeeds. Raises ``AIUnavailableError`` if every available provider fails (or
    none is configured). The caller still grounds the result — a provider can
    never bypass the figure-grounding gate.

    When neither provider key is configured (dev/test with AI on but no keys), a
    deterministic local ``generator`` produces grounded prose tagged provider
    ``"template"`` so the opt-out / hermetic paths still exercise the gate. The
    ``generator`` seam also lets the API inject its own grounded builder (and lets
    tests patch one place).
    """
    providers: list[tuple[str, Any]] = []
    if _anthropic_available():
        providers.append(("anthropic", _call_anthropic))
    if _openai_available():
        providers.append(("openai", _call_openai))

    last_error: Exception | None = None
    for name, fn in providers:
        try:
            body = fn(vm, role)
            if body:
                return body, name
        except Exception as exc:  # provider down -> try the next one
            last_error = exc
            continue

    if not providers:
        # No live provider configured: fall back to the deterministic local
        # grounded builder rather than failing, so AI-on-but-keyless dev works.
        gen = generator or _figures_paragraph
        body = gen(vm, role) if _accepts_role(gen) else gen(vm)
        if body:
            return body, "template"

    raise AIUnavailableError(str(last_error) if last_error else "no AI provider")


def _accepts_role(fn: Any) -> bool:
    """True iff ``fn`` accepts a second ``role`` positional/keyword argument."""
    try:
        import inspect

        params = inspect.signature(fn).parameters
        return len(params) >= 2 or any(
            p.kind == p.VAR_POSITIONAL or p.kind == p.VAR_KEYWORD
            for p in params.values()
        )
    except (TypeError, ValueError):
        return False

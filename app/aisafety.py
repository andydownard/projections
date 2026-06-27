"""app/aisafety.py — AI-safety invariants (epic-N N12, SECURITY.md §6.3/§6.4).

CI-blocking guards that keep LLM output from poisoning the trust surface. They are
hard validators, not prompt niceties:

- ``strip_injection_markers`` neutralizes prompt-injection markers in any untrusted
  text before it reaches a model OR a render path.
- ``grounded_money_percent_tokens`` collects every currency/percent *display* token
  the engine actually produced (the only legitimate figures).
- ``assert_no_ungrounded_money`` rejects any $/% token in generated prose that is
  not one of those grounded tokens — so no LLM-originated currency/percent token
  can reach a render path (numeric grounding, PRD §17).
- ``ai_disabled`` is the single AI opt-out check: a per-projection flag, a
  deployment kill switch, OR all AI keys unset all force the zero-AI path.

These mirror the existing research-extract/feedback-redact patterns (DRY) but live
in one place so the preview/narrative/packet render paths share one safety surface.
"""
from __future__ import annotations

import os
import re
from collections.abc import Iterable
from typing import Any

# Prompt-injection markers neutralized before untrusted text reaches a model or a
# render path (untrusted-data framing, SECURITY.md §6.3). Case-insensitive.
_INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(?:all\s+|any\s+)?previous\s+instructions", re.IGNORECASE),
    re.compile(r"disregard\s+(?:all\s+|any\s+)?(?:previous|prior)\s+instructions", re.IGNORECASE),
    re.compile(r"\bsystem\s*:", re.IGNORECASE),
    re.compile(r"\bassistant\s*:", re.IGNORECASE),
    re.compile(r"\buser\s*:", re.IGNORECASE),
    re.compile(r"<\|?\s*im_(?:start|end)\s*\|?>", re.IGNORECASE),
    re.compile(r"<\|?\s*(?:system|assistant|user)\s*\|?>", re.IGNORECASE),
    re.compile(r"\[/?INST\]", re.IGNORECASE),
]

# Currency tokens ($1, $9.00, $277,990, ($41,200) parenthesized negatives) and
# bare percentages (6%, 11.0%) — the figure shapes that may appear in prose.
_MONEY_RE = re.compile(r"\(?\$\s?\d[\d,]*(?:\.\d+)?\)?")
_PERCENT_RE = re.compile(r"\b\d+(?:\.\d+)?\s?%")

# A *display-formatted* money/percent token — the tell-tale shape of an engine
# OUTPUT figure ($, %, or thousands-grouping commas), as opposed to a raw user
# input value (a bare number/fraction like ``0.08`` or ``5000``). Used by the
# Penny tool loop to strip/reject a computed figure an LLM emits in a mutate-tool
# argument (extends the N2 figure-strip rule to tool args, SECURITY §6.3).
_FIGURE_TOKEN_RE = re.compile(r"[$%]|\d,\d{3}")


def is_computed_figure_token(value: object) -> bool:
    """True if ``value`` is a display-formatted money/percent figure, not a raw input.

    Penny's tool calls must carry *intents* (raw values she relays from the user),
    never a *computed* figure she asserts. A value that is display-formatted —
    contains ``$``, ``%``, or thousands-grouping commas (``$277,990``, ``8%``,
    ``($41,200)``, ``50,000``) — is the shape only the engine's formatting layer
    produces, so the server refuses to apply it as a mutate-tool argument (no LLM
    figure ever reaches the data). Bare numbers/fractions (``0.08``, ``5000``,
    ``"2026-09-01"``) are legitimate user inputs and are never flagged.
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return False
    if not isinstance(value, str):
        return False
    return bool(_FIGURE_TOKEN_RE.search(value))


def strip_injection_markers(text: str | None) -> str:
    """Remove prompt-injection markers from untrusted text (SECURITY.md §6.3)."""
    s = text or ""
    for pat in _INJECTION_PATTERNS:
        s = pat.sub(" ", s)
    return re.sub(r"\s{2,}", " ", s).strip()


def _norm(tok: str) -> str:
    """Normalize a $/% token for grounding comparison (drop spaces only)."""
    return tok.replace(" ", "")


def _iter_display_strings(obj: Any) -> Iterable[str]:
    """Yield every ``display`` string nested anywhere in a view-model dict."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "display" and isinstance(v, str):
                yield v
            else:
                yield from _iter_display_strings(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from _iter_display_strings(item)


def grounded_money_percent_tokens(view_model: dict) -> set[str]:
    """Every currency/percent token the engine actually emitted (computed_json).

    These are the ONLY figures allowed to appear in generated prose. We collect
    the raw display strings AND the individual $/% tokens parsed out of them so a
    sentence figure can be matched token-for-token.
    """
    tokens: set[str] = set()
    for disp in _iter_display_strings(view_model):
        tokens.add(_norm(disp))
        for m in _MONEY_RE.findall(disp):
            tokens.add(_norm(m))
        for m in _PERCENT_RE.findall(disp):
            tokens.add(_norm(m))
    return tokens


def find_ungrounded_money(text: str, view_model: dict) -> list[str]:
    """Return the $/% tokens in ``text`` that are NOT in ``view_model``."""
    grounded = grounded_money_percent_tokens(view_model)
    found = _MONEY_RE.findall(text or "") + _PERCENT_RE.findall(text or "")
    return [tok for tok in found if _norm(tok) not in grounded]


def assert_no_ungrounded_money(text: str, view_model: dict) -> None:
    """Raise ValueError if any $/% token in ``text`` is not grounded.

    This is the render-path backstop: no LLM-originated currency/percent token can
    reach the board packet / narrative unless it is a figure the engine produced.
    """
    ungrounded = find_ungrounded_money(text, view_model)
    if ungrounded:
        raise ValueError(f"ungrounded figures: {sorted(set(ungrounded))}")


def ai_keys_present() -> bool:
    """True iff at least one AI provider key is configured (read at call time)."""
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY"))


def ai_disabled(row: dict | None = None) -> bool:
    """The single AI opt-out check (SECURITY.md §6.4).

    AI is disabled when ANY of these hold: a per-projection ``ai_opt_out`` flag, a
    deployment-wide ``AI_DISABLED`` kill switch, or no AI provider key configured.
    With AI disabled, compute/save/.xlsx still run with zero AI calls.
    """
    if row is not None and int(row.get("ai_opt_out") or 0):
        return True
    if os.environ.get("AI_DISABLED", "").lower() in ("1", "true", "yes"):
        return True
    return not ai_keys_present()

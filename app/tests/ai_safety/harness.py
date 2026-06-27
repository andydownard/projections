"""Shared harness for the Penny AI-safety suite (PE11 — issue #130, extends N12).

The N12 base gate (``app/tests/test_ai_safety.py``) pins the render-path invariants
on the *narrative/preview* surface. PE11 extends that **same safety spine** onto the
**Penny tool-use loop + seven-tool surface** (PE3/PE4), exercised end-to-end with
**stubbed providers only** — no real provider/network call ever happens (the
``_no_real_network`` autouse guard in ``conftest.py`` makes a real call raise).

This module is the reused harness (spec §16 / issue #130 "shared harness reused"):
the scripted provider chain, the provider stub transport, the projection body, and
the tool-context builder. Tests import from here so the doubles live in one place.
"""
from __future__ import annotations

import json

from app.aisafety import grounded_money_percent_tokens
from app.penny.loop import ToolContext
from app.penny.providers import ProviderResponse, ToolCall, Usage

# A real, computing projection body (identical to the N12 / PE4 fixtures so the
# engine produces grounded figures we can assert against). One math authority.
VALID_BODY = {
    "name": "House of Hope",
    "inputs": {
        "org_name": "House of Hope",
        "city": "Longview, Texas",
        "opening_status": "pre_launch",
        "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
        "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
        "source_of_funds": "300000", "occupancy_annual": "120000",
        "lease_type": "nnn", "nnn_opex_annual": "0",
    },
    "trade_area": {"basis": "city", "households": "31798"},
    "assumptions": {"labor_pct": "0.60"},
}


# --------------------------------------------------------------- scripted chain
class ScriptedChain:
    """A fake provider chain: returns queued ``ProviderResponse`` items (or raises).

    Mirrors the double the PE3/PE4 suites use, so the Penny loop is driven with a
    deterministic script — never a real provider. ``calls`` records each
    ``CompletionRequest`` the loop tried to complete (zero on a gated/blocked turn).
    """

    def __init__(self, *responses, providers=("anthropic",)) -> None:
        self._responses = list(responses)
        self.calls: list = []
        self.providers = list(providers)

    def complete(self, request):
        self.calls.append(request)
        item = self._responses.pop(0) if self._responses else text_resp("done")
        if isinstance(item, Exception):
            raise item
        return item


def text_resp(text, *, provider="anthropic", stop_reason="end_turn", in_tok=4, out_tok=4):
    """A final (prose) provider reply — the model is done, no tools wanted."""
    return ProviderResponse(
        provider=provider, text=text, stop_reason=stop_reason,
        usage=Usage(input_tokens=in_tok, output_tokens=out_tok),
    )


def tool_resp(name, args, *, call_id="tu_1", provider="anthropic", text="", in_tok=4, out_tok=4):
    """A provider reply that requests one tool call (the model wants to act)."""
    return ProviderResponse(
        provider=provider, text=text,
        tool_calls=[ToolCall(id=call_id, name=name, arguments=args)],
        stop_reason="tool_use",
        usage=Usage(input_tokens=in_tok, output_tokens=out_tok),
    )


# ------------------------------------------------------------------ tool context
_USE_PROJECTION_TOKEN = object()


def make_ctx(
    projection,
    *,
    can_mutate=True,
    version=1,
    token_key="owner_token",
    bearer=_USE_PROJECTION_TOKEN,
    **extra,
):
    """Build a :class:`ToolContext` for a created projection.

    ``bearer`` defaults to the projection's ``token_key`` token; pass ``bearer=None``
    (or a wrong token) to exercise the 403 real-mutation-wall backstop independent of
    the ``can_mutate`` capability flag.
    """
    token = projection[token_key] if bearer is _USE_PROJECTION_TOKEN else bearer
    return ToolContext(
        view_slug=projection["view_slug"],
        bearer_token=token,
        can_mutate=can_mutate,
        version=version,
        extra=extra,
    )


# ------------------------------------------------------------- provider transport
def stub_transport(router):
    """A provider ``Transport`` double: ``router(url, body) -> (status, payload)``.

    Records every call on ``.calls`` so a test can prove the chain went through the
    injected stub (and, paired with ``_no_real_network``, that no real POST happened).
    """
    calls: list = []

    def transport(url, headers, json_body, timeout=60.0):
        calls.append({"url": url, "headers": headers, "body": json_body})
        return router(url, json_body)

    transport.calls = calls  # type: ignore[attr-defined]
    return transport


def anthropic_text_payload(text, *, input_tokens=5, output_tokens=7):
    """A well-formed Anthropic 200 body carrying a single text block."""
    return {
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
    }


def openai_text_payload(text, *, prompt_tokens=5, completion_tokens=7):
    """A well-formed OpenAI 200 body carrying assistant content."""
    return {
        "choices": [{"message": {"role": "assistant", "content": text}}],
        "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens},
    }


# --------------------------------------------------------------- grounding helpers
def stored_view_model(store, slug) -> dict:
    """The post-edit grounded ``computed_json`` (the only legitimate figures)."""
    row = store.get_projection_by_slug(slug)
    return json.loads(row["computed_json"] or "{}")


def money_tokens(view_model: dict) -> set[str]:
    """The grounded ``$`` figure tokens the engine actually emitted."""
    return {t for t in grounded_money_percent_tokens(view_model) if t.startswith("$")}

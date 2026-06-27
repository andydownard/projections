"""RED-first tests for app/penny/providers.py (Penny PE3 — issue #122).

The provider abstraction: Anthropic primary -> OpenAI fallback -> AI-disabled.
Every test uses a STUBBED transport (an injected callable) — NEVER a real
provider API call (CLAUDE.md: tests use stubbed providers; keys are server-side
env only). The behaviours pinned here:

- the "most capable Anthropic model id" resolves to a current alias, NOT an aging
  dated snapshot, and is env-overridable (spec §8 model-id note);
- the chain reads keys from the environment at call time (never client/URL);
- the actual provider used is reported on the response;
- a provider 5xx/429/transport error is an *availability* failure that triggers
  fallback; both down -> AIUnavailableError;
- a malformed provider body DEGRADES to a plain answer (never raises -> never a 500);
- the API key travels in the auth header, never in the URL or JSON body.
"""
from __future__ import annotations

import json

import pytest

from app.penny import providers as P


# --------------------------------------------------------------------- helpers
def _anthropic_body(text="", tool=None, in_tok=11, out_tok=7, stop=None):
    content = []
    if text:
        content.append({"type": "text", "text": text})
    if tool:
        content.append(
            {"type": "tool_use", "id": tool["id"], "name": tool["name"], "input": tool["input"]}
        )
    return {
        "content": content,
        "stop_reason": stop or ("tool_use" if tool else "end_turn"),
        "usage": {"input_tokens": in_tok, "output_tokens": out_tok},
        "model": "anthropic-stub",
    }


def _openai_body(text="", tool=None, in_tok=13, out_tok=9):
    message = {"role": "assistant", "content": text or None}
    if tool:
        message["tool_calls"] = [
            {
                "id": tool["id"],
                "type": "function",
                "function": {"name": tool["name"], "arguments": json.dumps(tool["input"])},
            }
        ]
    return {
        "choices": [{"message": message, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": in_tok, "completion_tokens": out_tok},
        "model": "openai-stub",
    }


class StubTransport:
    """Records every call; returns queued (status, payload) tuples or raises."""

    def __init__(self, *outcomes):
        self._outcomes = list(outcomes)
        self.calls = []  # list of (url, headers, json_body)

    def __call__(self, url, headers, json_body, timeout=None):
        self.calls.append((url, headers, json_body))
        outcome = self._outcomes.pop(0) if self._outcomes else (200, {})
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _request(tools=None):
    return P.CompletionRequest(
        system="You are Penny.",
        messages=[{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        tools=tools or [],
        max_output_tokens=256,
    )


# ----------------------------------------------------------- model resolution
def test_resolve_anthropic_model_default_is_current_alias_not_dated_snapshot():
    model = P.resolve_anthropic_model({})
    # Must be the most-capable Anthropic alias resolved at build time...
    assert model == P.MOST_CAPABLE_ANTHROPIC_MODEL
    assert model.startswith("claude-")
    # ...and must NOT be an aging dated snapshot (e.g. claude-...-20260101).
    assert "-202" not in model


def test_resolve_anthropic_model_env_override():
    assert (
        P.resolve_anthropic_model({"PENNY_ANTHROPIC_MODEL": "claude-future-9"})
        == "claude-future-9"
    )


def test_resolve_openai_model_default_and_override():
    assert P.resolve_openai_model({}) == P.OPENAI_FALLBACK_MODEL
    assert P.resolve_openai_model({"PENNY_OPENAI_MODEL": "gpt-next"}) == "gpt-next"


# --------------------------------------------------- chain construction / keys
def test_build_chain_reads_keys_from_env_at_call_time():
    only_anthropic = P.build_provider_chain(env={"ANTHROPIC_API_KEY": "sk-a"})
    assert [p.name for p in only_anthropic.providers] == ["anthropic"]

    both = P.build_provider_chain(env={"ANTHROPIC_API_KEY": "sk-a", "OPENAI_API_KEY": "sk-o"})
    assert [p.name for p in both.providers] == ["anthropic", "openai"]

    none = P.build_provider_chain(env={})
    assert none.providers == []


def test_openai_only_env_makes_openai_primary():
    chain = P.build_provider_chain(env={"OPENAI_API_KEY": "sk-o"})
    assert [p.name for p in chain.providers] == ["openai"]


# ---------------------------------------------------------- anthropic parsing
def test_anthropic_provider_parses_text_response():
    t = StubTransport((200, _anthropic_body(text="Hello there")))
    prov = P.AnthropicProvider(api_key="sk-a", model="claude-opus-4-8", transport=t)
    resp = prov.complete(_request())
    assert resp.provider == "anthropic"
    assert resp.text == "Hello there"
    assert resp.wants_tools is False
    assert resp.usage.input_tokens == 11 and resp.usage.output_tokens == 7


def test_anthropic_provider_parses_tool_use():
    t = StubTransport(
        (200, _anthropic_body(tool={"id": "tu_1", "name": "set_input", "input": {"x": 8}}))
    )
    prov = P.AnthropicProvider(api_key="sk-a", model="claude-opus-4-8", transport=t)
    resp = prov.complete(_request())
    assert resp.wants_tools is True
    assert resp.tool_calls[0].name == "set_input"
    assert resp.tool_calls[0].arguments == {"x": 8}
    assert resp.tool_calls[0].id == "tu_1"


def test_anthropic_request_carries_model_and_tools_and_max_tokens():
    t = StubTransport((200, _anthropic_body(text="ok")))
    prov = P.AnthropicProvider(api_key="sk-a", model="claude-opus-4-8", transport=t)
    prov.complete(_request(tools=[{"name": "t", "description": "d", "input_schema": {}}]))
    _url, _headers, body = t.calls[0]
    assert body["model"] == "claude-opus-4-8"
    assert body["max_tokens"] == 256
    assert body["tools"][0]["name"] == "t"
    assert body["system"] == "You are Penny."


def test_anthropic_key_in_header_never_in_url_or_body():
    t = StubTransport((200, _anthropic_body(text="ok")))
    prov = P.AnthropicProvider(api_key="sk-secret", model="claude-opus-4-8", transport=t)
    prov.complete(_request())
    url, headers, body = t.calls[0]
    assert "sk-secret" not in url
    assert "sk-secret" not in json.dumps(body)
    assert headers.get("x-api-key") == "sk-secret"


def test_anthropic_429_raises_provider_unavailable():
    t = StubTransport((429, {"error": "rate_limited"}))
    prov = P.AnthropicProvider(api_key="sk-a", model="m", transport=t)
    with pytest.raises(P.ProviderUnavailable):
        prov.complete(_request())


def test_anthropic_5xx_raises_provider_unavailable():
    t = StubTransport((503, {"error": "overloaded"}))
    prov = P.AnthropicProvider(api_key="sk-a", model="m", transport=t)
    with pytest.raises(P.ProviderUnavailable):
        prov.complete(_request())


def test_transport_exception_becomes_provider_unavailable():
    t = StubTransport(ConnectionError("network down"))
    prov = P.AnthropicProvider(api_key="sk-a", model="m", transport=t)
    with pytest.raises(P.ProviderUnavailable):
        prov.complete(_request())


def test_anthropic_parse_failure_degrades_does_not_raise():
    # 200 OK but a body shape we cannot parse -> graceful degrade, never a 500.
    t = StubTransport((200, {"unexpected": "shape"}))
    prov = P.AnthropicProvider(api_key="sk-a", model="m", transport=t)
    resp = prov.complete(_request())
    assert resp.stop_reason == "parse_degraded"
    assert resp.text  # non-empty plain answer
    assert resp.wants_tools is False


# ------------------------------------------------------------- openai parsing
def test_openai_provider_parses_tool_calls():
    t = StubTransport(
        (200, _openai_body(tool={"id": "call_1", "name": "set_assumption", "input": {"v": 1}}))
    )
    prov = P.OpenAIProvider(api_key="sk-o", model="gpt-x", transport=t)
    resp = prov.complete(_request())
    assert resp.provider == "openai"
    assert resp.tool_calls[0].name == "set_assumption"
    assert resp.tool_calls[0].arguments == {"v": 1}
    assert resp.usage.input_tokens == 13 and resp.usage.output_tokens == 9


def test_openai_uses_bearer_auth_not_url():
    t = StubTransport((200, _openai_body(text="hi")))
    prov = P.OpenAIProvider(api_key="sk-o-secret", model="gpt-x", transport=t)
    prov.complete(_request())
    url, headers, body = t.calls[0]
    assert "sk-o-secret" not in url
    assert headers.get("authorization") == "Bearer sk-o-secret"


def test_openai_translates_tool_schema_to_function_shape():
    t = StubTransport((200, _openai_body(text="ok")))
    prov = P.OpenAIProvider(api_key="sk-o", model="gpt-x", transport=t)
    prov.complete(
        _request(tools=[{"name": "set_input", "description": "d", "input_schema": {"a": 1}}])
    )
    _url, _headers, body = t.calls[0]
    assert body["tools"][0]["type"] == "function"
    assert body["tools"][0]["function"]["name"] == "set_input"
    assert body["tools"][0]["function"]["parameters"] == {"a": 1}


# ----------------------------------------------------------------- the chain
def test_chain_failover_anthropic_to_openai_reports_actual_provider():
    a = StubTransport((500, {"error": "boom"}))
    o = StubTransport((200, _openai_body(text="from openai")))
    chain = P.ProviderChain(
        [
            P.AnthropicProvider(api_key="sk-a", model="m", transport=a),
            P.OpenAIProvider(api_key="sk-o", model="m", transport=o),
        ]
    )
    resp = chain.complete(_request())
    assert resp.provider == "openai"
    assert resp.text == "from openai"
    assert len(a.calls) == 1 and len(o.calls) == 1


def test_chain_both_down_raises_ai_unavailable():
    a = StubTransport((500, {}))
    o = StubTransport((500, {}))
    chain = P.ProviderChain(
        [
            P.AnthropicProvider(api_key="sk-a", model="m", transport=a),
            P.OpenAIProvider(api_key="sk-o", model="m", transport=o),
        ]
    )
    with pytest.raises(P.AIUnavailableError):
        chain.complete(_request())


def test_chain_pins_provider_after_first_success():
    a = StubTransport((200, _anthropic_body(text="one")), (200, _anthropic_body(text="two")))
    o = StubTransport((200, _openai_body(text="never")))
    chain = P.ProviderChain(
        [
            P.AnthropicProvider(api_key="sk-a", model="m", transport=a),
            P.OpenAIProvider(api_key="sk-o", model="m", transport=o),
        ]
    )
    r1 = chain.complete(_request())
    r2 = chain.complete(_request())
    assert r1.provider == "anthropic" and r2.provider == "anthropic"
    # Once pinned, the second turn does NOT re-try OpenAI.
    assert len(o.calls) == 0
    assert len(a.calls) == 2


def test_chain_pinned_provider_failure_is_ai_unavailable_not_silent_switch():
    # After anthropic is pinned, a later anthropic failure surfaces as
    # AIUnavailableError (we don't switch provider mid-turn — message history is
    # provider-native).
    a = StubTransport((200, _anthropic_body(text="ok")), (500, {}))
    o = StubTransport((200, _openai_body(text="never")))
    chain = P.ProviderChain(
        [
            P.AnthropicProvider(api_key="sk-a", model="m", transport=a),
            P.OpenAIProvider(api_key="sk-o", model="m", transport=o),
        ]
    )
    chain.complete(_request())
    with pytest.raises(P.AIUnavailableError):
        chain.complete(_request())
    assert len(o.calls) == 0


def test_empty_chain_complete_raises_ai_unavailable():
    chain = P.ProviderChain([])
    with pytest.raises(P.AIUnavailableError):
        chain.complete(_request())


# --------------------------------------------------- data-shape unit behaviour
def test_usage_total_and_add():
    u = P.Usage(input_tokens=3, output_tokens=4)
    assert u.total == 7
    u.add(P.Usage(input_tokens=1, output_tokens=2))
    assert (u.input_tokens, u.output_tokens, u.total) == (4, 6, 10)


def test_provider_response_defaults():
    r = P.ProviderResponse(provider="anthropic")
    assert r.text == ""
    assert r.tool_calls == []
    assert r.stop_reason == "end_turn"
    assert r.usage.total == 0
    assert r.wants_tools is False


def test_resolve_anthropic_model_blank_override_falls_back():
    assert (
        P.resolve_anthropic_model({"PENNY_ANTHROPIC_MODEL": ""})
        == P.MOST_CAPABLE_ANTHROPIC_MODEL
    )


def test_resolve_openai_model_blank_override_falls_back():
    assert P.resolve_openai_model({"PENNY_OPENAI_MODEL": ""}) == P.OPENAI_FALLBACK_MODEL


# --------------------------------------------- anthropic parsing, more shapes
def test_anthropic_parses_text_and_multiple_tool_uses():
    payload = {
        "content": [
            {"type": "text", "text": "I'll do two things."},
            {"type": "tool_use", "id": "t1", "name": "set_input", "input": {"a": 1}},
            {"type": "tool_use", "id": "t2", "name": "set_assumption", "input": {"b": 2}},
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 3, "output_tokens": 4},
    }
    prov = P.AnthropicProvider(api_key="sk", model="m", transport=StubTransport((200, payload)))
    resp = prov.complete(_request())
    assert resp.text == "I'll do two things."
    assert [tc.name for tc in resp.tool_calls] == ["set_input", "set_assumption"]
    assert resp.tool_calls[1].arguments == {"b": 2}


def test_anthropic_missing_usage_defaults_to_zero():
    payload = {"content": [{"type": "text", "text": "hi"}], "stop_reason": "end_turn"}
    prov = P.AnthropicProvider(api_key="sk", model="m", transport=StubTransport((200, payload)))
    resp = prov.complete(_request())
    assert resp.usage.input_tokens == 0
    assert resp.usage.output_tokens == 0


def test_anthropic_passes_through_custom_stop_reason():
    payload = {"content": [{"type": "text", "text": "hi"}], "stop_reason": "max_tokens"}
    prov = P.AnthropicProvider(api_key="sk", model="m", transport=StubTransport((200, payload)))
    assert prov.complete(_request()).stop_reason == "max_tokens"


def test_anthropic_4xx_degrades_not_unavailable():
    transport = StubTransport((400, {"e": "bad"}))
    resp = P.AnthropicProvider(api_key="sk", model="m", transport=transport).complete(_request())
    assert resp.stop_reason == "parse_degraded"
    assert resp.text


def test_anthropic_529_overloaded_is_unavailable():
    prov = P.AnthropicProvider(api_key="sk", model="m", transport=StubTransport((529, {})))
    with pytest.raises(P.ProviderUnavailable):
        prov.complete(_request())


def test_anthropic_408_timeout_is_unavailable():
    prov = P.AnthropicProvider(api_key="sk", model="m", transport=StubTransport((408, {})))
    with pytest.raises(P.ProviderUnavailable):
        prov.complete(_request())


def test_anthropic_sets_json_content_type_and_version_header():
    t = StubTransport((200, _anthropic_body(text="ok")))
    P.AnthropicProvider(api_key="sk", model="m", transport=t).complete(_request())
    _u, headers, _b = t.calls[0]
    assert headers["content-type"] == "application/json"
    assert headers["anthropic-version"] == P.ANTHROPIC_VERSION


# ----------------------------------------------- openai parsing, more shapes
def test_openai_missing_usage_defaults_to_zero():
    payload = {"choices": [{"message": {"role": "assistant", "content": "hi"}}]}
    prov = P.OpenAIProvider(api_key="sk", model="m", transport=StubTransport((200, payload)))
    resp = prov.complete(_request())
    assert resp.usage.total == 0
    assert resp.text == "hi"


def test_openai_parses_multiple_tool_calls():
    payload = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "c1",
                            "type": "function",
                            "function": {"name": "a", "arguments": "{}"},
                        },
                        {
                            "id": "c2",
                            "type": "function",
                            "function": {"name": "b", "arguments": '{"x": 1}'},
                        },
                    ],
                }
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 2},
    }
    prov = P.OpenAIProvider(api_key="sk", model="m", transport=StubTransport((200, payload)))
    resp = prov.complete(_request())
    assert [tc.name for tc in resp.tool_calls] == ["a", "b"]
    assert resp.tool_calls[1].arguments == {"x": 1}


def test_openai_prepends_system_message():
    t = StubTransport((200, _openai_body(text="ok")))
    req = P.CompletionRequest(system="sysprompt", messages=[], tools=[], max_output_tokens=5)
    P.OpenAIProvider(api_key="sk", model="m", transport=t).complete(req)
    _u, _h, body = t.calls[0]
    assert body["messages"][0] == {"role": "system", "content": "sysprompt"}


def test_openai_passes_through_string_content_messages():
    t = StubTransport((200, _openai_body(text="ok")))
    req = P.CompletionRequest(
        system="s", messages=[{"role": "user", "content": "plain"}], tools=[], max_output_tokens=5
    )
    P.OpenAIProvider(api_key="sk", model="m", transport=t).complete(req)
    _u, _h, body = t.calls[0]
    assert {"role": "user", "content": "plain"} in body["messages"]


def test_openai_translates_assistant_tooluse_and_tool_result_roundtrip():
    t = StubTransport((200, _openai_body(text="ok")))
    req = P.CompletionRequest(
        system="sys",
        messages=[
            {"role": "user", "content": [{"type": "text", "text": "hi"}]},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "calling"},
                    {"type": "tool_use", "id": "c1", "name": "set_input", "input": {"a": 1}},
                ],
            },
            {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "c1", "content": {"ok": True}}],
            },
        ],
        tools=[],
        max_output_tokens=10,
    )
    P.OpenAIProvider(api_key="sk", model="m", transport=t).complete(req)
    _u, _h, body = t.calls[0]
    msgs = body["messages"]
    asst = next(m for m in msgs if m["role"] == "assistant")
    assert asst["tool_calls"][0]["function"]["name"] == "set_input"
    assert json.loads(asst["tool_calls"][0]["function"]["arguments"]) == {"a": 1}
    tool_msg = next(m for m in msgs if m["role"] == "tool")
    assert tool_msg["tool_call_id"] == "c1"
    assert json.loads(tool_msg["content"]) == {"ok": True}


# ------------------------------------------------------- degrade / salvage
def test_salvage_text_prefers_anthropic_then_openai_then_empty():
    assert P._salvage_text({"content": [{"type": "text", "text": "A"}]}) == "A"
    assert P._salvage_text({"choices": [{"message": {"content": "B"}}]}) == "B"
    assert P._salvage_text({"nothing": 1}) == ""


def test_degraded_uses_fallback_when_nothing_salvageable():
    prov = P.AnthropicProvider(api_key="sk", model="m", transport=StubTransport((200, {"x": 1})))
    resp = prov.complete(_request())
    assert resp.text == P._DEGRADED_FALLBACK_TEXT
    assert resp.provider == "anthropic"


def test_degraded_salvages_partial_text_when_present():
    # 200 with a parseable text block but a broken tool block -> keep the text.
    payload = {"content": [{"type": "text", "text": "kept"}, {"type": "tool_use"}]}
    prov = P.AnthropicProvider(api_key="sk", model="m", transport=StubTransport((200, payload)))
    resp = prov.complete(_request())
    assert resp.stop_reason == "parse_degraded"
    assert resp.text == "kept"


# ----------------------------------------------------- chain / build wiring
def test_build_chain_threads_resolved_model_and_transport():
    t = StubTransport((200, _anthropic_body(text="ok")))
    chain = P.build_provider_chain(
        env={"ANTHROPIC_API_KEY": "sk", "PENNY_ANTHROPIC_MODEL": "claude-x"}, transport=t
    )
    chain.complete(_request())
    _u, _h, body = t.calls[0]
    assert body["model"] == "claude-x"


def test_build_chain_openai_uses_resolved_openai_model():
    t = StubTransport((200, _openai_body(text="ok")))
    chain = P.build_provider_chain(
        env={"OPENAI_API_KEY": "sk", "PENNY_OPENAI_MODEL": "gpt-z"}, transport=t
    )
    chain.complete(_request())
    _u, _h, body = t.calls[0]
    assert body["model"] == "gpt-z"

"""app/penny/providers.py — Penny's LLM provider abstraction (issue #122, spec §8).

Anthropic **primary** -> OpenAI **fallback** -> AI-**disabled**. The contract:

- A ``Provider`` translates a provider-agnostic :class:`CompletionRequest` into a
  single ``POST`` and parses the reply back into a provider-agnostic
  :class:`ProviderResponse` whose ``provider`` field names the model that
  actually answered (spec §8: the disclosure line reflects the ACTUAL provider).
- A :class:`ProviderChain` tries each available provider in order. A 5xx/429 or a
  transport error is an *availability* failure that triggers fallback; when every
  provider is unavailable it raises :class:`AIUnavailableError` (-> 503). Once a
  provider answers, the chain **pins** it for the rest of the turn because the
  message history is provider-native (we never switch mid-tool-loop).
- A malformed 200 body **degrades** to a plain-text answer (``stop_reason ==
  "parse_degraded"``) instead of raising — a provider parse failure must never
  become an HTTP 500 (spec §11).

Keys are read from the server environment **at call time** (``ANTHROPIC_API_KEY`` /
``OPENAI_API_KEY``) — never from the client, a URL, or a log (CLAUDE.md rule 7).
The HTTP call is a thin injected ``transport`` callable so every test runs against
a STUB with no network and no SDK in the path (CLAUDE.md: stubbed providers).

Model-id policy (spec §8 note): the "most capable Anthropic model" is resolved at
build time to a **current alias** (:data:`MOST_CAPABLE_ANTHROPIC_MODEL`), not a
dated snapshot that silently ages — an alias always points at the latest snapshot
of that model line. It is overridable via ``PENNY_ANTHROPIC_MODEL`` /
``PENNY_OPENAI_MODEL`` so an operator can pin or advance it without a code change.
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Callable

# --- model ids resolved at build time (aliases, NOT aging dated snapshots) ----
# Anthropic's most capable model at build time. Using the bare alias (no
# `-YYYYMMDD` suffix) means it tracks the latest snapshot of the line rather than
# pinning a snapshot that ages out. Overridable via PENNY_ANTHROPIC_MODEL.
MOST_CAPABLE_ANTHROPIC_MODEL = "claude-opus-4-8"
# OpenAI fallback model id (overridable via PENNY_OPENAI_MODEL).
OPENAI_FALLBACK_MODEL = "gpt-4o"

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"

_HTTP_TIMEOUT_SECONDS = 60.0
# A provider HTTP status in this set is an availability failure -> trigger fallback.
_UNAVAILABLE_STATUSES = {408, 409, 425, 429, 500, 502, 503, 504, 529}
# Returned to the user when a provider's body is unparseable (degrade, not 500).
_DEGRADED_FALLBACK_TEXT = (
    "I had trouble reading the response just now. Could you try asking again?"
)


# --------------------------------------------------------------------- errors
class PennyProviderError(Exception):
    """Base for provider-layer failures."""


class ProviderUnavailable(PennyProviderError):
    """One provider is unreachable/at-capacity — the chain falls back."""


class AIUnavailableError(PennyProviderError):
    """Every configured provider failed (-> HTTP 503 ai_unavailable, spec §8)."""


# ----------------------------------------------------------------- data shapes
@dataclass
class ToolCall:
    """A model-requested tool invocation (provider-agnostic)."""

    id: str
    name: str
    arguments: dict


@dataclass
class Usage:
    """Token accounting for one or more provider calls."""

    input_tokens: int = 0
    output_tokens: int = 0

    @property
    def total(self) -> int:
        return self.input_tokens + self.output_tokens

    def add(self, other: Usage) -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens


@dataclass
class ProviderResponse:
    """A normalized provider reply: prose and/or tool calls + which provider."""

    provider: str
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    stop_reason: str = "end_turn"  # end_turn | tool_use | parse_degraded
    usage: Usage = field(default_factory=Usage)

    @property
    def wants_tools(self) -> bool:
        return bool(self.tool_calls)


@dataclass
class CompletionRequest:
    """A provider-agnostic request the chain hands to whichever provider runs."""

    system: str
    messages: list[dict]
    tools: list[dict]
    max_output_tokens: int


# A transport is (url, headers, json_body[, timeout]) -> (status_code, payload).
Transport = Callable[..., "tuple[int, dict]"]


# ----------------------------------------------------------- model resolution
def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    return os.environ if env is None else env


def resolve_anthropic_model(env: Mapping[str, str] | None = None) -> str:
    """The most-capable Anthropic model id (env override, else build-time alias)."""
    return _env(env).get("PENNY_ANTHROPIC_MODEL") or MOST_CAPABLE_ANTHROPIC_MODEL


def resolve_openai_model(env: Mapping[str, str] | None = None) -> str:
    """The OpenAI fallback model id (env override, else build-time default)."""
    return _env(env).get("PENNY_OPENAI_MODEL") or OPENAI_FALLBACK_MODEL


# ------------------------------------------------------------- default transport
def _httpx_transport(
    url: str, headers: dict, json_body: dict, timeout: float = _HTTP_TIMEOUT_SECONDS
) -> tuple[int, dict]:
    """Default transport: a single httpx POST (httpx is already a CI dependency).

    Kept thin and injectable so tests stub it — no real provider call in a test.
    """
    import httpx

    resp = httpx.post(url, headers=headers, json=json_body, timeout=timeout)
    payload: dict = {}
    if resp.content:
        try:
            payload = resp.json()
        except ValueError:
            payload = {}
    return resp.status_code, payload


# ------------------------------------------------------------------- providers
class _BaseProvider:
    name = "base"

    def __init__(self, *, api_key: str, model: str, transport: Transport | None = None) -> None:
        self._api_key = api_key
        self._model = model
        self._transport: Transport = transport or _httpx_transport

    # --- subclass hooks -----------------------------------------------------
    def _url(self) -> str:  # pragma: no cover - trivial
        raise NotImplementedError

    def _headers(self) -> dict:  # pragma: no cover - trivial
        raise NotImplementedError

    def _to_wire(self, request: CompletionRequest) -> dict:  # pragma: no cover - trivial
        raise NotImplementedError

    def _parse(self, payload: dict) -> ProviderResponse:  # pragma: no cover - trivial
        raise NotImplementedError

    # --- the one public entry point ----------------------------------------
    def complete(self, request: CompletionRequest) -> ProviderResponse:
        """Run one inference. Raises :class:`ProviderUnavailable` on availability
        failures; DEGRADES (never raises) on an unparseable 200 body."""
        try:
            status, payload = self._transport(self._url(), self._headers(), self._to_wire(request))
        except Exception as exc:  # connection/timeout/etc. -> availability failure
            raise ProviderUnavailable(f"{self.name} transport error: {exc}") from exc

        if status in _UNAVAILABLE_STATUSES:
            raise ProviderUnavailable(f"{self.name} returned {status}")
        if status != 200:
            # A non-retryable 4xx (bad request etc.): degrade rather than 500.
            return self._degraded(payload)
        try:
            return self._parse(payload)
        except (KeyError, IndexError, TypeError, ValueError, AttributeError):
            return self._degraded(payload)

    def _degraded(self, payload: dict) -> ProviderResponse:
        text = _salvage_text(payload) or _DEGRADED_FALLBACK_TEXT
        return ProviderResponse(provider=self.name, text=text, stop_reason="parse_degraded")


class AnthropicProvider(_BaseProvider):
    name = "anthropic"

    def _url(self) -> str:
        return ANTHROPIC_URL

    def _headers(self) -> dict:
        return {
            "x-api-key": self._api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        }

    def _to_wire(self, request: CompletionRequest) -> dict:
        return {
            "model": self._model,
            "max_tokens": request.max_output_tokens,
            "system": request.system,
            "messages": request.messages,  # already Anthropic block shape
            "tools": request.tools,
        }

    def _parse(self, payload: dict) -> ProviderResponse:
        content = payload["content"]  # raises if missing -> degrade
        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        for block in content:
            btype = block.get("type")
            if btype == "text":
                text_parts.append(block.get("text", ""))
            elif btype == "tool_use":
                tool_calls.append(
                    ToolCall(id=block["id"], name=block["name"], arguments=block.get("input") or {})
                )
        usage = payload.get("usage") or {}
        stop = payload.get("stop_reason") or ("tool_use" if tool_calls else "end_turn")
        return ProviderResponse(
            provider=self.name,
            text="".join(text_parts),
            tool_calls=tool_calls,
            stop_reason=stop,
            usage=Usage(
                input_tokens=int(usage.get("input_tokens", 0)),
                output_tokens=int(usage.get("output_tokens", 0)),
            ),
        )


class OpenAIProvider(_BaseProvider):
    name = "openai"

    def _url(self) -> str:
        return OPENAI_URL

    def _headers(self) -> dict:
        return {
            "authorization": f"Bearer {self._api_key}",
            "content-type": "application/json",
        }

    def _to_wire(self, request: CompletionRequest) -> dict:
        return {
            "model": self._model,
            "max_tokens": request.max_output_tokens,
            "messages": _to_openai_messages(request.system, request.messages),
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": t["name"],
                        "description": t.get("description", ""),
                        "parameters": t.get("input_schema") or {},
                    },
                }
                for t in request.tools
            ],
        }

    def _parse(self, payload: dict) -> ProviderResponse:
        message = payload["choices"][0]["message"]  # raises -> degrade
        tool_calls: list[ToolCall] = []
        for tc in message.get("tool_calls") or []:
            fn = tc["function"]
            args = json.loads(fn.get("arguments") or "{}")
            tool_calls.append(ToolCall(id=tc["id"], name=fn["name"], arguments=args))
        usage = payload.get("usage") or {}
        return ProviderResponse(
            provider=self.name,
            text=message.get("content") or "",
            tool_calls=tool_calls,
            stop_reason="tool_use" if tool_calls else "end_turn",
            usage=Usage(
                input_tokens=int(usage.get("prompt_tokens", 0)),
                output_tokens=int(usage.get("completion_tokens", 0)),
            ),
        )


def _to_openai_messages(system: str, messages: list[dict]) -> list[dict]:
    """Translate the provider-agnostic (Anthropic-shaped) blocks to OpenAI's shape."""
    out: list[dict] = [{"role": "system", "content": system}]
    for m in messages:
        role = m["role"]
        content = m["content"]
        if isinstance(content, str):
            out.append({"role": role, "content": content})
            continue
        if role == "assistant":
            text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
            tool_calls = [
                {
                    "id": b["id"],
                    "type": "function",
                    "function": {"name": b["name"], "arguments": json.dumps(b.get("input") or {})},
                }
                for b in content
                if b.get("type") == "tool_use"
            ]
            msg: dict[str, Any] = {"role": "assistant", "content": text or None}
            if tool_calls:
                msg["tool_calls"] = tool_calls
            out.append(msg)
            continue
        # user turn: may carry tool_result blocks and/or text blocks
        results = [b for b in content if b.get("type") == "tool_result"]
        for tr in results:
            body = tr.get("content")
            out.append(
                {
                    "role": "tool",
                    "tool_call_id": tr["tool_use_id"],
                    "content": body if isinstance(body, str) else json.dumps(body),
                }
            )
        texts = [b["text"] for b in content if b.get("type") == "text"]
        if texts:
            out.append({"role": "user", "content": "\n".join(texts)})
    return out


def _salvage_text(payload: dict) -> str:
    """Best-effort text recovery from an otherwise-unparseable provider body."""
    try:
        for block in payload.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
                return str(block["text"])
    except (AttributeError, TypeError):
        pass
    try:
        msg = payload["choices"][0]["message"]
        if isinstance(msg.get("content"), str) and msg["content"]:
            return msg["content"]
    except (KeyError, IndexError, TypeError):
        pass
    return ""


# ----------------------------------------------------------------- the chain
class ProviderChain:
    """Ordered providers with first-success **pinning** and fallback-on-failure."""

    def __init__(self, providers: list[_BaseProvider]) -> None:
        self.providers = providers
        self._active: _BaseProvider | None = None

    def complete(self, request: CompletionRequest) -> ProviderResponse:
        if self._active is not None:
            # Pinned for the turn: a later failure is terminal (don't switch
            # providers mid-tool-loop — the message history is provider-native).
            try:
                return self._active.complete(request)
            except ProviderUnavailable as exc:
                raise AIUnavailableError(str(exc)) from exc

        last: Exception | None = None
        for provider in self.providers:
            try:
                resp = provider.complete(request)
            except ProviderUnavailable as exc:
                last = exc
                continue
            self._active = provider
            return resp
        raise AIUnavailableError(str(last) if last else "no provider available")


def build_provider_chain(
    *, env: Mapping[str, str] | None = None, transport: Transport | None = None
) -> ProviderChain:
    """Build the chain from env keys, read at call time (Anthropic, then OpenAI).

    An empty chain (no keys) signals AI-disabled to the loop (spec §8: no key ->
    zero provider calls, Penny hidden). ``transport`` is injectable for tests.
    """
    e = _env(env)
    providers: list[_BaseProvider] = []
    if e.get("ANTHROPIC_API_KEY"):
        providers.append(
            AnthropicProvider(
                api_key=e["ANTHROPIC_API_KEY"],
                model=resolve_anthropic_model(e),
                transport=transport,
            )
        )
    if e.get("OPENAI_API_KEY"):
        providers.append(
            OpenAIProvider(
                api_key=e["OPENAI_API_KEY"], model=resolve_openai_model(e), transport=transport
            )
        )
    return ProviderChain(providers)

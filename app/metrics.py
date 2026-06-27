"""app/metrics.py — per-provider observability + LLM cost metrics (M7.7, #95).

OPS_RUNBOOK §6.3 / PRD §27. The single emitter for launch-readiness observability:
per-provider latency/error/volume counters (``track`` / ``record_provider_call``),
server-computed LLM token+cost counters (``record_llm_usage``), and cost-control
verification counters (``incr`` for cache hit/miss + regen-blocked).

HARD invariant (SECURITY.md §6.3/§10): no secret ever lands in a metric or a
breadcrumb. The registry holds only provider labels + numbers, so ``snapshot`` is
secret-free by construction; ``scrub`` is the defense-in-depth redactor on every
log/breadcrumb value. Process-local + thread-safe (mirrors ``app/ratelimit.py``).
Sentry breadcrumbs are best-effort (no-op when ``sentry_sdk`` is absent).
"""
from __future__ import annotations

import logging
import os
import re
import threading
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from typing import Any

logger = logging.getLogger("app.metrics")

# Canonical provider labels (OPS_RUNBOOK §6.3) — stable triage join keys; the
# label never carries per-request detail (no URL, payload, or key).
PROVIDER_ANTHROPIC = "anthropic"
PROVIDER_OPENAI = "openai"
PROVIDER_PLACES = "google_places"
PROVIDER_CENSUS = "us_census"
PROVIDER_GITHUB = "github"
PROVIDER_CRM = "crm"

PROVIDERS: tuple[str, ...] = (
    PROVIDER_ANTHROPIC,
    PROVIDER_OPENAI,
    PROVIDER_PLACES,
    PROVIDER_CENSUS,
    PROVIDER_GITHUB,
    PROVIDER_CRM,
)
# Providers that bill per token (so token/cost counters apply).
LLM_PROVIDERS: tuple[str, ...] = (PROVIDER_ANTHROPIC, PROVIDER_OPENAI)

# Cost-control verification counters (PRD §16.6/§27 — research/narrative caching,
# narrative regeneration cap).
COUNTER_RESEARCH_CACHE_HIT = "research_cache_hit"
COUNTER_RESEARCH_CACHE_MISS = "research_cache_miss"
COUNTER_NARRATIVE_CACHE_HIT = "narrative_cache_hit"
COUNTER_NARRATIVE_CACHE_MISS = "narrative_cache_miss"
COUNTER_NARRATIVE_REGEN_BLOCKED = "narrative_regen_blocked"

COUNTERS: tuple[str, ...] = (
    COUNTER_RESEARCH_CACHE_HIT,
    COUNTER_RESEARCH_CACHE_MISS,
    COUNTER_NARRATIVE_CACHE_HIT,
    COUNTER_NARRATIVE_CACHE_MISS,
    COUNTER_NARRATIVE_REGEN_BLOCKED,
)

# Default LLM pricing in USD per 1,000,000 tokens (input, output). Anthropic =
# Claude Opus 4.8 list price ($5/$25), the project's default model; OpenAI carries
# an illustrative default. Overridable per provider via env
# (LLM_PRICE_<PROVIDER>_INPUT / _OUTPUT). Cost is computed server-side — never by a
# client.
_DEFAULT_PRICING: dict[str, tuple[float, float]] = {
    PROVIDER_ANTHROPIC: (5.00, 25.00),
    PROVIDER_OPENAI: (2.50, 10.00),
}

# Secret env var NAMES whose live VALUES must never appear in a log/metric.
_SECRET_ENV_VARS: tuple[str, ...] = (
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_PLACES_API_KEY",
    "CENSUS_API_KEY",
    "GITHUB_TOKEN",
    "CRM_API_KEY",
    "METRICS_TOKEN",
)


# Registry (process-local, thread-safe).
class _Registry:
    """In-process rolling counters. Reset between tests via ``reset()``."""

    def __init__(self) -> None:
        self.calls: dict[str, int] = {}
        self.errors: dict[str, int] = {}
        self.latency_ms_total: dict[str, float] = {}
        self.input_tokens: dict[str, int] = {}
        self.output_tokens: dict[str, int] = {}
        self.cost_usd: dict[str, float] = {}
        self.counters: dict[str, int] = {}


_lock = threading.Lock()
_registry = _Registry()


def reset() -> None:
    """Test hook: drop all counters."""
    global _registry
    with _lock:
        _registry = _Registry()


# Recording seams.
def record_provider_call(provider: str, *, latency_ms: float, ok: bool = True) -> None:
    """Record one external-provider call: volume, latency, and (on failure) error.

    The provider label is the only string stored — never the URL, payload, or key.
    """
    with _lock:
        _registry.calls[provider] = _registry.calls.get(provider, 0) + 1
        _registry.latency_ms_total[provider] = (
            _registry.latency_ms_total.get(provider, 0.0) + float(latency_ms)
        )
        if not ok:
            _registry.errors[provider] = _registry.errors.get(provider, 0) + 1


def record_llm_usage(
    provider: str,
    *,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float | None = None,
) -> None:
    """Accumulate LLM token usage + cost for an AI provider.

    ``cost_usd`` is computed server-side from the pricing table when not supplied;
    an explicit value is accepted for callers with a provider-reported cost. Only
    the integer counts + derived dollar figure are recorded — never the prompt.
    """
    cost = (
        cost_usd
        if cost_usd is not None
        else _compute_cost(provider, input_tokens, output_tokens)
    )
    with _lock:
        _registry.input_tokens[provider] = (
            _registry.input_tokens.get(provider, 0) + int(input_tokens)
        )
        _registry.output_tokens[provider] = (
            _registry.output_tokens.get(provider, 0) + int(output_tokens)
        )
        _registry.cost_usd[provider] = _registry.cost_usd.get(provider, 0.0) + cost


def incr(counter: str, n: int = 1) -> None:
    """Increment a named cost-control counter (cache hit/miss, regen-blocked)."""
    with _lock:
        _registry.counters[counter] = _registry.counters.get(counter, 0) + n


@contextmanager
def track(provider: str, *, event: str = "call") -> Iterator[None]:
    """Time a provider call site, record volume + latency, and flag errors.

    Records the call whether it succeeds or raises (an attempt is still volume),
    marks the error counter on an exception, emits a scrubbed breadcrumb, and
    re-raises so behavior is unchanged.
    """
    start = time.perf_counter()
    ok = True
    try:
        yield
    except Exception:
        ok = False
        raise
    finally:
        latency_ms = (time.perf_counter() - start) * 1000.0
        record_provider_call(provider, latency_ms=latency_ms, ok=ok)
        log_event(provider, event, latency_ms=round(latency_ms, 3), ok=ok)


# Pricing / cost (server-authoritative).
def _price_pair(provider: str, env: Mapping[str, str]) -> tuple[float, float]:
    base = _DEFAULT_PRICING.get(provider, (0.0, 0.0))
    pin = _as_float(env.get(f"LLM_PRICE_{provider.upper()}_INPUT"), base[0])
    pout = _as_float(env.get(f"LLM_PRICE_{provider.upper()}_OUTPUT"), base[1])
    return pin, pout


def _as_float(raw: str | None, default: float) -> float:
    try:
        return float(raw) if raw is not None and raw != "" else default
    except (TypeError, ValueError):
        return default


def _compute_cost(provider: str, input_tokens: int, output_tokens: int) -> float:
    pin, pout = _price_pair(provider, os.environ)
    return (input_tokens / 1_000_000.0) * pin + (output_tokens / 1_000_000.0) * pout


def cost_usd(provider: str, input_tokens: int, output_tokens: int) -> float:
    """Server-computed USD cost for a token spend (read pricing at call time)."""
    return _compute_cost(provider, input_tokens, output_tokens)


def estimate_tokens(text: str) -> int:
    """A bounded ~4-chars-per-token heuristic for when no provider count exists."""
    if not text:
        return 0
    return len(text) // 4


# Snapshot — secret-free by construction.
def snapshot() -> dict[str, Any]:
    """Rolling counters as a plain dict. Carries provider labels + numbers only."""
    with _lock:
        providers: dict[str, Any] = {}
        total_in = total_out = 0
        total_cost = 0.0
        for label in PROVIDERS:
            calls = _registry.calls.get(label, 0)
            errors = _registry.errors.get(label, 0)
            latency_total = _registry.latency_ms_total.get(label, 0.0)
            in_tok = _registry.input_tokens.get(label, 0)
            out_tok = _registry.output_tokens.get(label, 0)
            cost = _registry.cost_usd.get(label, 0.0)
            providers[label] = {
                "calls": calls,
                "errors": errors,
                "error_rate": round(errors / calls, 4) if calls else 0.0,
                "avg_latency_ms": round(latency_total / calls, 3) if calls else 0.0,
                "input_tokens": in_tok,
                "output_tokens": out_tok,
                "cost_usd": round(cost, 6),
            }
            total_in += in_tok
            total_out += out_tok
            total_cost += cost
        counters = {name: _registry.counters.get(name, 0) for name in COUNTERS}
        # Include any ad-hoc counters that were incremented under a custom name.
        for name, val in _registry.counters.items():
            counters.setdefault(name, val)
    return {
        "providers": providers,
        "counters": counters,
        "totals": {
            "llm_input_tokens": total_in,
            "llm_output_tokens": total_out,
            "llm_cost_usd": round(total_cost, 6),
        },
    }


# Secret scrubbing (defense-in-depth for structured logs / breadcrumbs).
_REDACTED = "[redacted]"
# A Bearer prefix followed by anything.
_BEARER_RE = re.compile(r"\bBearer\s+\S+", re.IGNORECASE)
# Provider key shapes: OpenAI sk-, Google AIza, GitHub ghp_/github_pat_.
_KEY_PREFIX_RE = re.compile(
    r"\b(?:sk-[A-Za-z0-9._-]{6,}|AIza[0-9A-Za-z._-]{6,}"
    r"|ghp_[A-Za-z0-9]{6,}|github_pat_[A-Za-z0-9_]{6,})\b"
)
# A high-entropy capability token (>=20 base64url chars mixing a letter + digit),
# matching app/feedback/redact.py's token_urlsafe shape — bounded so ordinary
# prose and short labels survive.
_HIENTROPY_RE = re.compile(
    r"\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b"
)
# Dollar amounts and bare percentages (financial fields never leave the server).
_MONEY_RE = re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?")
_PERCENT_RE = re.compile(r"\b\d+(?:\.\d+)?\s?%")


def _scrub_str(s: str) -> str:
    # 1) the live secret env VALUES (exact, even if short).
    for name in _SECRET_ENV_VARS:
        val = os.environ.get(name)
        if val and len(val) >= 4 and val in s:
            s = s.replace(val, _REDACTED)
    # 2) shape-based redaction.
    s = _BEARER_RE.sub("Bearer " + _REDACTED, s)
    s = _KEY_PREFIX_RE.sub(_REDACTED, s)
    s = _MONEY_RE.sub(_REDACTED, s)
    s = _PERCENT_RE.sub(_REDACTED, s)
    s = _HIENTROPY_RE.sub(_REDACTED, s)
    return s


def scrub(value: Any) -> Any:
    """Recursively redact secrets/financial fields from a log/breadcrumb value."""
    if isinstance(value, str):
        return _scrub_str(value)
    if isinstance(value, Mapping):
        return {k: scrub(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [scrub(v) for v in value]
    return value


# Structured logging + Sentry breadcrumb (both scrubbed).
def log_event(provider: str, event: str, **fields: Any) -> None:
    """Emit a scrubbed structured provider breadcrumb to logs (+ Sentry if present).

    Every field value is run through ``scrub`` first, so a caller that accidentally
    passes a key-bearing URL or an Authorization header cannot leak it. The
    provider label and event name are trusted constants.
    """
    safe_fields = {k: scrub(v) for k, v in fields.items()}
    logger.info(
        "provider_metric provider=%s event=%s %s", provider, event, safe_fields
    )
    _sentry_breadcrumb(provider, event, safe_fields)


def _sentry_breadcrumb(provider: str, event: str, data: dict[str, Any]) -> None:
    """Best-effort Sentry breadcrumb. No-op when sentry_sdk is not installed."""
    try:
        import sentry_sdk  # type: ignore[import-not-found]
    except Exception:
        return
    try:
        sentry_sdk.add_breadcrumb(
            category="provider",
            message=f"{provider}.{event}",
            level="info",
            data=data,
        )
    except Exception:  # breadcrumbs are never load-bearing
        return

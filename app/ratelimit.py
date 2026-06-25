"""app/ratelimit.py — a small in-memory fixed-window rate limiter (SECURITY §10.1).

Tokens are free to mint, so every expensive/abusable endpoint is capped on both
axes (per IP and per token). This is the v1 brake: a process-local sliding-ish
fixed-window counter keyed by (scope, key, endpoint). It is intentionally simple
— a single-process Railway service with serialized writes — and is swapped for a
shared store if/when the service scales horizontally.

`check(...)` returns (allowed, retry_after_seconds). On breach the router emits
429 + Retry-After BEFORE doing any work (no GitHub call, no DB write).
"""
from __future__ import annotations

import threading
import time

_lock = threading.Lock()
# (endpoint, scope, key) -> list[timestamps] within the current window.
_hits: dict[tuple[str, str, str], list[float]] = {}


def reset_rate_limits() -> None:
    """Test hook: clear all counters."""
    with _lock:
        _hits.clear()


def check(
    endpoint: str,
    *,
    ip: str | None = None,
    token: str | None = None,
    ip_limit: int,
    token_limit: int | None = None,
    window_seconds: int = 3600,
) -> tuple[bool, int]:
    """Return (allowed, retry_after_seconds). Records the hit when allowed.

    Per-IP and per-token windows are checked independently; either breach
    rejects. The window is a fixed lookback of ``window_seconds``.
    """
    now = time.time()
    cutoff = now - window_seconds
    with _lock:
        for scope, key, limit in (
            ("ip", ip, ip_limit),
            ("token", token, token_limit),
        ):
            if key is None or limit is None:
                continue
            k = (endpoint, scope, key)
            hits = [t for t in _hits.get(k, ()) if t > cutoff]
            _hits[k] = hits
            if len(hits) >= limit:
                retry = int(hits[0] + window_seconds - now) + 1
                return False, max(retry, 1)
        # Allowed: record the hit on every active scope.
        for scope, key in (("ip", ip), ("token", token)):
            if key is None:
                continue
            k = (endpoint, scope, key)
            _hits.setdefault(k, []).append(now)
    return True, 0

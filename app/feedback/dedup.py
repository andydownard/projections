"""app/feedback/dedup.py — server-side dedup for Penny-filed feedback (Epic F, #12).

Penny files product feedback at her discretion, so the SAME chat (or a retry, or a
re-phrasing that redacts down to the same qualitative body) can drive duplicate
GitHub issues. This is a small, process-local guard: a duplicate is the SHA-256 of
the REDACTED body, scoped to the filing identity, within a fixed lookback window.

It mirrors :mod:`app.ratelimit`: an in-memory fixed-window map keyed by
``(identity, body_hash)`` on a single-process Railway service. The hash is taken
over the ALREADY-REDACTED body (no raw figures/links/slugs ever enter the key), and
the identity is the server-only filer identity (hashed token / Clerk sub / IP) — so
the dedup state itself leaks nothing.

API:
  * ``is_duplicate(identity, redacted_body)`` — read-only check (records nothing).
  * ``record(identity, redacted_body)`` — remember a body we actually filed.
Split so a body that was checked but NOT filed (e.g. rejected by the rate limit) is
never remembered, so a later legitimate retry is not spuriously deduped.
"""
from __future__ import annotations

import hashlib
import threading
import time

DEFAULT_WINDOW_SECONDS = 3600

_lock = threading.Lock()
# (identity, body_hash) -> last-seen unix timestamp.
_seen: dict[tuple[str, str], float] = {}


def reset_dedup() -> None:
    """Test hook: clear all dedup state (the map is process-global)."""
    with _lock:
        _seen.clear()


def body_hash(redacted_body: str | None) -> str:
    """SHA-256 hex of the redacted body — the dedup fingerprint."""
    return hashlib.sha256((redacted_body or "").encode("utf-8")).hexdigest()


def _key(identity: str, redacted_body: str | None) -> tuple[str, str]:
    return (identity, body_hash(redacted_body))


def is_duplicate(
    identity: str,
    redacted_body: str | None,
    *,
    window_seconds: int = DEFAULT_WINDOW_SECONDS,
) -> bool:
    """Return True if this identity already filed this redacted body in the window.

    Read-only: it records nothing, so the caller can decide to file (then
    :func:`record`) or to bail out without poisoning the window.
    """
    now = time.time()
    cutoff = now - window_seconds
    k = _key(identity, redacted_body)
    with _lock:
        last = _seen.get(k)
        return last is not None and last > cutoff


def record(identity: str, redacted_body: str | None) -> None:
    """Remember a redacted body we just filed for this identity."""
    k = _key(identity, redacted_body)
    with _lock:
        _seen[k] = time.time()

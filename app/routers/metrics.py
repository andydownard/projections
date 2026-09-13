"""app/routers/metrics.py — GET /api/metrics (owner/admin-gated, M7.7, #95).

OPS_RUNBOOK §6.3: a lightweight, owner/admin-gated surface that exposes the
per-provider rolling counters (latency / error / volume), the LLM token+cost
totals, and the cost-control verification counters (cache hit/miss, regen-blocked).

Gate (SECURITY.md §2/§4 — secrets are server-env only, no fallback chain):
  * ``METRICS_TOKEN`` UNSET  -> 404. The endpoint does not exist; it is never an
    open surface, and an unauthenticated probe learns nothing about its presence.
  * Missing Authorization    -> 401.
  * Wrong bearer             -> 403 (constant-time compare; the token never
    appears in a path/query/log).
  * Correct bearer           -> 200 with the secret-free ``metrics.snapshot()``.

Read-only by construction (only GET is registered). The token is read at call
time, never cached at import (mirrors app/config.py's no-module-load-caching
policy).
"""
from __future__ import annotations

# ruff: noqa: UP045 -- keep typing.Optional: FastAPI evaluates this dependency's
# annotation at runtime, and PEP 604 `X | None` is unsupported on Python 3.9.
import hashlib
import hmac
import os
from typing import Optional

from fastapi import APIRouter, Header, HTTPException

from app import metrics

router = APIRouter(tags=["metrics"])


def _hash_token(token: str) -> str:
    """SHA-256 hex of the admin ``METRICS_TOKEN`` bearer.

    This is the ONLY auth gate left in the app (an internal ops endpoint, not part
    of the product's data model — the rest of the app has no authentication at all,
    owner decision 2026-09-13). Self-contained here rather than in ``app.deps``.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _token_matches(presented: str, stored_hash: str) -> bool:
    """Constant-time compare — NEVER `==` on a token/hash (timing leak)."""
    return hmac.compare_digest(_hash_token(presented), stored_hash)


def _bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return None


@router.get("/api/metrics")
def get_metrics(authorization: Optional[str] = Header(default=None)) -> dict:
    """Return the rolling per-provider/cost counters for the METRICS_TOKEN holder."""
    configured = os.environ.get("METRICS_TOKEN")
    if not configured:
        # Endpoint disabled — do not reveal that it exists.
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    presented = _bearer(authorization)
    if presented is None:
        raise HTTPException(status_code=401, detail={"error": "unauthorized"})
    if not _token_matches(presented, _hash_token(configured)):
        raise HTTPException(status_code=403, detail={"error": "forbidden"})

    return metrics.snapshot()

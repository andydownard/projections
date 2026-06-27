"""app/health.py — subsystem health assessment (#190, API_SPEC §10 / OPS_RUNBOOK §6.1).

The primary ``GET /api/health`` is the Railway deploy gate AND a deploy smoke test
(``scripts/promote.py``) — both depend on a **200 with the exact**
``{status, build_sha, model_version, db, litestream}`` **shape when actually
healthy**, so the primary endpoint must NEVER flap to non-200 on a transient blip
(that fail-loops deploys). The fix for "fails open" is therefore split in two:

1. The primary endpoint stops hard-coding ``status:"ok"`` — ``status`` now reflects
   REAL subsystem state (``ok`` / ``degraded`` / ``unhealthy``), surfaced LOUDLY in
   the body while the HTTP code stays 200.
2. A separate, deeper readiness probe (``GET /api/health/ready``) returns **HTTP
   503** when the data path is down, so external monitoring can alert on the broken
   instance that the deploy gate must keep treating as 200.

This module is pure decision logic (no I/O) so the status matrix is unit-testable
without booting the app; the router supplies the live ``db_ok`` / ``litestream``
signals.
"""
from __future__ import annotations

import time

STATUS_OK = "ok"
STATUS_DEGRADED = "degraded"
STATUS_UNHEALTHY = "unhealthy"

# Process start, captured once at import — uptime distinguishes a fresh boot from a
# long-running instance during deploy verification (OPS_RUNBOOK §6.1 fallback).
_BOOT_MONOTONIC = time.monotonic()


def uptime_seconds(now: float | None = None) -> int:
    """Whole seconds since process start (monotonic; never negative)."""
    current = time.monotonic() if now is None else now
    return max(0, int(current - _BOOT_MONOTONIC))


def assess_status(*, db_ok: bool, litestream: str, production: bool) -> str:
    """Roll subsystem signals into one overall status.

    - DB unavailable -> ``unhealthy``: the data path is broken (every projection
      read/write would 500). The loudest signal, in EVERY environment.
    - Replication off **in production** -> ``degraded``: backups must never be
      silently off (OPS_RUNBOOK §4.3). In dev/test, litestream ``disabled`` is the
      expected default and stays ``ok`` so local/CI health is not falsely degraded.
    - Otherwise -> ``ok``.
    """
    if not db_ok:
        return STATUS_UNHEALTHY
    if production and litestream != "replicating":
        return STATUS_DEGRADED
    return STATUS_OK

"""Single-sourced router plumbing helpers.

These were copy-pasted across most routers (``projections``, ``penny``, ``feedback``,
``research``, ``places``, ``intent``, ``cost_schedule``). Extracting them here removes
drift risk on the security-relevant one that remains:

- ``client_ip`` — the right-most, un-spoofable X-Forwarded-For hop. Railway terminates
  TLS at a single proxy that APPENDS the real client IP as the LAST XFF entry, so the
  right-most hop is the only one a caller cannot spoof (anything it injects arrives to
  the LEFT of the proxy's append). Using the raw socket peer would collapse every
  external caller onto the proxy's shared internal IP — one global rate-limit bucket
  (SECURITY §10; issue #189).
- ``utcnow`` — the ISO-8601 ``...Z`` timestamp string stamped on rows/records.

This project has no authentication or authorization (owner decision, 2026-09-13);
the former ``bearer``/``is_owner``/``is_editor`` capability-token gates that used to
live here are gone. Behavior of what remains is byte-identical to before.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import Request


def client_ip(request: Request) -> str:
    """Right-most untrusted hop from X-Forwarded-For, else the socket peer (SECURITY §10)."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def utcnow() -> str:
    """Current UTC instant as an ISO-8601 ``YYYY-MM-DDTHH:MM:SSZ`` string."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

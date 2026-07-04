"""Single-sourced router plumbing helpers.

These four helpers were copy-pasted across most routers (``projections``, ``penny``,
``feedback``, ``research``, ``places``, ``intent``, ``cost_schedule``). Extracting them
here removes the drift risk on the two security-relevant ones:

- ``client_ip`` — the right-most, un-spoofable X-Forwarded-For hop. Railway terminates
  TLS at a single proxy that APPENDS the real client IP as the LAST XFF entry, so the
  right-most hop is the only one a caller cannot spoof (anything it injects arrives to
  the LEFT of the proxy's append). Using the raw socket peer would collapse every
  external caller onto the proxy's shared internal IP — one global rate-limit bucket
  (SECURITY §10; issue #189).
- ``bearer`` — the capability-token extractor. Case-sensitive ``Bearer `` scheme; an
  empty payload coerces to ``None`` so a bare ``Authorization: Bearer`` is treated as no
  token (never an empty-string bucket key or a "" owner match).
- ``is_owner`` / ``is_editor`` — owner/editor capability gates. Both compare through
  ``app.deps.token_matches`` (``hmac.compare_digest`` over the SHA-256 digest), so the
  comparison stays constant-time and the plaintext secret is never stored.
- ``utcnow`` — the ISO-8601 ``...Z`` timestamp string stamped on rows/records.

Behavior is byte-identical to the pre-extraction copies; the per-router names are kept
as thin aliases (e.g. ``_client_ip = client_ip``) so no call site changed. Note that
``penny._client_ip`` is intentionally NOT unified here: it has divergent ``Optional``
semantics (accepts ``Optional[Request]``, returns ``Optional[str]``) and keeps its own
local definition.
"""
from __future__ import annotations

# ruff: noqa: UP045 -- keep typing.Optional: matches the routers this consolidates and
# stays valid on Python 3.9 (PEP 604 `X | None` is unavailable at runtime there).
from datetime import datetime, timezone
from typing import Optional

from fastapi import Request

from app.deps import token_matches


def client_ip(request: Request) -> str:
    """Right-most untrusted hop from X-Forwarded-For, else the socket peer (SECURITY §10)."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def bearer(authorization: Optional[str]) -> Optional[str]:
    """Extract the token from ``Authorization: Bearer <tok>``; empty/absent -> None."""
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:].strip() or None
    return None


def utcnow() -> str:
    """Current UTC instant as an ISO-8601 ``YYYY-MM-DDTHH:MM:SSZ`` string."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_owner(token: Optional[str], row: dict) -> bool:
    """True iff ``token`` is the row's owner capability (constant-time compare)."""
    return token is not None and token_matches(token, row["owner_token_hash"])


def is_editor(token: Optional[str], row: dict) -> bool:
    """True iff ``token`` is the row's edit capability (constant-time compare).

    A row with no edit token (NULL ``edit_token_hash``) never grants edit, even when a
    token is presented — the empty-hash guard prevents a NULL == NULL cross-grant.
    """
    return (
        token is not None
        and bool(row.get("edit_token_hash"))
        and token_matches(token, row["edit_token_hash"])
    )

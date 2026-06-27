"""app/penny/proposal.py — Penny proposal upload intake (Spec B §9/§12; issue #124).

**Intake only.** This module accepts a consultant proposal PDF server-side as
*untrusted bytes*, validates it (type + size), and hands back an opaque
``proposal_ref`` the Penny loop can later thread into the ``parse_proposal`` tool.
The actual extraction (PDF → candidate cost rows) is **PE9** — nothing here parses,
executes, or renders the document; the bytes are simply held behind a ref.

Guards (SECURITY §6.3 / §7):

- **Type** — the upload must be a real PDF: magic-byte sniff (``%PDF-``) is the
  authority (a forgeable ``Content-Type``/filename is advisory only).
- **Size** — capped at :data:`MAX_PROPOSAL_BYTES` so a huge body can't exhaust
  memory; read at call time so a test can shrink the cap.
- **SSRF** — there is **no server-side fetch** of a user-supplied URL in this
  slice (the strongest SSRF posture is "never fetch attacker input"). The guard
  seam :func:`assert_safe_source_url` reuses the research fetcher's IP/scheme
  validation so a future remote-intake path (PE9) cannot be steered at the private
  network or the cloud-metadata endpoint; a blocked URL raises here, fail-closed.

Storage is a process-local map keyed by a random ref — adequate for the intake
seam on a single-process service; PE9 swaps it for durable, parse-backed storage.
"""
from __future__ import annotations

import secrets
import threading
from datetime import datetime, timezone

from app.research.fetch import BlockedURLError, Resolver, validate_url_scheme_host

# A PDF body over this is rejected (413). Read at call time so tests can shrink it.
MAX_PROPOSAL_BYTES = 15 * 1024 * 1024  # 15 MiB

# The magic-byte signature every PDF starts with — the real type authority.
_PDF_MAGIC = b"%PDF-"


class ProposalTooLarge(Exception):
    """The uploaded body exceeds :data:`MAX_PROPOSAL_BYTES` (-> 413)."""


class ProposalBadType(Exception):
    """The upload is not a PDF (magic-byte sniff failed) (-> 415)."""


class ProposalBlockedSource(BlockedURLError):
    """A source URL resolves to a blocked range / bad scheme (-> 422 ssrf_blocked)."""


# process-local ref -> stored upload metadata + bytes (intake seam; PE9 durable).
_lock = threading.Lock()
_store: dict[str, dict] = {}


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def reset_proposals() -> None:
    """Test hook: drop all held uploads."""
    with _lock:
        _store.clear()


def validate_pdf(data: bytes) -> None:
    """Reject a non-PDF or oversize body (size before type so a huge non-PDF still 413s).

    The magic-byte sniff is the authority — a forgeable ``Content-Type`` header or
    ``.pdf`` filename is never trusted on its own (SECURITY §6.3).
    """
    if len(data) > MAX_PROPOSAL_BYTES:
        raise ProposalTooLarge(f"proposal exceeds {MAX_PROPOSAL_BYTES} bytes")
    if not data.startswith(_PDF_MAGIC):
        raise ProposalBadType("upload is not a PDF (missing %PDF- signature)")


def store_proposal(
    data: bytes, *, filename: str | None = None, content_type: str | None = None
) -> str:
    """Validate + hold the untrusted bytes; return an opaque ``proposal_ref``.

    The bytes are NEVER parsed, executed, or rendered here — only held behind a
    random ref for the Penny loop's ``parse_proposal`` tool (full parse: PE9).
    """
    validate_pdf(data)
    ref = "prop_" + secrets.token_urlsafe(18)
    with _lock:
        _store[ref] = {
            "ref": ref,
            "filename": filename,
            "content_type": content_type,
            "size": len(data),
            "data": data,
            "created_at": _utcnow(),
        }
    return ref


def get_proposal(ref: str) -> dict | None:
    """Return held upload metadata (+ bytes) for ``ref``, or None."""
    with _lock:
        return _store.get(ref)


def assert_safe_source_url(url: str, *, resolver: Resolver | None = None) -> str:
    """SSRF guard for any future remote proposal intake (returns the validated IP).

    Reuses the research fetcher's scheme allowlist + private/loopback/link-local/
    metadata IP rejection. Raises :class:`ProposalBlockedSource` on a blocked host
    so the caller fails closed (no fetch toward the private network is ever
    attempted).
    """
    try:
        return validate_url_scheme_host(url, resolver=resolver)
    except BlockedURLError as exc:
        raise ProposalBlockedSource(str(exc)) from exc

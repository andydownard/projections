"""app/deps.py — auth resolution + If-Match parsing scaffold (SECURITY.md §2.4).

Resolves Authorization: Bearer <secret> -> owner/edit/role via SHA-256 +
hmac.compare_digest (constant-time). view_slug is the plaintext lookup key. Secrets
never appear in path/query/logs.

M0 ships the token primitives (hash + constant-time compare) and the If-Match
parser; the full FastAPI dependency that resolves a request to a scope lands with
the projections router (M2.1/M2.2). Building these now keeps the security invariants
testable from commit one.
"""
from __future__ import annotations

# ruff: noqa: UP045 -- keep typing.Optional: FastAPI evaluates this dependency's
# annotation at runtime, and PEP 604 `X | None` is unsupported on Python 3.9.
import hashlib
import hmac
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Optional, Union

from fastapi import Header, HTTPException

from app import config


def hash_token(token: str) -> str:
    """SHA-256 hex of a high-entropy capability token (SECURITY.md §2.3).

    A slow KDF buys nothing for 256-bit random secrets; a fast cryptographic hash
    plus constant-time compare is correct.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def token_matches(presented: str, stored_hash: str) -> bool:
    """Constant-time compare — NEVER `==` on a token/hash (timing leak)."""
    return hmac.compare_digest(hash_token(presented), stored_hash)


# --- Bearer identity resolution (capability token ⊕ Clerk JWT) --------------
# COOKIE-BLIND: identity is resolved ONLY from the Authorization header — NEVER a
# cookie (SECURITY.md §2.6, Regression #11). A request carrying a valid Clerk
# `__session` cookie but no Authorization header is `Anonymous`, so there is no
# ambient credential our API trusts ⇒ structurally no CSRF.


@dataclass(frozen=True)
class Anonymous:
    """No (usable) bearer was presented."""


@dataclass(frozen=True)
class ClerkOwner:
    """A verified Clerk session identity (owner scope keyed on these)."""

    clerk_user_id: str
    org_id: Optional[str] = None


@dataclass(frozen=True)
class CapabilityBearer:
    """An opaque capability token to be compared against per-row owner/edit/role
    hashes (the existing model). Carries the raw token; the router does the
    constant-time compare exactly as today."""

    token: str


Identity = Union[Anonymous, ClerkOwner, CapabilityBearer]


def _extract_bearer(authorization: Optional[str]) -> Optional[str]:
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:].strip() or None
    return None


def resolve_bearer_identity(
    authorization: Optional[str] = Header(default=None),
    *,
    env: Optional[Mapping[str, str]] = None,
) -> Identity:
    """Resolve an Authorization header to exactly one identity — never raising.

    Resolution order (plan §1), COOKIE-BLIND and fail-closed:
      1. No/blank Bearer ⇒ ``Anonymous``.
      2. ``CLERK_ENABLED`` on AND the token is JWT-shaped (3 segments, RS256+kid)
         AND it verifies against the issuer's JWKS ⇒ ``ClerkOwner``.
      3. Otherwise ⇒ ``CapabilityBearer`` (the opaque-token path, unchanged). A
         JWT-shaped-but-invalid token (wrong iss/exp/azp/sig) falls through here
         and will match no owner hash → effectively anonymous (fail-closed, no 500).

    With the kill switch off, step 2 is skipped entirely, so a Clerk JWT is just an
    unrecognized bearer and the capability flow is byte-for-byte unchanged.
    """
    token = _extract_bearer(authorization)
    if token is None:
        return Anonymous()

    if config.clerk_enabled(env):
        # Lazy import keeps `app.deps` import-light and the verifier monkeypatchable.
        from app.clerk import (
            ClerkVerificationError,
            looks_like_jwt,
            verify_clerk_session_token,
        )

        if looks_like_jwt(token):
            cfg = config.clerk_config(env)
            try:
                ident = verify_clerk_session_token(
                    token,
                    issuer=cfg["issuer"],
                    authorized_parties=cfg["authorized_parties"],
                    leeway=cfg["leeway_seconds"],
                )
                return ClerkOwner(ident.clerk_user_id, ident.org_id)
            except ClerkVerificationError:
                # Present-but-invalid Clerk JWT → fall through, fail-closed.
                pass

    return CapabilityBearer(token)


def parse_if_match(if_match: Optional[str] = Header(default=None)) -> int:
    """Parse the If-Match: <version> header for optimistic concurrency.

    Every mutation requires it (SECURITY.md §6.1). Missing/non-integer -> 428.
    """
    if if_match is None:
        raise HTTPException(status_code=428, detail={"error": "if_match_required"})
    raw = if_match.strip().strip('"')
    try:
        return int(raw)
    except ValueError as err:
        raise HTTPException(
            status_code=400, detail={"error": "invalid_if_match"}
        ) from err

"""app/clerk/verify.py — networkless Clerk session-JWT verifier (SECURITY.md §2.6).

A cookie-blind, JWKS-Bearer verifier that mirrors timpager/lib/clerk-jwt-verify.js
1:1: RS256 ONLY (no alg-confusion / ``none``), the signing key resolved by ``kid``
from the issuer's JWKS, ``iss`` mandatory and **fail-closed** (an unset issuer
raises — never accepts), ``exp``/``nbf`` enforced with a small clock-skew leeway,
and an ``azp`` (authorized-parties) allowlist that is *stricter* than both pennyai
and vibe101 (which omit it) — a cross-apex satellite widens the set of origins that
can mint JWKS-valid tokens, so we pin the authorized party.

projections is a Clerk SATELLITE/daughter: it holds **no Clerk secret** (security
finding C1). Verification is public-key only against the primary's JWKS. The session
JWT's ``iss`` stays the PRIMARY (``https://clerk.rallytasks.com``) even though the
browser's Frontend API is the satellite host — so ``CLERK_JWT_ISSUER`` pins the
primary issuer for verification (§2A.3 of the plan).

No code here ever reads a cookie. The caller passes the raw Bearer token string.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import jwt

# Clock-skew leeway default (seconds) — mirrors timpager's CLERK_JWT_LEEWAY default.
DEFAULT_LEEWAY_SECONDS = 10

# RS256 ONLY. Pinning the allowed-algorithm list at decode time is what defeats the
# alg-confusion family (HS256 signed with the RSA public-key bytes; ``alg: none``).
_ALLOWED_ALGS = ["RS256"]


class ClerkVerificationError(Exception):
    """Raised whenever a presented token is not a valid Clerk session JWT.

    Fail-closed: the resolver treats this as "not a Clerk identity" and falls
    through to the capability-token path (never a 500, never a silent accept).
    """


@dataclass(frozen=True)
class ClerkIdentity:
    """The verified caller identity. ``org_id`` is present only for org-scoped
    sessions (v1 keys owner-scope on ``clerk_user_id``; ``org_id`` is stored for a
    later org-scoped list — plan §12)."""

    clerk_user_id: str
    org_id: str | None
    claims: dict


def looks_like_jwt(token: str | None) -> bool:
    """Shape-route a Bearer to Clerk-verify vs the opaque capability path.

    True only for a three-segment token whose decodable header is ``alg: RS256``
    with a ``kid`` — i.e. a Clerk session JWT. An opaque ``secrets.token_urlsafe``
    capability token (no JWT structure), an HS256 token, or anything malformed
    returns False, so misclassification fails closed onto the capability compare.
    """
    if not token or token.count(".") != 2:
        return False
    try:
        header = jwt.get_unverified_header(token)
    except Exception:
        return False
    return header.get("alg") in _ALLOWED_ALGS and bool(header.get("kid"))


# --- JWKS client (production path) ------------------------------------------
# A per-issuer cached PyJWKClient fetches/caches the JWKS at
# ``<issuer>/.well-known/jwks.json`` and refreshes on an unknown ``kid``. Tests
# NEVER hit this — they inject a stub ``jwks`` (no network).
_JWKS_CLIENTS: dict[str, Any] = {}


def _get_jwks_client(issuer: str) -> Any:
    client = _JWKS_CLIENTS.get(issuer)
    if client is None:
        # Imported lazily so a misconfigured/disabled deployment never pays the
        # PyJWKClient construction cost and the symbol stays monkeypatchable.
        from jwt import PyJWKClient

        client = PyJWKClient(f"{issuer.rstrip('/')}/.well-known/jwks.json")
        _JWKS_CLIENTS[issuer] = client
    return client


def reset_jwks_cache() -> None:
    """Test/ops hook — drop the cached JWKS clients."""
    _JWKS_CLIENTS.clear()


def verify_clerk_session_token(
    token: str,
    *,
    issuer: str | None,
    authorized_parties: Sequence[str] | None = None,
    leeway: int = DEFAULT_LEEWAY_SECONDS,
    audience: str | None = None,
    jwks: Any = None,
) -> ClerkIdentity:
    """Verify a Clerk session JWT, returning the caller identity or raising.

    Checks (all mandatory): signature is RS256 over the JWKS key for the token's
    ``kid``; ``iss`` equals ``issuer`` (which MUST be set — fail-closed); ``exp``
    and ``sub`` are present and ``exp``/``nbf`` are within ``leeway``; and, when an
    ``authorized_parties`` allowlist is configured, ``azp`` is in it.

    ``jwks`` is an injection seam for tests (an object exposing
    ``get_signing_key_from_jwt`` like ``PyJWKClient``); production uses the cached
    per-issuer client. NO Clerk secret is ever used.
    """
    if not issuer:
        # Mandatory issuer — refuse to verify against an unset issuer (timpager
        # throws here too). This is the single most important fail-closed guard.
        raise ClerkVerificationError("CLERK_JWT_ISSUER is unset — refusing to verify")

    client = jwks if jwks is not None else _get_jwks_client(issuer)
    try:
        signing_key = client.get_signing_key_from_jwt(token)
        key = getattr(signing_key, "key", signing_key)
    except Exception as exc:  # unknown kid / malformed / JWKS error -> fail closed
        raise ClerkVerificationError(f"jwks key resolution failed: {exc}") from exc

    # exp + sub mandatory; verify aud only when an expected audience is configured.
    options: dict[str, Any] = {
        "require": ["exp", "sub"],
        "verify_aud": audience is not None,
    }
    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=_ALLOWED_ALGS,
            issuer=issuer,
            audience=audience,
            leeway=leeway,
            options=options,  # type: ignore[arg-type]  # PyJWT Options is a TypedDict
        )
    except jwt.PyJWTError as exc:  # signature/iss/exp/nbf/alg/aud/missing-claim
        raise ClerkVerificationError(str(exc)) from exc

    if authorized_parties:
        azp = claims.get("azp")
        if azp not in set(authorized_parties):
            raise ClerkVerificationError(f"azp {azp!r} not in authorized parties")

    return ClerkIdentity(
        clerk_user_id=claims["sub"],
        org_id=claims.get("org_id"),
        claims=claims,
    )

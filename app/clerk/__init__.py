"""app/clerk — Clerk satellite auth (cookie-blind, JWKS-Bearer, NO Clerk secret).

projections is a cross-apex Clerk SATELLITE of the rallytasks.com primary. The
backend trusts only a short-lived Clerk session JWT presented in the
``Authorization: Bearer`` header, verified networklessly against the primary's
JWKS (``app/clerk/verify.py``). It NEVER reads the ``__session`` cookie and holds
NO Clerk secret (finding C1). See SECURITY.md §2.6 and docs/plans for the design.
"""
from app.clerk.verify import (
    DEFAULT_LEEWAY_SECONDS,
    ClerkIdentity,
    ClerkVerificationError,
    looks_like_jwt,
    reset_jwks_cache,
    verify_clerk_session_token,
)

__all__ = [
    "ClerkIdentity",
    "ClerkVerificationError",
    "DEFAULT_LEEWAY_SECONDS",
    "looks_like_jwt",
    "reset_jwks_cache",
    "verify_clerk_session_token",
]

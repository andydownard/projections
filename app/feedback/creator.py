"""app/feedback/creator.py — server-only creator identity from Clerk JWT claims.

When a signed-in Clerk owner files feedback (Epic F, decisions #6/#13), the server
records WHO filed it for support follow-up — email / name / phone / Clerk user id —
read straight from the verified Clerk session-JWT **claims**. This uses NO Clerk
Backend API and NO Clerk secret (projections is a satellite that holds none, finding
C1): the claims are already on the token our JWKS verifier validated.

Every field is OPTIONAL. A default Clerk session token carries only `sub`/`sid`; the
PII claims (`email`, `name`, `phone_number`, …) are present only when the issuer's JWT
template adds them, so each extractor tolerates absence and returns ``None``.

These ``creator_*`` values are persisted SERVER-SIDE only (the nullable feedback
columns from migration 0011). They are PII and must NEVER reach the public GitHub
issue — ``app/feedback/redact.py`` governs the public payload, which is assembled
from a strict allowlist that does not include any creator field (PRD §22).
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

# Claim keys Clerk JWT templates commonly use, in priority order. We read whichever
# is present; an enriched template may expose any of these.
_EMAIL_CLAIMS = ("email", "email_address", "primary_email_address")
_PHONE_CLAIMS = ("phone_number", "phone", "primary_phone_number")
_NAME_CLAIMS = ("name", "full_name")
_FIRST_CLAIMS = ("first_name", "given_name")
_LAST_CLAIMS = ("last_name", "family_name")

# The four nullable feedback columns this module populates (migration 0011).
CREATOR_FIELDS = (
    "creator_email",
    "creator_name",
    "creator_phone",
    "creator_clerk_user_id",
)


def _first_str(claims: Mapping[str, Any], keys: tuple[str, ...]) -> str | None:
    """First non-blank string value among ``keys`` (claims are untrusted — tolerate
    non-string/None values without raising)."""
    for key in keys:
        value = claims.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _derive_name(claims: Mapping[str, Any]) -> str | None:
    """A display name: a direct ``name`` claim, else first+last joined, else None."""
    direct = _first_str(claims, _NAME_CLAIMS)
    if direct:
        return direct
    first = _first_str(claims, _FIRST_CLAIMS)
    last = _first_str(claims, _LAST_CLAIMS)
    parts = [p for p in (first, last) if p]
    return " ".join(parts) if parts else None


def creator_fields_from_claims(
    claims: Mapping[str, Any] | None,
    *,
    clerk_user_id: str | None = None,
) -> dict[str, str | None]:
    """Extract the server-only ``creator_*`` fields from verified Clerk JWT claims.

    Pure and deterministic (unit-tested in isolation). Returns exactly the four
    ``CREATOR_FIELDS`` keys; a value is ``None`` when its claim is absent/blank, so
    a bare session token still records ``creator_clerk_user_id`` (the ``sub``) with
    the rest NULL. NO Clerk Backend API / secret is used. The caller persists these
    SERVER-SIDE; they never reach the GitHub payload (redact.py allowlist).
    """
    claims = claims or {}
    return {
        "creator_email": _first_str(claims, _EMAIL_CLAIMS),
        "creator_name": _derive_name(claims),
        "creator_phone": _first_str(claims, _PHONE_CLAIMS),
        "creator_clerk_user_id": clerk_user_id or _first_str(claims, ("sub",)),
    }

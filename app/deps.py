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

import hashlib
import hmac
from typing import Optional

from fastapi import Header, HTTPException


def hash_token(token: str) -> str:
    """SHA-256 hex of a high-entropy capability token (SECURITY.md §2.3).

    A slow KDF buys nothing for 256-bit random secrets; a fast cryptographic hash
    plus constant-time compare is correct.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def token_matches(presented: str, stored_hash: str) -> bool:
    """Constant-time compare — NEVER `==` on a token/hash (timing leak)."""
    return hmac.compare_digest(hash_token(presented), stored_hash)


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

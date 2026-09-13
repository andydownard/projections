"""app/deps.py — If-Match parsing (SECURITY.md §6.1).

This project has no authentication or authorization of any kind (owner decision,
2026-09-13): every projection is fully public, with no capability tokens, no
Clerk login, no owner scoping. What remains here is unrelated to identity —
optimistic-concurrency version parsing — plus a tiny internal hashing helper
kept only so `owner_token_hash` (a NOT NULL legacy column; migrations are
additive-only and cannot drop it) has a value to write. Nothing reads that
column back or compares against it anymore.
"""
from __future__ import annotations

import hashlib
import secrets

# ruff: noqa: UP045 -- keep typing.Optional: FastAPI evaluates this dependency's
# annotation at runtime, and PEP 604 `X | None` is unsupported on Python 3.9.
from typing import Optional

from fastapi import Header, HTTPException


def new_internal_owner_hash() -> str:
    """A random value for the vestigial `owner_token_hash` column at row creation.

    Never derived from anything client-supplied, never returned to a caller, never
    compared against — purely satisfies the existing NOT NULL schema constraint.
    """
    return hashlib.sha256(secrets.token_bytes(32)).hexdigest()


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

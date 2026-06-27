"""app/store/role_links.py — role-share link parsing for the indexed lookup (#180).

Role-share link resolution (``GET /api/r/{slug}``, unauthenticated, buyer-facing)
used a leading-wildcard ``role_tokens_json LIKE '%"<slug>"%'`` full-table scan that
could not use an index and would not port to Postgres. The fix moves resolution to a
first-class ``role_links`` table with a UNIQUE slug PK (O(1) exact match, identical on
Postgres). ``SqliteStore`` keeps that table in sync from ``role_tokens_json`` on every
write and backfills it on migration.

This pure helper normalizes ``role_tokens_json`` into ``[{role_name, slug}]`` rows. It
tolerates BOTH the legacy shipped shape ``{slug: role_name}`` and the documented
DATA_MODEL §3.1 shape ``{role_name: {slug, token_hash}}`` so resolution is correct
regardless of which a writer produced, and the backfill recovers any existing data.

The role slug is a read-only lookup capability identical in nature to ``view_slug``
(DATA_MODEL §6) — stored PLAINTEXT as the indexed lookup key; the ``role_links`` row
also carries ``token_hash = SHA-256(slug)`` as the documented hashed-at-rest companion.
"""
from __future__ import annotations

import hashlib
import json


def slug_token_hash(slug: str) -> str:
    """SHA-256 hex of a role slug — the hashed-at-rest companion (DATA_MODEL §6)."""
    return hashlib.sha256(slug.encode("utf-8")).hexdigest()


def parse_role_tokens(role_tokens_json: str | None) -> list[dict[str, str]]:
    """Normalize ``role_tokens_json`` -> ``[{role_name, slug}]`` (both shapes tolerated).

    Returns ``[]`` for empty/missing/malformed input (never raises): a corrupt blob
    must not break role-link resolution or a projection write.
    """
    if not role_tokens_json:
        return []
    try:
        data = json.loads(role_tokens_json)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(data, dict):
        return []

    out: list[dict[str, str]] = []
    for key, value in data.items():
        if isinstance(value, dict):
            # documented shape: {role_name: {slug, token_hash}}
            slug = value.get("slug")
            if slug:
                out.append({"role_name": str(key), "slug": str(slug)})
        elif value is not None:
            # legacy shipped shape: {slug: role_name}
            out.append({"role_name": str(value), "slug": str(key)})
    return out

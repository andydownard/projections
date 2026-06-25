"""app/terms.py — terms-acceptance gate (M0.6 / PRD §21 / SECURITY.md §3).

Terms acceptance is REQUIRED before export/share. The gate is a SERVER-checked flag
(projections.terms_accepted_at), not client-only. Export endpoints raise
403 {"error": "terms_required"} when it is unset (API_SPEC §6/§7).

Scaffolded in M0; the export routers that consume it land in M2 (M2.9).
"""
from __future__ import annotations

from fastapi import HTTPException

from app.store import get_store

TERMS_VERSION = "1.0"  # versioned + timestamped per projection (BACKLOG M0.6)


def require_terms_accepted(projection_id: str) -> None:
    """Raise 403 terms_required if the projection has not accepted terms.

    Called by export/share handlers before producing an .xlsx / packet / share.
    """
    accepted = get_store().get_terms_accepted_at(projection_id)
    if not accepted:
        raise HTTPException(status_code=403, detail={"error": "terms_required"})

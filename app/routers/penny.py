"""app/routers/penny.py — Penny assistant read seam (Spec B §7/§12; issue #121).

This slice ships ONLY the owner-scoped transcript read:

    GET /api/projections/{view_slug}/penny/transcript

It returns the persisted per-project Penny transcript verbatim (the server is the
one shape authority — the client renders turns as-is). Auth is the owner/edit
Bearer quad: the projection owner OR this projection's edit token may read; a
view-only caller (no/invalid token) or a different owner's token gets 403; an
unknown slug gets 404. No cross-owner leakage (each read keys on the slug-resolved
projection_id).

The POST tool-use loop (which appends turns + drives mutations through the normal
PATCH/If-Match path) is PE5 — this module deliberately only reads. Wizard-draft
transcripts are never persisted (Spec §7), so there is nothing to read for them.
"""
from __future__ import annotations

# ruff: noqa: UP045 -- keep typing.Optional: FastAPI evaluates these annotations at
# runtime, and PEP 604 `X | None` is unsupported on Python 3.9.
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException

from app.deps import token_matches
from app.store import Store, get_store

router = APIRouter(prefix="/api/projections", tags=["penny"])


def _bearer(authorization: Optional[str]) -> Optional[str]:
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:].strip() or None
    return None


def _is_owner(token: Optional[str], row: dict) -> bool:
    return token is not None and token_matches(token, row["owner_token_hash"])


def _is_editor(token: Optional[str], row: dict) -> bool:
    return (
        token is not None
        and bool(row.get("edit_token_hash"))
        and token_matches(token, row["edit_token_hash"])
    )


@router.get("/{view_slug}/penny/transcript")
def get_penny_transcript(
    view_slug: str,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
):
    """Owner/edit-scoped read of the persisted per-project transcript (Spec §7)."""
    row = store.get_projection_by_slug(view_slug)
    if row is None:
        # Unknown slug -> 404 (never reveal existence beyond the slug's grant).
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    token = _bearer(authorization)
    if not (_is_owner(token, row) or _is_editor(token, row)):
        # view-only / no token / a different owner's token cannot read (SECURITY §2).
        raise HTTPException(status_code=403, detail={"error": "forbidden"})

    transcript = store.get_transcript_by_projection(row["id"])
    if transcript is None:
        return {
            "view_slug": view_slug,
            "transcript_id": None,
            "turns": [],
            "created_at": None,
            "updated_at": None,
        }
    return {
        "view_slug": view_slug,
        "transcript_id": transcript["id"],
        "turns": transcript["turns"],
        "created_at": transcript.get("created_at"),
        "updated_at": transcript.get("updated_at"),
    }

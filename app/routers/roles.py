"""app/routers/roles.py — read-only role share links (API_SPEC §4.3, M5).

A role link (/api/r/{role_slug}) renders the SAME stored decision verbatim — the
verdict travels, not a reduced summary (M5-G3) — with a `role` field tailoring
emphasis on the client. Read-only: no token, no mutation surface. Returns the
stored Appendix-D snapshot (never a recompute, PRD §13).
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Response

from app.store import Store, get_store

router = APIRouter(prefix="/api/r", tags=["roles"])


@router.get("/{role_slug}")
def get_role_view(role_slug: str, response: Response, store: Store = Depends(get_store)):
    row = store.get_projection_by_role_slug(role_slug)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    try:
        vm = json.loads(row.get("computed_json") or "{}")
    except json.JSONDecodeError:
        vm = {}
    response.headers["ETag"] = str(row["version"])
    return {
        **vm,
        "view_slug": row["view_slug"],
        "version": row["version"],
        "name": row["name"],
        "role": row.get("_role_name", "board"),
        "readOnly": True,
    }

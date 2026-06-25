"""app/routers/health.py — GET /api/health (API_SPEC §10).

Returns the new build SHA, model_version, db reachability, and litestream status.
A bare 200 is not deploy proof — promote verifies the response shows the NEW
build_sha (DEFINITION_OF_DONE).
"""
from __future__ import annotations

from fastapi import APIRouter

from app import config
from app.store import get_store
from engine.model import MODEL_VERSION

router = APIRouter()


@router.get("/api/health")
def health() -> dict:
    try:
        db_ok = get_store().ping()
    except Exception:
        db_ok = False
    return {
        "status": "ok",
        "build_sha": config.build_sha(),
        "model_version": MODEL_VERSION,
        "db": "connected" if db_ok else "unavailable",
        "litestream": config.litestream_status(),
    }

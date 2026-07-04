"""app/routers/places.py — server-proxied Google Places + Census derivation.

The browser never sees the Google/Census keys or calls those APIs directly
(CLAUDE.md hard rule 7): it calls these two endpoints, which proxy autocomplete
and resolve a chosen place into a Census-derived trade-area household count with
provenance. Both are rate-limited per IP (tokens are free to mint and every call
hits a billed/abusable upstream), emitting 429 + Retry-After BEFORE any upstream
call. The derived count is returned editable; the engine never runs here.
"""
from __future__ import annotations

# ruff: noqa: UP045 -- keep typing.Optional: Pydantic/FastAPI evaluate these
# annotations at runtime, and PEP 604 `X | None` is unsupported on Python 3.9.
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app import ratelimit
from app.geo import client
from app.geo.derive import CensusUnavailable, LocationNotFound, derive_trade_area
from app.routers.common import client_ip as _client_ip

router = APIRouter(prefix="/api/places", tags=["places"])

# Per-IP hourly caps (the cost brake). Autocomplete is debounced client-side but
# still free to spam; resolve fans out to Places Details + Census.
_AUTOCOMPLETE_IP_LIMIT = 150
_RESOLVE_IP_LIMIT = 60
_WINDOW_SECONDS = 3600
_MIN_QUERY_LEN = 3


def _rate_limited(endpoint: str, request: Request, limit: int):
    """Return a 429 JSONResponse if over the per-IP cap, else None."""
    allowed, retry_after = ratelimit.check(
        endpoint, ip=_client_ip(request), ip_limit=limit, window_seconds=_WINDOW_SECONDS
    )
    if allowed:
        return None
    return JSONResponse(
        status_code=429,
        content={"error": "rate_limited", "retry_after_seconds": retry_after, "scope": "ip"},
        headers={"Retry-After": str(retry_after)},
    )


class AutocompleteIn(BaseModel):
    query: str
    session_token: Optional[str] = None

    class Config:
        extra = "ignore"


class ResolveIn(BaseModel):
    place_id: str
    basis: str = "city"
    session_token: Optional[str] = None

    class Config:
        extra = "ignore"


@router.post("/autocomplete")
def places_autocomplete(body: AutocompleteIn, request: Request):
    limited = _rate_limited("places_autocomplete", request, _AUTOCOMPLETE_IP_LIMIT)
    if limited is not None:
        return limited
    q = (body.query or "").strip()
    if len(q) < _MIN_QUERY_LEN:
        return {"predictions": []}
    try:
        preds = client.autocomplete(q, session_token=body.session_token)
    except Exception:
        # An upstream hiccup must not 500 a typeahead — degrade to no results.
        preds = []
    return {"predictions": preds}


@router.post("/resolve")
def places_resolve(body: ResolveIn, request: Request):
    limited = _rate_limited("places_resolve", request, _RESOLVE_IP_LIMIT)
    if limited is not None:
        return limited
    if not (body.place_id or "").strip():
        return JSONResponse(status_code=422, content={"error": "place_id_required"})
    try:
        return derive_trade_area(body.place_id, basis=body.basis)
    except LocationNotFound:
        return JSONResponse(status_code=422, content={"error": "location_not_found"})
    except CensusUnavailable:
        return JSONResponse(
            status_code=503,
            content={
                "error": "census_unavailable",
                "message": "Could not derive households automatically — enter them manually.",
            },
        )
    except Exception:
        # Defense-in-depth: an unforeseen error degrades to the manual-entry
        # fallback (503), never a 500 with a key-bearing traceback in the logs.
        return JSONResponse(
            status_code=503,
            content={
                "error": "census_unavailable",
                "message": "Lookup failed — enter households manually.",
            },
        )

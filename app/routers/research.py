"""app/routers/research.py — POST /api/research: location-grounded market rent.

The M3.3 rent-research slice (issues #60/#62/#64/#65), built to the LLM-GROUNDING
contract (CLAUDE.md / SECURITY.md §6):

- **Extract-only over SSRF-fetched snippets.** ``rent.build_rent_snippets`` fetches
  candidate sources through the SSRF-hardened ``fetch.py``; ``extract_rent`` extracts
  only from those snippets and **rejects any citation not in the fetched set**.
- **AI-disabled-safe.** ``make_rent_provider`` returns ``None`` when the kill switch
  is set or no key is configured → a **labeled regional benchmark** ($12/sq ft) at
  low confidence; a provider outage degrades to the same benchmark (never a 500).
- **Cached** by normalized ``location+size+basis`` with a TTL.
- **Per-IP + per-token rate-limited** (429 + ``Retry-After`` BEFORE any upstream call).
- **Off the compute hot path** — a standalone endpoint; the engine never calls it.
- **No key in any path/query/log/response** — keys live in env, read at call time.
"""
from __future__ import annotations

# ruff: noqa: UP045 -- keep typing.Optional: Pydantic/FastAPI evaluate these
# annotations at runtime, and PEP 604 `X | None` is unsupported on Python 3.9.
import threading
import time
from typing import Any, Optional

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from app import ratelimit
from app.deps import hash_token
from app.research.extract import extract_rent
from app.research.provider import RentProviderError, make_rent_provider
from app.research.rent import build_rent_snippets, location_label
from app.routers.common import bearer as _bearer
from app.routers.common import client_ip as _client_ip

router = APIRouter(prefix="/api/research", tags=["research"])

# Per-IP + per-token hourly caps (the cost brake — every call may fan out to fetches
# + a provider). Tokens are free to mint, so BOTH axes are capped (Mutation Quad (d)).
# Matches API_SPEC §2.3 (10/hr IP · 20/hr token).
_IP_LIMIT = 10
_TOKEN_LIMIT = 20
_WINDOW_SECONDS = 3600
_CACHE_TTL_SECONDS = 24 * 3600

# Normalized ``location|size|basis`` -> (expires_at, payload). Process-local, mirrors
# the rest of the v1 single-process service; swapped for a shared store if it scales.
_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def reset_research_cache() -> None:
    """Test hook: clear the rent-research cache."""
    with _cache_lock:
        _cache.clear()


class ResearchIn(BaseModel):
    building_sqft: str
    basis: str = "nnn"
    location: Optional[dict] = None       # resolved geo dict (city/county + address)
    location_label: Optional[str] = None  # OR a plain label string
    token: Optional[str] = None           # optional owner token for the per-token cap

    model_config = ConfigDict(extra="ignore")


def _cache_key(label: str, building_sqft: str, basis: str) -> str:
    return f"{(label or '').strip().lower()}|{(building_sqft or '').strip()}|{basis}"


def _cache_get(key: str) -> Optional[dict]:
    now = time.time()
    with _cache_lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        expires_at, payload = entry
        if expires_at < now:
            _cache.pop(key, None)
            return None
        return payload


def _cache_put(key: str, payload: dict) -> None:
    with _cache_lock:
        _cache[key] = (time.time() + _CACHE_TTL_SECONDS, payload)


def _shape_response(extracted: dict, basis: str, *, ai_enabled: bool) -> dict[str, Any]:
    """Map the extract.py result to the wizard pre-fill + verified-vs-estimated badge.

    ``rent_per_sqft`` is the representative pre-fill (the benchmark $12 when AI-off /
    ungrounded). ``verified`` is True only when a server-fetched source survived and
    confidence is not low — that drives the verified-vs-estimated badge (icon + text,
    never color-only) and "what would change this" copy on the client.
    """
    sources = extracted.get("sources") or []
    confidence = extracted.get("confidence", "low")
    verified = bool(sources) and confidence != "low"
    estimate = extracted.get("estimate")
    return {
        "rent_per_sqft": estimate,
        "estimate": estimate,
        "low": extracted.get("low"),
        "high": extracted.get("high"),
        "rent_type": extracted.get("rent_type", basis),
        "opex": extracted.get("opex"),
        "basis": extracted.get("basis", "$/sq ft/yr"),
        "confidence": confidence,
        "verified": verified,
        "provenance": "verified" if verified else "estimated",
        "sources": sources,
        "ai_enabled": ai_enabled,
    }


@router.post("")
def research_rent(
    body: ResearchIn,
    request: Request,
    authorization: Optional[str] = Header(default=None),
):
    # Per-IP + per-token cap BEFORE any upstream fetch / provider call. The token is
    # HASHED before it becomes a bucket key (no raw capability secret in memory/logs).
    token = body.token or _bearer(authorization)
    token_key = hash_token(token) if token else None
    allowed, retry_after = ratelimit.check(
        "research_rent",
        ip=_client_ip(request),
        token=token_key,
        ip_limit=_IP_LIMIT,
        token_limit=_TOKEN_LIMIT,
        window_seconds=_WINDOW_SECONDS,
    )
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limited", "retry_after_seconds": retry_after},
            headers={"Retry-After": str(retry_after)},
        )

    basis = body.basis if body.basis in ("nnn", "gross") else "nnn"
    label = body.location_label or location_label(body.location)
    key = _cache_key(label, body.building_sqft, basis)

    cached = _cache_get(key)
    if cached is not None:
        return {**cached, "cached": True}

    provider = make_rent_provider()
    # Build the grounding set (SSRF-fetched), off the compute hot path. Skipped
    # entirely when AI is off: with no provider, extract_rent ignores snippets and
    # returns the labeled benchmark, so fetching them would be wasted work + cost.
    snippets: list = []
    if provider is not None:
        try:
            snippets = build_rent_snippets(
                body.location if body.location is not None else label,
                body.building_sqft,
                basis=basis,
            )
        except Exception:
            snippets = []

    # Extract-only; a provider outage degrades to the labeled benchmark (AI-off path).
    try:
        extracted = extract_rent(snippets, provider=provider)
    except RentProviderError:
        extracted = extract_rent([], provider=None)

    payload = _shape_response(extracted, basis, ai_enabled=provider is not None)
    _cache_put(key, payload)
    return {**payload, "cached": False}

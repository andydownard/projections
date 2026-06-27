"""app/geo/client.py — outbound Google Places + US Census ACS clients.

Server-side ONLY: GOOGLE_PLACES_API_KEY / CENSUS_API_KEY are read from the env and
NEVER returned to the client (CLAUDE.md hard rule 7). Network I/O funnels through a
small set of seams the tests stub, so the derivation logic is exercised without real
HTTP and the key value never appears in a response, URL, or log line.

Providers:
  * Google Places API (New) v1 Autocomplete + Details -> predictions, lat/lng.
      The key travels in the ``X-Goog-Api-Key`` HEADER (never the URL/query), so a
      logged request line can never carry it. The legacy
      ``maps.googleapis.com/maps/api/place/*`` endpoints are denied for newer keys
      (``REQUEST_DENIED``); the New API is the supported surface.
  * US Census Geocoder (coordinates -> geographies)  -> state/county/place FIPS.
  * US Census ACS 5-year, table B11001 (households)  -> the trade-area count.

Dev-visible error path: when NOT in production, a Places upstream failure logs the
upstream status (``REQUEST_DENIED`` / HTTP status — never the key) and carries it on
the raised error, so a denied key cannot regress unnoticed behind an empty list.
In production it fails CLOSED: a generic message, no status detail, no key.
"""
from __future__ import annotations

import logging
import os
from collections import OrderedDict
from typing import Any
from urllib.parse import urlencode

import httpx

from app import config

logger = logging.getLogger("app.geo.client")

# ACS 5-year vintage (2018–2022). Pinned so the evidence row stamps an exact
# source year a board can verify; bump deliberately, not silently.
ACS_VINTAGE = "2022"
ACS_HOUSEHOLDS_VAR = "B11001_001E"   # Total households
ACS_HOUSEHOLDS_MOE = "B11001_001M"   # 90% margin of error

# Places API (New) v1. Autocomplete is POST (JSON body); Details is GET with a
# required field mask. Both authenticate via the X-Goog-Api-Key header.
_PLACES_V1 = "https://places.googleapis.com/v1"
# Place Details field mask: only what derive.py needs (location + address). A
# tight mask keeps the response small and the billing SKU minimal.
_PLACE_DETAILS_FIELDS = "location,formattedAddress"

_CENSUS_GEOCODER = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates"
_CENSUS_ACS = f"https://api.census.gov/data/{ACS_VINTAGE}/acs/acs5"

_TIMEOUT = 8.0


class GeoUpstreamError(Exception):
    """A geo provider (Places/Census) failed or returned an unusable payload."""


# --- Static Maps (server-proxied: the key never reaches the browser) ----------
_STATIC_SIZES = {
    "thumb": {"size": "120x80", "zoom": "11"},
    "detail": {"size": "640x280", "zoom": "12"},
}
_static_cache: OrderedDict[tuple, bytes] = OrderedDict()
_STATIC_CACHE_MAX = 256


def reset_static_cache() -> None:
    """Test hook: clear the byte cache."""
    _static_cache.clear()


def _get_bytes(url: str) -> bytes:
    """Network seam for image bytes (stubbed in tests). Key-safe error wrapping."""
    try:
        resp = httpx.get(url, timeout=_TIMEOUT)
        resp.raise_for_status()
        return resp.content
    except (httpx.HTTPError, ValueError) as e:
        raise GeoUpstreamError(f"static map request failed: {type(e).__name__}") from None


def static_map_bytes(lat: float, lng: float, kind: str = "thumb") -> bytes:
    """A Google Static Maps PNG (store pin on a brand-green marker), byte-cached
    per (lat, lng, kind). The key is appended server-side and never leaves here."""
    cfg = _STATIC_SIZES.get(kind, _STATIC_SIZES["thumb"])
    cache_key = (round(float(lat), 4), round(float(lng), 4), kind)
    cached = _static_cache.get(cache_key)
    if cached is not None:
        _static_cache.move_to_end(cache_key)  # LRU touch
        return cached
    params = {
        "center": f"{lat},{lng}",
        "zoom": cfg["zoom"],
        "size": cfg["size"],
        "scale": "2",
        "markers": f"color:0x35644F|{lat},{lng}",
        "key": _places_key(),
    }
    url = "https://maps.googleapis.com/maps/api/staticmap?" + urlencode(params)
    img = _get_bytes(url)
    _static_cache[cache_key] = img
    _static_cache.move_to_end(cache_key)
    if len(_static_cache) > _STATIC_CACHE_MAX:
        _static_cache.popitem(last=False)  # evict least-recently-used
    return img


def _get_json(url: str, params: dict) -> Any:
    """The single network seam (stubbed in tests). GET url?params -> parsed JSON.

    SECURITY: any httpx error string embeds the request URL — which carries the
    Places/Census ``key=`` — so a raw raise would log the key (CLAUDE.md hard rule
    7) and surface a 500 instead of the contracted 503. Re-raise a clean
    GeoUpstreamError ``from None`` so the key-bearing chain never propagates.
    """
    try:
        resp = httpx.get(url, params=params, timeout=_TIMEOUT)
        resp.raise_for_status()
        return resp.json()
    except (httpx.HTTPError, ValueError) as e:
        raise GeoUpstreamError(f"upstream request failed: {type(e).__name__}") from None


def _places_key() -> str:
    return os.environ.get("GOOGLE_PLACES_API_KEY", "")


def _places_fail(detail: str) -> GeoUpstreamError:
    """Build (and log) the Places error per the dev-visible / fail-closed contract.

    ``detail`` is an upstream STATUS token only (e.g. ``REQUEST_DENIED`` or
    ``HTTP 403`` or an httpx exception class name) — NEVER the key. Because the New
    API carries the key in a header (not the URL), even a leaked request line is
    key-safe; we still surface only the status, never raw httpx strings.

    Non-prod: log + carry the status so a denied key is visible instead of an empty
    list. Prod: fail closed — a generic message, no status, nothing key-adjacent.
    """
    if config.is_production():
        logger.warning("places upstream request failed")
        return GeoUpstreamError("places upstream request failed")
    logger.error("places upstream request failed: %s", detail)
    return GeoUpstreamError(f"places upstream request failed: {detail}")


def _places_request(
    method: str,
    url: str,
    *,
    params: dict | None = None,
    json_body: dict | None = None,
    field_mask: str | None = None,
) -> Any:
    """Network seam for Places API (New) v1 (stubbed in tests).

    SECURITY (CLAUDE.md hard rule 7): the API key is sent ONLY in the
    ``X-Goog-Api-Key`` header — never the path/query — so it cannot land in a logged
    request line. On failure we extract the upstream status (HTTP code or the
    ``error.status`` token) and route it through ``_places_fail`` so the key-bearing
    httpx chain never propagates and prod stays fail-closed.
    """
    headers = {"X-Goog-Api-Key": _places_key()}
    if field_mask:
        headers["X-Goog-FieldMask"] = field_mask
    try:
        resp = httpx.request(
            method, url, params=params, json=json_body, headers=headers, timeout=_TIMEOUT
        )
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPStatusError as e:
        status_token = None
        try:
            status_token = ((e.response.json() or {}).get("error") or {}).get("status")
        except (ValueError, AttributeError):
            status_token = None
        detail = status_token or f"HTTP {e.response.status_code}"
        raise _places_fail(detail) from None
    except (httpx.HTTPError, ValueError) as e:
        raise _places_fail(type(e).__name__) from None


def autocomplete(query: str, *, session_token: str | None = None) -> list[dict]:
    """Address predictions for `query`. Returns [{description, place_id}] only —
    the upstream payload (and the key) never leave the server.

    Places API (New) v1: ``POST /v1/places:autocomplete`` with a JSON body. Each
    suggestion's ``placePrediction`` carries the place id + display text.
    """
    body: dict = {"input": query}
    if session_token:
        body["sessionToken"] = session_token
    data = _places_request(
        "POST", f"{_PLACES_V1}/places:autocomplete", json_body=body
    )
    suggestions = data.get("suggestions", []) if isinstance(data, dict) else []
    out: list[dict] = []
    for s in suggestions:
        pred = (s or {}).get("placePrediction") or {}
        place_id = pred.get("placeId", "")
        if not place_id:
            continue
        text = (pred.get("text") or {}).get("text", "")
        out.append({"description": text, "place_id": place_id})
    return out


def place_details(place_id: str, *, session_token: str | None = None) -> dict:
    """Resolve a place_id to {lat, lng, formatted_address}.

    Places API (New) v1: ``GET /v1/places/{id}`` with a required field mask. The
    response is the Place resource directly (location.latitude/longitude,
    formattedAddress) — no legacy ``result`` envelope.
    """
    params = {"sessionToken": session_token} if session_token else None
    data = _places_request(
        "GET",
        f"{_PLACES_V1}/places/{place_id}",
        params=params,
        field_mask=_PLACE_DETAILS_FIELDS,
    )
    if not isinstance(data, dict) or not data:
        raise GeoUpstreamError("place_details: no result")
    loc = data.get("location") or {}
    lat, lng = loc.get("latitude"), loc.get("longitude")
    if lat is None or lng is None:
        raise GeoUpstreamError("place_details: no geometry")
    return {
        "lat": float(lat),
        "lng": float(lng),
        "formatted_address": data.get("formattedAddress", ""),
    }


def _first_layer(geos: dict, needle: str) -> dict | None:
    """First non-empty geography layer whose name contains `needle`."""
    for name, rows in geos.items():
        if needle.lower() in name.lower() and rows:
            return rows[0]
    return None


def census_geographies(lat: float, lng: float) -> dict:
    """Reverse-geocode a point to its Census {state,county,place} FIPS + names."""
    params = {
        "x": lng,
        "y": lat,
        "benchmark": "Public_AR_Current",
        "vintage": "Current_Current",
        "layers": "Counties,Incorporated Places,Census Designated Places",
        "format": "json",
    }
    data = _get_json(_CENSUS_GEOCODER, params)
    geos = (
        ((data or {}).get("result") or {}).get("geographies") or {}
        if isinstance(data, dict)
        else {}
    )
    out: dict = {}
    county = _first_layer(geos, "Counties") or _first_layer(geos, "County")
    if county:
        out["state_fips"] = county.get("STATE")
        out["county_fips"] = county.get("COUNTY")
        out["county_name"] = county.get("NAME") or county.get("BASENAME")
    place = _first_layer(geos, "Incorporated Places") or _first_layer(geos, "Places")
    if place:
        out["state_fips"] = out.get("state_fips") or place.get("STATE")
        out["place_fips"] = place.get("PLACE")
        out["place_name"] = place.get("NAME") or place.get("BASENAME")
    if not out.get("state_fips"):
        raise GeoUpstreamError("census_geographies: no geography for point")
    return out


def acs_households(
    state_fips: str,
    *,
    place_fips: str | None = None,
    county_fips: str | None = None,
) -> dict:
    """ACS 5-year total households (B11001_001E) for a place or county FIPS."""
    params = {"get": f"NAME,{ACS_HOUSEHOLDS_VAR},{ACS_HOUSEHOLDS_MOE}"}
    if place_fips:
        params["for"] = f"place:{place_fips}"
        params["in"] = f"state:{state_fips}"
    elif county_fips:
        params["for"] = f"county:{county_fips}"
        params["in"] = f"state:{state_fips}"
    else:
        raise GeoUpstreamError("acs_households: need a place or county FIPS")
    key = os.environ.get("CENSUS_API_KEY")  # optional: only raises rate limits
    if key:
        params["key"] = key
    data = _get_json(_CENSUS_ACS, params)
    # ACS returns [[header...], [row...]] — zip the first data row to its header.
    if not isinstance(data, list) or len(data) < 2:
        raise GeoUpstreamError("acs_households: empty ACS response")
    rec = dict(zip(data[0], data[1]))
    try:
        households = int(rec[ACS_HOUSEHOLDS_VAR])
    except (KeyError, TypeError, ValueError) as e:
        raise GeoUpstreamError("acs_households: no household count") from e
    raw_moe = rec.get(ACS_HOUSEHOLDS_MOE)
    try:
        moe = int(raw_moe) if raw_moe is not None else None
    except (TypeError, ValueError):
        moe = None
    # Census MOE can be negative sentinels (e.g. -555555555) -> treat as unknown.
    if moe is not None and moe < 0:
        moe = None
    return {"households": households, "moe": moe, "vintage": ACS_VINTAGE,
            "name": rec.get("NAME", "")}

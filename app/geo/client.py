"""app/geo/client.py — outbound Google Places + US Census ACS clients.

Server-side ONLY: GOOGLE_PLACES_API_KEY / CENSUS_API_KEY are read from the env and
NEVER returned to the client (CLAUDE.md hard rule 7). All network I/O funnels
through `_get_json`, the single seam the tests stub, so the derivation logic is
exercised without real HTTP and the key value never appears in a response.

Providers:
  * Google Places (legacy) Autocomplete + Details   -> predictions, lat/lng.
  * US Census Geocoder (coordinates -> geographies)  -> state/county/place FIPS.
  * US Census ACS 5-year, table B11001 (households)  -> the trade-area count.
"""
from __future__ import annotations

import os
from typing import Any, Optional
from urllib.parse import urlencode

import httpx

# ACS 5-year vintage (2018–2022). Pinned so the evidence row stamps an exact
# source year a board can verify; bump deliberately, not silently.
ACS_VINTAGE = "2022"
ACS_HOUSEHOLDS_VAR = "B11001_001E"   # Total households
ACS_HOUSEHOLDS_MOE = "B11001_001M"   # 90% margin of error

_PLACES_BASE = "https://maps.googleapis.com/maps/api/place"
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
_static_cache: dict[tuple, bytes] = {}
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
    if len(_static_cache) < _STATIC_CACHE_MAX:
        _static_cache[cache_key] = img
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


def autocomplete(query: str, *, session_token: Optional[str] = None) -> list[dict]:
    """Address predictions for `query`. Returns [{description, place_id}] only —
    the upstream payload (and the key) never leave the server."""
    params = {"input": query, "key": _places_key(), "types": "geocode"}
    if session_token:
        params["sessiontoken"] = session_token
    data = _get_json(f"{_PLACES_BASE}/autocomplete/json", params)
    preds = data.get("predictions", []) if isinstance(data, dict) else []
    return [
        {"description": p.get("description", ""), "place_id": p.get("place_id", "")}
        for p in preds
        if p.get("place_id")
    ]


def place_details(place_id: str, *, session_token: Optional[str] = None) -> dict:
    """Resolve a place_id to {lat, lng, formatted_address}."""
    params = {
        "place_id": place_id,
        "key": _places_key(),
        "fields": "geometry,formatted_address",
    }
    if session_token:
        params["sessiontoken"] = session_token
    data = _get_json(f"{_PLACES_BASE}/details/json", params)
    result = (data or {}).get("result") if isinstance(data, dict) else None
    if not result:
        raise GeoUpstreamError("place_details: no result")
    loc = (result.get("geometry") or {}).get("location") or {}
    lat, lng = loc.get("lat"), loc.get("lng")
    if lat is None or lng is None:
        raise GeoUpstreamError("place_details: no geometry")
    return {
        "lat": float(lat),
        "lng": float(lng),
        "formatted_address": result.get("formatted_address", ""),
    }


def _first_layer(geos: dict, needle: str) -> Optional[dict]:
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
    place_fips: Optional[str] = None,
    county_fips: Optional[str] = None,
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

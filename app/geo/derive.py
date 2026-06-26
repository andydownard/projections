"""app/geo/derive.py — address (place_id) -> Census-derived trade-area households.

Composes the Places + Census ACS clients into the one derivation the wizard
consumes: the user picks an address; the SERVER derives the city (and county)
household counts from the Census ACS and returns them WITH provenance (geography,
FIPS, ACS vintage, MOE) so the count is editable but evidence-backed
(DESIGN_PROMPT wizard; PRD §8/§15). The engine still reads H = households; this
only sources the default — never computes the projection.

Typed failures so the router degrades correctly (PRD §8 error states):
  * LocationNotFound  -> 422, fall back to manual entry.
  * CensusUnavailable -> 503, fall back to manual entry (preserve the escape hatch).
"""
from __future__ import annotations

from app.geo import client


class LocationNotFound(Exception):
    """Place details / Census geography could not be resolved for the input."""


class CensusUnavailable(Exception):
    """Census ACS lookup failed; caller should fall back to manual entry."""


def _block(name: str, fips: str, hh: dict) -> dict:
    return {
        "geography_name": name,
        "fips": fips,
        "households": hh["households"],
        "moe": hh.get("moe"),
    }


def derive_trade_area(place_id: str, *, basis: str = "city") -> dict:
    """Resolve `place_id` to a trade-area household count + provenance.

    Default basis is city/place (ENGINE/PM decision: the smallest sensible
    catchment); county is derived alongside and selectable. Returns both as
    `alternatives` so the wizard's City/County toggle needs no second round-trip.
    """
    if basis not in ("city", "county"):
        basis = "city"

    try:
        details = client.place_details(place_id)
        geo = client.census_geographies(details["lat"], details["lng"])
    except client.GeoUpstreamError as e:
        raise LocationNotFound(str(e)) from e

    state = geo["state_fips"]
    alternatives: dict = {}
    try:
        if geo.get("place_fips"):
            city_hh = client.acs_households(state, place_fips=geo["place_fips"])
            alternatives["city"] = _block(
                geo.get("place_name") or "City",
                f"{state}{geo['place_fips']}",
                city_hh,
            )
        if geo.get("county_fips"):
            county_hh = client.acs_households(state, county_fips=geo["county_fips"])
            alternatives["county"] = _block(
                geo.get("county_name") or "County",
                f"{state}{geo['county_fips']}",
                county_hh,
            )
    except client.GeoUpstreamError as e:
        raise CensusUnavailable(str(e)) from e

    if not alternatives:
        raise CensusUnavailable("no ACS household geography available for this point")

    chosen_key = basis if basis in alternatives else next(iter(alternatives))
    chosen = alternatives[chosen_key]
    vintage = client.ACS_VINTAGE

    return {
        "location": {
            "place_id": place_id,
            "lat": details["lat"],
            "lng": details["lng"],
            "formatted_address": details["formatted_address"],
        },
        "trade_area": {
            "basis": chosen_key,
            "households": chosen["households"],
            "geography_name": chosen["geography_name"],
            "geography_fips": chosen["fips"],
            "acs_vintage": vintage,
            "households_source": "census_acs",
            "moe": chosen.get("moe"),
            "alternatives": alternatives,
        },
        "evidence": {
            "field": "households",
            "label": "Trade-area households",
            "value": chosen["households"],
            "method": "census_acs",
            "source": f"U.S. Census Bureau, ACS 5-year ({vintage}), table B11001",
            "source_date": vintage,
            "confidence": "estimated",
            "geography": chosen["geography_name"],
        },
    }

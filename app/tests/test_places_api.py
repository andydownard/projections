"""Places -> Census trade-area derivation API (app/routers/places.py).

The network seams (Places API New v1 via app.geo.client._places_request; Census via
app.geo.client._get_json) are stubbed, so these exercise the real
autocomplete/resolve/derivation logic — FIPS mapping, ACS parsing, basis selection,
degraded fallbacks, the per-IP rate-limit, and the hard rule that the provider key
NEVER reaches the client — without touching the network.
"""
import httpx
import pytest
from fastapi.testclient import TestClient

from app import ratelimit
from app.geo import client as geo_client
from app.routers import places

# --- canned upstream payloads (Longview, TX -> Gregg County) ------------------
# Places API (New) v1 shapes: autocomplete -> suggestions[].placePrediction;
# details -> the Place resource directly (location.latitude/longitude).
_AUTOCOMPLETE = {
    "suggestions": [
        {
            "placePrediction": {
                "placeId": "PID_LONGVIEW",
                "text": {"text": "Longview, TX, USA"},
            }
        },
        {
            "placePrediction": {
                "placeId": "PID_LONGVIEW_WA",
                "text": {"text": "Longview, WA, USA"},
            }
        },
    ]
}
_DETAILS = {
    "formattedAddress": "Longview, TX, USA",
    "location": {"latitude": 32.5007, "longitude": -94.7405},
}
_GEOGRAPHIES = {
    "result": {
        "geographies": {
            "Counties": [{"STATE": "48", "COUNTY": "183", "NAME": "Gregg County"}],
            "Incorporated Places": [
                {"STATE": "48", "PLACE": "43012", "NAME": "Longview city"}
            ],
        }
    }
}
_ACS_PLACE = [
    ["NAME", "B11001_001E", "B11001_001M", "state", "place"],
    ["Longview city, Texas", "31798", "412", "48", "43012"],
]
_ACS_COUNTY = [
    ["NAME", "B11001_001E", "B11001_001M", "state", "county"],
    ["Gregg County, Texas", "45000", "613", "48", "183"],
]

SECRET_KEY = "PLACES_KEY_DO_NOT_LEAK_123"


def _fake_places_request(method, url, *, params=None, json_body=None, field_mask=None):
    # Key must travel in the header, never the URL/query (CLAUDE.md hard rule 7).
    if url.endswith("places:autocomplete"):
        return _AUTOCOMPLETE
    if "/v1/places/" in url:
        return _DETAILS
    raise AssertionError(f"unexpected places url: {url}")


def _fake_get_json(url, params):
    if "geocoder/geographies" in url:
        return _GEOGRAPHIES
    if "/acs/acs5" in url:
        forp = params.get("for", "")
        if forp.startswith("place:"):
            return _ACS_PLACE
        if forp.startswith("county:"):
            return _ACS_COUNTY
    raise AssertionError(f"unexpected upstream url: {url}")


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("GOOGLE_PLACES_API_KEY", SECRET_KEY)
    monkeypatch.setattr(geo_client, "_get_json", _fake_get_json)
    monkeypatch.setattr(geo_client, "_places_request", _fake_places_request)
    ratelimit.reset_rate_limits()
    from app.main import create_app

    return TestClient(create_app())


def test_autocomplete_returns_predictions_without_the_key(client):
    resp = client.post("/api/places/autocomplete", json={"query": "Longview"})
    assert resp.status_code == 200
    preds = resp.json()["predictions"]
    assert {p["place_id"] for p in preds} == {"PID_LONGVIEW", "PID_LONGVIEW_WA"}
    assert SECRET_KEY not in resp.text  # provider key never reaches the client


def test_autocomplete_ignores_too_short_queries(client):
    resp = client.post("/api/places/autocomplete", json={"query": "Lo"})
    assert resp.status_code == 200
    assert resp.json()["predictions"] == []


def test_resolve_derives_city_households_with_provenance(client):
    resp = client.post("/api/places/resolve", json={"place_id": "PID_LONGVIEW"})
    assert resp.status_code == 200
    body = resp.json()
    ta = body["trade_area"]
    assert ta["households"] == 31798
    assert ta["basis"] == "city"
    assert ta["households_source"] == "census_acs"
    assert ta["geography_name"] == "Longview city"
    assert ta["geography_fips"] == "4843012"
    assert ta["acs_vintage"] == "2022"
    assert ta["moe"] == 412
    # County is derived alongside so the wizard's City/County toggle is local.
    assert ta["alternatives"]["county"]["households"] == 45000
    # Location for the map, and an evidence row for the board packet.
    assert body["location"]["lat"] == pytest.approx(32.5007)
    assert body["location"]["place_id"] == "PID_LONGVIEW"
    assert body["evidence"]["method"] == "census_acs"
    assert body["evidence"]["value"] == 31798
    assert SECRET_KEY not in resp.text


def test_resolve_county_basis_returns_county_count(client):
    resp = client.post(
        "/api/places/resolve", json={"place_id": "PID_LONGVIEW", "basis": "county"}
    )
    assert resp.status_code == 200
    ta = resp.json()["trade_area"]
    assert ta["basis"] == "county"
    assert ta["households"] == 45000
    assert ta["geography_name"] == "Gregg County"


def test_resolve_location_not_found_is_422(client, monkeypatch):
    def no_place(method, url, *, params=None, json_body=None, field_mask=None):
        if "/v1/places/" in url:
            return {}  # New API: empty Place resource -> unresolvable
        return _fake_places_request(
            method, url, params=params, json_body=json_body, field_mask=field_mask
        )

    monkeypatch.setattr(geo_client, "_places_request", no_place)
    resp = client.post("/api/places/resolve", json={"place_id": "PID_BOGUS"})
    assert resp.status_code == 422
    assert resp.json()["error"] == "location_not_found"


def test_resolve_census_unavailable_is_503(client, monkeypatch):
    def acs_down(url, params):
        if "/acs/acs5" in url:
            raise geo_client.GeoUpstreamError("census 500")
        return _fake_get_json(url, params)

    monkeypatch.setattr(geo_client, "_get_json", acs_down)
    resp = client.post("/api/places/resolve", json={"place_id": "PID_LONGVIEW"})
    assert resp.status_code == 503
    assert resp.json()["error"] == "census_unavailable"


def test_get_json_wraps_httpx_error_without_leaking_key(monkeypatch):
    # A real upstream failure: httpx error strings embed the key-bearing URL. The
    # seam must re-raise a clean GeoUpstreamError with NO key and NO chained cause.
    url_with_key = (
        f"https://maps.googleapis.com/maps/api/place/details/json?key={SECRET_KEY}"
    )

    def boom_get(u, params=None, timeout=None):
        raise httpx.HTTPStatusError(
            f"Server error '500' for url '{url_with_key}'",
            request=httpx.Request("GET", url_with_key),
            response=httpx.Response(500),
        )

    monkeypatch.setattr(geo_client.httpx, "get", boom_get)
    with pytest.raises(geo_client.GeoUpstreamError) as ei:
        geo_client._get_json("https://maps.googleapis.com/x", {"key": SECRET_KEY})
    assert SECRET_KEY not in str(ei.value)
    assert ei.value.__cause__ is None  # `from None` drops the key-bearing chain


def test_resolve_unexpected_error_degrades_to_503(client, monkeypatch):
    # Defense-in-depth: a non-GeoUpstreamError on an upstream call still degrades
    # to the manual-entry fallback (503), never a 500 with a logged traceback.
    def boom(url, params):
        if "/acs/acs5" in url:
            raise RuntimeError("unexpected provider failure")
        return _fake_get_json(url, params)

    monkeypatch.setattr(geo_client, "_get_json", boom)
    resp = client.post("/api/places/resolve", json={"place_id": "PID_LONGVIEW"})
    assert resp.status_code == 503
    assert resp.json()["error"] == "census_unavailable"
    assert SECRET_KEY not in resp.text


def test_resolve_is_rate_limited_per_ip(client, monkeypatch):
    monkeypatch.setattr(places, "_RESOLVE_IP_LIMIT", 2)
    ratelimit.reset_rate_limits()
    ok1 = client.post("/api/places/resolve", json={"place_id": "PID_LONGVIEW"})
    ok2 = client.post("/api/places/resolve", json={"place_id": "PID_LONGVIEW"})
    blocked = client.post("/api/places/resolve", json={"place_id": "PID_LONGVIEW"})
    assert ok1.status_code == 200 and ok2.status_code == 200
    assert blocked.status_code == 429
    assert blocked.json()["error"] == "rate_limited"
    assert int(blocked.headers["Retry-After"]) >= 1

"""app/geo/client.py — Places API (New) v1 client, at the httpx network seam.

These stub ``httpx.request`` (the lowest seam) so the REAL client logic runs:
request shaping (POST autocomplete / GET details), response parsing into the
``Prediction`` / details contract, the key-in-header-never-URL rule, and the
dev-visible vs fail-closed error path for ``REQUEST_DENIED`` / HTTP status.

Covers the three cases the ticket calls out: success, REQUEST_DENIED, empty.
"""
import logging

import httpx
import pytest

from app.geo import client as geo

SECRET_KEY = "PLACES_KEY_DO_NOT_LEAK_456"


class _FakeResp:
    """Minimal httpx.Response stand-in for the success path."""

    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=httpx.Request("GET", "https://places.googleapis.com/v1/x"),
                response=httpx.Response(self.status_code, json=self._payload),
            )


@pytest.fixture(autouse=True)
def _places_key(monkeypatch):
    monkeypatch.setenv("GOOGLE_PLACES_API_KEY", SECRET_KEY)
    # Default to non-prod so the dev-visible path is the baseline.
    monkeypatch.setenv("APP_ENV", "dev")


def _stub_request(monkeypatch, payload, *, status_code=200):
    """Stub httpx.request; capture the outgoing call for security assertions."""
    captured: dict = {}

    def fake_request(method, url, **kwargs):
        captured["method"] = method
        captured["url"] = url
        captured["kwargs"] = kwargs
        return _FakeResp(status_code, payload)

    monkeypatch.setattr(geo.httpx, "request", fake_request)
    return captured


# --- success ------------------------------------------------------------------
def test_autocomplete_parses_new_api_suggestions(monkeypatch):
    payload = {
        "suggestions": [
            {
                "placePrediction": {
                    "placeId": "PID_A",
                    "text": {"text": "Longview, TX, USA"},
                }
            },
            {
                "placePrediction": {
                    "placeId": "PID_B",
                    "text": {"text": "Longview, WA, USA"},
                }
            },
            {"placePrediction": {"text": {"text": "no id -> dropped"}}},
        ]
    }
    captured = _stub_request(monkeypatch, payload)

    preds = geo.autocomplete("Longview", session_token="tok-1")

    assert preds == [
        {"description": "Longview, TX, USA", "place_id": "PID_A"},
        {"description": "Longview, WA, USA", "place_id": "PID_B"},
    ]
    # New API: POST to the v1 autocomplete endpoint with a JSON body.
    assert captured["method"] == "POST"
    assert captured["url"] == "https://places.googleapis.com/v1/places:autocomplete"
    assert captured["kwargs"]["json"] == {"input": "Longview", "sessionToken": "tok-1"}


def test_place_details_parses_new_api_location(monkeypatch):
    payload = {
        "formattedAddress": "Longview, TX, USA",
        "location": {"latitude": 32.5007, "longitude": -94.7405},
    }
    captured = _stub_request(monkeypatch, payload)

    details = geo.place_details("PID_A")

    assert details == {
        "lat": 32.5007,
        "lng": -94.7405,
        "formatted_address": "Longview, TX, USA",
    }
    # New API: GET /v1/places/{id} with the required field mask in a header.
    assert captured["method"] == "GET"
    assert captured["url"] == "https://places.googleapis.com/v1/places/PID_A"
    assert captured["kwargs"]["headers"]["X-Goog-FieldMask"] == "location,formattedAddress"


# --- the key never reaches the URL/query (CLAUDE.md hard rule 7) --------------
def test_key_travels_in_header_never_url_or_query(monkeypatch):
    captured = _stub_request(monkeypatch, {"suggestions": []})

    geo.autocomplete("Longview")

    assert captured["kwargs"]["headers"]["X-Goog-Api-Key"] == SECRET_KEY
    assert SECRET_KEY not in captured["url"]
    assert SECRET_KEY not in str(captured["kwargs"].get("params"))


# --- empty --------------------------------------------------------------------
def test_autocomplete_empty_suggestions_returns_empty_list(monkeypatch):
    _stub_request(monkeypatch, {"suggestions": []})
    assert geo.autocomplete("zzzz") == []


def test_autocomplete_missing_suggestions_key_returns_empty_list(monkeypatch):
    _stub_request(monkeypatch, {})
    assert geo.autocomplete("zzzz") == []


# --- REQUEST_DENIED: dev-visible vs fail-closed -------------------------------
_DENIED = {"error": {"code": 403, "status": "REQUEST_DENIED", "message": "denied"}}


def test_request_denied_is_dev_visible_in_non_prod(monkeypatch, caplog):
    monkeypatch.setenv("APP_ENV", "dev")
    _stub_request(monkeypatch, _DENIED, status_code=403)

    with caplog.at_level(logging.ERROR, logger="app.geo.client"):
        with pytest.raises(geo.GeoUpstreamError) as ei:
            geo.autocomplete("Longview")

    # Dev surfaces the upstream status on the error AND in the log...
    assert "REQUEST_DENIED" in str(ei.value)
    assert "REQUEST_DENIED" in caplog.text
    # ...but never the key, and never a chained key-bearing cause.
    assert SECRET_KEY not in str(ei.value)
    assert SECRET_KEY not in caplog.text
    assert ei.value.__cause__ is None


def test_request_denied_fails_closed_in_prod(monkeypatch, caplog):
    monkeypatch.setenv("APP_ENV", "prod")
    _stub_request(monkeypatch, _DENIED, status_code=403)

    with caplog.at_level(logging.WARNING, logger="app.geo.client"):
        with pytest.raises(geo.GeoUpstreamError) as ei:
            geo.autocomplete("Longview")

    # Prod fails closed: no status detail, no key, anywhere.
    assert "REQUEST_DENIED" not in str(ei.value)
    assert "REQUEST_DENIED" not in caplog.text
    assert SECRET_KEY not in str(ei.value)
    assert SECRET_KEY not in caplog.text


def test_http_status_surfaced_when_no_status_token(monkeypatch):
    monkeypatch.setenv("APP_ENV", "dev")
    _stub_request(monkeypatch, {}, status_code=500)
    with pytest.raises(geo.GeoUpstreamError) as ei:
        geo.place_details("PID_A")
    assert "HTTP 500" in str(ei.value)


def test_transport_error_does_not_leak_key(monkeypatch):
    monkeypatch.setenv("APP_ENV", "dev")

    def boom(method, url, **kwargs):
        # httpx error strings can embed the request line; the seam must not relay it.
        raise httpx.ConnectError(f"connect failed for {url}?key={SECRET_KEY}")

    monkeypatch.setattr(geo.httpx, "request", boom)
    with pytest.raises(geo.GeoUpstreamError) as ei:
        geo.autocomplete("Longview")
    assert SECRET_KEY not in str(ei.value)
    assert ei.value.__cause__ is None


# --- details contract edge cases ----------------------------------------------
def test_place_details_no_location_raises(monkeypatch):
    _stub_request(monkeypatch, {"formattedAddress": "X"})
    with pytest.raises(geo.GeoUpstreamError):
        geo.place_details("PID_A")


def test_place_details_empty_resource_raises(monkeypatch):
    _stub_request(monkeypatch, {})
    with pytest.raises(geo.GeoUpstreamError):
        geo.place_details("PID_A")

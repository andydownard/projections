"""Rate limits on the cost-DoS surfaces (SECURITY.md §10; issues #164, #168).

`POST /api/projections` (create) mints tokens + runs engine compute + a durable
write with NO auth, so it is capped at 20/hour/IP (SECURITY.md §10.1). The export
surfaces reachable with only the public view_slug are uncached CPU rebuilds
(`/xlsx`, `/packet`) or hit the billed Google Static Maps API (`/staticmap`), so
each is capped per-IP (and per-token for the exports, when a bearer is presented).

Over the cap -> 429 with a `retry_after_seconds` body + `Retry-After` header,
BEFORE any compute/build/upstream call. The client IP is the right-most
X-Forwarded-For hop (the only hop Railway's single proxy controls; left-most
entries are attacker-spoofable). The Playwright E2E gate (create->export across
three viewports) must never trip these, so the limiter is bypassed under the
non-prod E2E seed flag.

RED-first: written before create/xlsx/packet/staticmap call ratelimit.check.
"""
import pytest
from fastapi.testclient import TestClient

import app.routers.projections as P
from app.geo import client as geo_client
from app.main import create_app
from app.ratelimit import reset_rate_limits
from app.store import get_store
from app.store.sqlite import SqliteStore

VALID_BODY = {
    "name": "House of Hope",
    "inputs": {
        "org_name": "House of Hope",
        "city": "Longview, Texas",
        "opening_status": "pre_launch",
        "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
        "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
        "source_of_funds": "300000", "occupancy_annual": "120000",
        "lease_type": "nnn", "nnn_opex_annual": "0",
    },
    "trade_area": {"basis": "city", "households": "31798"},
    "assumptions": {"labor_pct": "0.60"},
}
# Exports require terms acceptance (PRD §21) before they build anything.
EXPORT_BODY = {**VALID_BODY, "terms_accepted": True}
MAP_BODY = {**EXPORT_BODY, "location": {"lat": 32.5007, "lng": -94.7405}}


@pytest.fixture(autouse=True)
def _reset_limits():
    reset_rate_limits()
    yield
    reset_rate_limits()


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


@pytest.fixture()
def client(store, monkeypatch):
    # Stub the static-map byte fetch so /staticmap needs no Google key/network.
    monkeypatch.setattr(geo_client, "_get_bytes", lambda url: b"PNGDATA")
    geo_client.reset_static_cache()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


def _create(client, body=VALID_BODY, headers=None):
    return client.post("/api/projections", json=body, headers=headers or {})


# ----------------------------------------------------------------- #164 create
def test_create_default_cap_is_20_per_hour_per_ip():
    # SECURITY.md §10.1 specs POST /api/projections (create) at 20 / hour / IP.
    assert P._CREATE_IP_LIMIT == 20
    assert P._CREATE_WINDOW_SECONDS == 3600


def test_create_under_cap_succeeds(client, monkeypatch):
    monkeypatch.setattr(P, "_CREATE_IP_LIMIT", 3, raising=False)
    for _ in range(3):
        r = _create(client)
        assert r.status_code == 201, r.text


def test_create_over_cap_returns_429_with_retry_after(client, monkeypatch):
    monkeypatch.setattr(P, "_CREATE_IP_LIMIT", 3, raising=False)
    for _ in range(3):
        assert _create(client).status_code == 201
    r = _create(client)
    assert r.status_code == 429, r.text
    assert r.json()["error"] == "rate_limited"
    assert r.json()["retry_after_seconds"] >= 1
    assert int(r.headers["Retry-After"]) >= 1


def test_create_cap_is_per_client_ip_rightmost_xff(client, monkeypatch):
    # The client IP is the RIGHT-MOST X-Forwarded-For hop (Railway's single proxy).
    monkeypatch.setattr(P, "_CREATE_IP_LIMIT", 2, raising=False)
    real = {"X-Forwarded-For": "9.9.9.9, 1.1.1.1"}  # client == 1.1.1.1
    for _ in range(2):
        assert _create(client, headers=real).status_code == 201
    # 1.1.1.1 is now capped...
    assert _create(client, headers=real).status_code == 429
    # ...and prepending a spoofed left-most hop does NOT escape the cap (same bucket).
    spoof = {"X-Forwarded-For": "8.8.8.8, 7.7.7.7, 1.1.1.1"}
    assert _create(client, headers=spoof).status_code == 429
    # A genuinely different right-most hop is an independent bucket.
    other = {"X-Forwarded-For": "9.9.9.9, 2.2.2.2"}
    assert _create(client, headers=other).status_code == 201


def test_create_bypassed_under_e2e_seed_flag(client, monkeypatch):
    # The Playwright create->export gate (E2E_SEED=1, non-prod) must never 429.
    monkeypatch.setattr(P, "_CREATE_IP_LIMIT", 2, raising=False)
    monkeypatch.setenv("E2E_SEED", "1")
    monkeypatch.setenv("APP_ENV", "dev")
    for _ in range(6):  # far past the cap
        assert _create(client).status_code == 201


# ------------------------------------------------------------ #168 xlsx export
def test_xlsx_under_cap_succeeds_over_cap_429(client, monkeypatch):
    monkeypatch.setattr(P, "_EXPORT_IP_LIMIT", 3, raising=False)
    slug = _create(client, EXPORT_BODY).json()["view_slug"]
    for _ in range(3):
        assert client.get(f"/api/projections/{slug}/xlsx").status_code == 200
    r = client.get(f"/api/projections/{slug}/xlsx")
    assert r.status_code == 429, r.text
    assert r.json()["error"] == "rate_limited"
    assert "retry_after_seconds" in r.json()
    assert "Retry-After" in r.headers


# ----------------------------------------------------------- #168 packet export
def test_packet_under_cap_succeeds_over_cap_429(client, monkeypatch):
    monkeypatch.setattr(P, "_EXPORT_IP_LIMIT", 3, raising=False)
    slug = _create(client, EXPORT_BODY).json()["view_slug"]
    for _ in range(3):
        assert client.get(f"/api/projections/{slug}/packet").status_code == 200
    r = client.get(f"/api/projections/{slug}/packet")
    assert r.status_code == 429, r.text
    assert r.json()["error"] == "rate_limited"


# --------------------------------------------------------- #168 static-map proxy
def test_staticmap_under_cap_succeeds_over_cap_429(client, monkeypatch):
    monkeypatch.setattr(P, "_STATICMAP_IP_LIMIT", 3, raising=False)
    slug = _create(client, MAP_BODY).json()["view_slug"]
    for _ in range(3):
        assert client.get(f"/api/projections/{slug}/staticmap").status_code == 200
    r = client.get(f"/api/projections/{slug}/staticmap")
    assert r.status_code == 429, r.text
    assert r.json()["error"] == "rate_limited"

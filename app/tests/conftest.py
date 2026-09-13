"""Shared app-test fixtures.

The rate limiter (`app.ratelimit`) keeps a PROCESS-GLOBAL counter, so without a
reset the per-IP caps (e.g. create at 20/hr, SECURITY.md §10.1) accumulate across
every test in a session — TestClient presents one socket peer, so the whole suite
shares a single IP bucket and later `POST /api/projections` calls would spuriously
429. Reset before each test to isolate the limiter (the preview/places tests already
reset explicitly; this makes it automatic for all app tests). A within-test sequence
of requests still accumulates normally, so the rate-limit tests are unaffected.

Also home to the shared `client` / `client_store` fixtures and the
`create_projection` helper (the exact pattern copied from
test_projections_api.py, the most-duplicated variant). NEW tests use these;
the existing files keep their local fixtures for now (migration is a separate
ticket) — pytest gives a file-local fixture precedence over conftest's, so the
identical names here cannot shadow-break them.
"""
import copy

import pytest
from fastapi.testclient import TestClient

from app.feedback.dedup import reset_dedup
from app.main import create_app
from app.ratelimit import reset_rate_limits
from app.store import get_store
from app.store.sqlite import SqliteStore


@pytest.fixture(autouse=True)
def _isolate_rate_limits():
    reset_rate_limits()
    # Penny's feedback dedup map is also PROCESS-GLOBAL (mirrors the rate limiter);
    # reset it so a redacted body filed in one test never deduplicates the next.
    reset_dedup()
    yield
    reset_rate_limits()
    reset_dedup()


@pytest.fixture()
def client():
    store = SqliteStore(":memory:")
    store.migrate()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


@pytest.fixture()
def client_store():
    """A client paired with its store, so a test can plant a raw stored row."""
    store = SqliteStore(":memory:")
    store.migrate()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app), store


# The canonical House-of-Hope create body (ENGINE_CONTRACT §10 fixture inputs).
CANONICAL_BODY = {
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


def create_projection(client, **overrides):
    """POST the canonical House-of-Hope body; return (slug, version, body).

    ``overrides`` replace top-level keys of the body (e.g. ``name=...``,
    ``inputs={...}``); the canonical template itself is never mutated. ``body``
    is the parsed create response (view_slug, version, the full view-model).
    This project has no authentication (owner decision, 2026-09-13) — there is
    no owner/edit token in the response anymore.
    """
    payload = copy.deepcopy(CANONICAL_BODY)
    payload.update(overrides)
    r = client.post("/api/projections", json=payload)
    assert r.status_code == 201, r.text
    body = r.json()
    return body["view_slug"], body["version"], body

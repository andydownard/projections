"""Shared app-test fixtures.

The rate limiter (`app.ratelimit`) keeps a PROCESS-GLOBAL counter, so without a
reset the per-IP caps (e.g. create at 20/hr, SECURITY.md §10.1) accumulate across
every test in a session — TestClient presents one socket peer, so the whole suite
shares a single IP bucket and later `POST /api/projections` calls would spuriously
429. Reset before each test to isolate the limiter (the preview/places tests already
reset explicitly; this makes it automatic for all app tests). A within-test sequence
of requests still accumulates normally, so the rate-limit tests are unaffected.
"""
import pytest

from app.ratelimit import reset_rate_limits


@pytest.fixture(autouse=True)
def _isolate_rate_limits():
    reset_rate_limits()
    yield
    reset_rate_limits()

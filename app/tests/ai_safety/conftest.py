"""Fixtures + the no-real-network guard for the Penny AI-safety suite (PE11 #130).

CLAUDE.md / SECURITY §6.3: stubbed providers ONLY — no test may ever reach
``api.anthropic.com`` / ``api.openai.com``. ``_no_real_network`` is autouse and
makes the provider's real HTTP seam raise, so any accidental real call fails the
suite loudly. The FastAPI ``TestClient`` is unaffected (it drives the app in-process
via ``httpx.Client``/ASGI, not the module-level ``httpx.post`` we block).
"""
from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

import app.penny.providers as providers_mod
from app.main import create_app
from app.ratelimit import reset_rate_limits
from app.store import get_store
from app.store.sqlite import SqliteStore

from .harness import VALID_BODY


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


@pytest.fixture()
def client(store):
    reset_rate_limits()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


@pytest.fixture()
def projection(client):
    r = client.post("/api/projections", json=VALID_BODY)
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture(autouse=True)
def _no_real_network(monkeypatch):
    """Hard-fail any real provider network call (stubbed providers only)."""

    def _boom(*args, **kwargs):  # pragma: no cover - only fires on a violation
        raise AssertionError(
            "real provider network call attempted — Penny tests must use stubbed "
            "providers only (SECURITY §6.3 / CLAUDE.md)."
        )

    # Block both the module-level helper and the providers' default transport seam.
    monkeypatch.setattr(httpx, "post", _boom)
    monkeypatch.setattr(providers_mod, "_httpx_transport", _boom)
    yield

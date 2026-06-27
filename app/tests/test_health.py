"""Health/readiness tests (#190) — the endpoint must reflect REAL subsystem state.

The old `/api/health` hard-coded ``status:"ok"`` and returned HTTP 200 even with the
DB unavailable (fails OPEN — Railway kept routing to a broken instance). These tests
pin the fix:

- **Primary `/api/health` keeps the EXACT deploy-gate contract** — HTTP 200 with the
  ``{status, build_sha, model_version, db, litestream}`` shape **when actually
  healthy** (Railway healthcheck + ``scripts/promote.py`` depend on a 200 +
  ``build_sha`` + ``db=="connected"`` + ``litestream=="replicating"``). It MUST NOT
  flap to non-200 on a transient blip (that would fail-loop deploys).
- **The unhealthy signal is surfaced LOUDLY**, not masked: the ``status`` field flips
  to ``degraded``/``unhealthy`` on the primary endpoint, and a SEPARATE deeper
  readiness probe (``/api/health/ready``) returns **HTTP 503** when the data path is
  down so external monitoring can alert.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import config
from app.health import (
    STATUS_DEGRADED,
    STATUS_OK,
    STATUS_UNHEALTHY,
    assess_status,
    uptime_seconds,
)
from engine.model import COMPUTE_SCHEMA_VERSION, MODEL_VERSION

PRIMARY_KEYS = {"status", "build_sha", "model_version", "db", "litestream"}


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    from app.main import create_app

    return TestClient(create_app())


# --- assess_status (pure decision matrix) -----------------------------------
def test_assess_status_healthy_is_ok():
    assert assess_status(db_ok=True, litestream="replicating", production=True) == STATUS_OK
    # dev/test: litestream "disabled" is expected and must NOT degrade the status.
    assert assess_status(db_ok=True, litestream="disabled", production=False) == STATUS_OK


def test_assess_status_db_down_is_unhealthy():
    # The DB is the data path: down => the loudest signal, in every environment.
    assert assess_status(db_ok=False, litestream="replicating", production=True) == STATUS_UNHEALTHY
    assert assess_status(db_ok=False, litestream="disabled", production=False) == STATUS_UNHEALTHY


def test_assess_status_prod_replication_off_is_degraded():
    # Backups silently off in prod (OPS_RUNBOOK §4.3) is degraded — not "ok".
    assert assess_status(db_ok=True, litestream="disabled", production=True) == STATUS_DEGRADED


def test_uptime_seconds_is_nonnegative_int():
    val = uptime_seconds()
    assert isinstance(val, int)
    assert val >= 0


# --- primary /api/health (deploy-gate contract) -----------------------------
def test_health_healthy_returns_200_status_ok_and_exact_shape(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == PRIMARY_KEYS  # shape preserved EXACTLY (promote.py)
    assert body["status"] == "ok"
    assert body["db"] == "connected"
    assert body["model_version"] == MODEL_VERSION
    assert "build_sha" in body
    assert "litestream" in body


def test_health_db_down_is_unhealthy_but_still_http_200(client, monkeypatch):
    # Simulate a post-boot DB failure (volume detach / corruption). The primary
    # healthcheck must NOT flap to non-200 (deploy gate), but it must STOP lying:
    # status flips to "unhealthy" and db reads "unavailable".
    import app.routers.health as health_router

    class _DeadStore:
        def ping(self) -> bool:
            raise RuntimeError("disk I/O error")

    monkeypatch.setattr(health_router, "get_store", lambda: _DeadStore())
    resp = client.get("/api/health")
    assert resp.status_code == 200  # NEVER flaps the deploy gate on a blip
    body = resp.json()
    assert body["status"] == "unhealthy"
    assert body["db"] == "unavailable"
    assert set(body.keys()) == PRIMARY_KEYS


def test_health_prod_litestream_off_is_degraded_but_http_200(client, monkeypatch):
    import app.routers.health as health_router

    monkeypatch.setattr(health_router.config, "is_production", lambda *a, **k: True)
    monkeypatch.setattr(health_router.config, "litestream_status", lambda *a, **k: "disabled")
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["litestream"] == "disabled"


# --- readiness /api/health/ready (deep probe; CAN return 503) ----------------
def test_readiness_healthy_returns_200(client):
    resp = client.get("/api/health/ready")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert isinstance(body["uptime_seconds"], int)
    assert body["checks"]["db"]["ok"] is True


def test_readiness_db_down_returns_503_loudly(client, monkeypatch):
    import app.routers.health as health_router

    class _DeadStore:
        def ping(self) -> bool:
            return False

    monkeypatch.setattr(health_router, "get_store", lambda: _DeadStore())
    resp = client.get("/api/health/ready")
    assert resp.status_code == 503  # the loud, unmissable signal (fixes fail-open)
    body = resp.json()
    assert body["status"] == "unhealthy"
    assert body["checks"]["db"]["ok"] is False


def test_readiness_prod_litestream_off_degraded_but_serveable_200(client, monkeypatch):
    # Backups-off is degraded (alert on the field) but the instance can still
    # serve — readiness stays 200 so we don't restart-loop a serveable replica.
    import app.routers.health as health_router

    monkeypatch.setattr(health_router.config, "is_production", lambda *a, **k: True)
    monkeypatch.setattr(health_router.config, "litestream_status", lambda *a, **k: "disabled")
    resp = client.get("/api/health/ready")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["checks"]["litestream"]["ok"] is False


def test_build_sha_is_driven_by_railway_commit_sha():
    # Closes #190's note: build_sha stays config.build_sha() (RAILWAY_GIT_COMMIT_SHA).
    assert config.build_sha({"RAILWAY_GIT_COMMIT_SHA": "deadbeef"}) == "deadbeef"


def test_health_ping_returns_false_is_unhealthy(client, monkeypatch):
    # ping() can fail by returning False (not only by raising); both => unhealthy.
    import app.routers.health as health_router

    class _Store:
        def ping(self) -> bool:
            return False

    monkeypatch.setattr(health_router, "get_store", lambda: _Store())
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "unhealthy"
    assert body["db"] == "unavailable"


def test_readiness_prod_fully_healthy_returns_200_ok(client, monkeypatch):
    import app.routers.health as health_router

    monkeypatch.setattr(health_router.config, "is_production", lambda *a, **k: True)
    monkeypatch.setattr(health_router.config, "litestream_status", lambda *a, **k: "replicating")
    resp = client.get("/api/health/ready")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["checks"]["litestream"]["ok"] is True
    assert body["checks"]["litestream"]["required"] is True
    assert body["checks"]["db"]["ok"] is True


def test_readiness_carries_build_sha_and_compute_schema_version(client):
    body = client.get("/api/health/ready").json()
    assert "build_sha" in body
    assert body["model_version"] == MODEL_VERSION
    assert body["compute_schema_version"] == COMPUTE_SCHEMA_VERSION


def test_primary_and_readiness_report_the_same_status_when_healthy(client):
    primary = client.get("/api/health").json()["status"]
    ready = client.get("/api/health/ready").json()["status"]
    assert primary == ready == "ok"


def test_readiness_db_down_status_unhealthy_field_matches_503(client, monkeypatch):
    import app.routers.health as health_router

    class _DeadStore:
        def ping(self) -> bool:
            raise RuntimeError("io error")

    monkeypatch.setattr(health_router, "get_store", lambda: _DeadStore())
    resp = client.get("/api/health/ready")
    assert resp.status_code == 503
    assert resp.json()["status"] == STATUS_UNHEALTHY
    assert resp.json()["checks"]["db"]["detail"] == "unavailable"


def test_uptime_seconds_uses_monotonic_origin_and_never_negative():
    from app import health as health_mod

    base = health_mod._BOOT_MONOTONIC
    assert health_mod.uptime_seconds(base + 10.9) == 10  # whole seconds, floored
    assert health_mod.uptime_seconds(base) == 0
    assert health_mod.uptime_seconds(base - 5) == 0  # clamped, never negative


def test_assess_status_dev_db_down_still_unhealthy():
    # Even outside prod, a dead DB is the loudest signal (the data path is broken).
    assert assess_status(db_ok=False, litestream="disabled", production=False) == STATUS_UNHEALTHY

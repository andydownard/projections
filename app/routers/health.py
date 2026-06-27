"""app/routers/health.py — GET /api/health (+ /api/health/ready) (API_SPEC §10).

``/api/health`` is the Railway deploy gate and a deploy smoke test
(``scripts/promote.py``): both depend on a **200 with the exact**
``{status, build_sha, model_version, db, litestream}`` **shape when healthy**, so it
NEVER flaps to non-200 on a transient blip (that fail-loops deploys). It no longer
hard-codes ``status:"ok"`` — ``status`` now reflects REAL subsystem state
(``ok``/``degraded``/``unhealthy``), surfacing trouble LOUDLY in the body (#190).

``/api/health/ready`` is the deeper readiness probe for external monitoring: it
returns **HTTP 503** when the data path is down, so a fail-open instance (DB dead but
still 200 on the primary) is caught loudly. ``build_sha`` stays ``config.build_sha()``
(driven by ``RAILWAY_GIT_COMMIT_SHA``).
"""
from __future__ import annotations

from fastapi import APIRouter, Response

from app import config
from app.health import STATUS_UNHEALTHY, assess_status, uptime_seconds
from app.store import get_store
from engine.model import COMPUTE_SCHEMA_VERSION, MODEL_VERSION

router = APIRouter()


def _probe_db() -> bool:
    """Reachability of the data path via the public Store interface (never raises)."""
    try:
        return bool(get_store().ping())
    except Exception:
        return False


@router.get("/api/health")
def health() -> dict:
    db_ok = _probe_db()
    litestream = config.litestream_status()
    status = assess_status(
        db_ok=db_ok, litestream=litestream, production=config.is_production()
    )
    # Shape is LOAD-BEARING (promote.py asserts these exact keys/values) — keep it
    # exactly {status, build_sha, model_version, db, litestream} and stay HTTP 200.
    return {
        "status": status,
        "build_sha": config.build_sha(),
        "model_version": MODEL_VERSION,
        "db": "connected" if db_ok else "unavailable",
        "litestream": litestream,
    }


@router.get("/api/health/ready")
def readiness(response: Response) -> dict:
    """Deep readiness probe — returns 503 when the instance cannot serve its data path.

    Unlike the primary healthcheck (always 200 so deploys never fail-loop), this MAY
    return non-200 so external monitoring alerts on a broken-but-still-200 instance.
    A ``degraded`` instance (e.g. backups off in prod) can still serve, so it stays
    200 with ``status:"degraded"`` — alert on the field, don't restart-loop it.
    """
    db_ok = _probe_db()
    litestream = config.litestream_status()
    production = config.is_production()
    status = assess_status(db_ok=db_ok, litestream=litestream, production=production)
    body = {
        "status": status,
        "build_sha": config.build_sha(),
        "model_version": MODEL_VERSION,
        "compute_schema_version": COMPUTE_SCHEMA_VERSION,
        "uptime_seconds": uptime_seconds(),
        "checks": {
            "db": {
                "ok": db_ok,
                "detail": "connected" if db_ok else "unavailable",
            },
            "litestream": {
                # In dev/test, replication off is expected (not a readiness fault).
                "ok": (litestream == "replicating") or not production,
                "detail": litestream,
                "required": production,
            },
        },
    }
    if status == STATUS_UNHEALTHY:
        response.status_code = 503  # loud, unmissable: the data path is down
    return body

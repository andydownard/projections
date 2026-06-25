"""app/main.py — FastAPI app factory + boot sequence (ARCHITECTURE §3).

Boot order (SECURITY.md §11.3): migrate -> validate config -> serve. The factory
refuses to boot in production if a required secret is unset (no fallback chains).
Enforcing CSP / noindex / HSTS middleware (M0.5) and CORS locked to the app origin
(M0.5 / SECURITY.md §8.2) are wired on every response.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware

from app import config
from app.middleware import SecurityHeadersMiddleware
from app.routers import health
from app.store import build_store

logger = logging.getLogger("app")

ROBOTS_TXT = "User-agent: *\nDisallow: /\n"


def create_app() -> FastAPI:
    # 1) migrate (build_store runs migrations for sqlite).
    try:
        build_store()
    except Exception as exc:  # dev/test tolerate a missing volume; prod is strict.
        if config.is_production():
            raise
        logger.warning("store init skipped in non-prod: %s", exc)

    # 2) validate config (refuse to boot in prod on a missing required secret).
    config.validate_required()

    app = FastAPI(title="Thrift Store Projection API", docs_url=None, redoc_url=None)

    # CORS locked to the exact app origin; no credentials (no cookies => no CSRF).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[config.app_origin()],
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "If-Match", "Content-Type"],
    )
    # Security headers on EVERY response (added last => outermost).
    app.add_middleware(SecurityHeadersMiddleware)

    app.include_router(health.router)

    @app.get("/robots.txt", include_in_schema=False)
    def robots() -> Response:
        return Response(content=ROBOTS_TXT, media_type="text/plain")

    return app


# uvicorn entrypoint: `uvicorn app.main:app`
app = create_app()

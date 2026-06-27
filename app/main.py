"""app/main.py — FastAPI app factory + boot sequence (ARCHITECTURE §3).

Boot order (SECURITY.md §11.3): migrate -> validate config -> serve. The factory
refuses to boot in production if a required secret is unset (no fallback chains).
Enforcing CSP / noindex / HSTS middleware (M0.5) and CORS locked to the app origin
(M0.5 / SECURITY.md §8.2) are wired on every response.
"""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware

from app import config
from app.middleware import SecurityHeadersMiddleware
from app.routers import feedback, health, intent, places, projections, roles
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

    # 2b) E2E/demo seed: a deterministic `example` projection for the Playwright
    # gate. Never runs in production (it is an explicit opt-in flag).
    if os.environ.get("E2E_SEED") == "1" and not config.is_production():
        try:
            from app.seed import seed_example
            from app.store import get_store

            seed_example(get_store())
        except Exception as exc:  # seeding is best-effort scaffolding
            logger.warning("e2e seed skipped: %s", exc)

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
    app.include_router(projections.router)
    app.include_router(roles.router)
    app.include_router(feedback.router)
    app.include_router(intent.router)
    app.include_router(places.router)

    @app.get("/robots.txt", include_in_schema=False)
    def robots() -> Response:
        return Response(content=ROBOTS_TXT, media_type="text/plain")

    # E2E-only test support: reset the seeded `example` projection to its canonical
    # state so the stateful override/409 flow is deterministic across the three
    # viewport projects sharing one in-memory DB. Gated on E2E_SEED + non-prod —
    # this route does NOT exist in production (no data path, no auth surface).
    if os.environ.get("E2E_SEED") == "1" and not config.is_production():
        from app.seed import reset_example
        from app.store import get_store

        @app.post("/api/_test/reseed", include_in_schema=False)
        def _test_reseed() -> dict:
            reset_example(get_store())
            return {"status": "reseeded"}

    # Serve the built SPA (web/dist) when present (the production Docker image).
    # Registered LAST so /api/*, /robots.txt, etc. match first. No-op locally/in
    # tests (web/dist absent there) so the app stays API-only and tests are unchanged.
    #
    # StaticFiles(html=True) only serves index.html at "/" and for directories, so a
    # deep client route (/wizard, /p/<slug>) 404s on hard-reload or direct nav. We
    # instead serve real files when they exist and fall back to index.html for every
    # other non-API GET, so client-side routing, deep links, and browser back/forward
    # all work. Unknown /api/* still returns a JSON 404 (never index.html).
    spa_dir = os.environ.get("SPA_DIR", "web/dist")
    if os.path.isdir(spa_dir):
        from fastapi.responses import FileResponse
        from fastapi.staticfiles import StaticFiles

        spa_root = os.path.abspath(spa_dir)
        index_file = os.path.join(spa_root, "index.html")
        assets_dir = os.path.join(spa_root, "assets")
        if os.path.isdir(assets_dir):
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        # index.html must NEVER be cached: it references content-hashed asset
        # filenames, so a stale cached index.html points at old (404) bundles and
        # silently pins returning users to a previous deploy. Assets are immutable
        # (hashed names) and stay cacheable via the /assets mount.
        no_cache = {"Cache-Control": "no-cache, must-revalidate"}

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa_fallback(full_path: str) -> Response:
            if full_path.startswith("api/"):
                raise HTTPException(status_code=404, detail={"error": "not_found"})
            # Serve a real static file (favicon.svg, etc.) if it resolves inside spa_dir.
            candidate = os.path.normpath(os.path.join(spa_root, full_path))
            if candidate.startswith(spa_root + os.sep) and os.path.isfile(candidate):
                return FileResponse(candidate)
            return FileResponse(index_file, headers=no_cache)  # SPA client route

    return app


# uvicorn entrypoint: `uvicorn app.main:app`
app = create_app()

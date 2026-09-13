# Dockerfile — slim FastAPI runtime. The app builds .xlsx via openpyxl; LibreOffice
# (soffice) is NOT a runtime dependency — the recalc golden gate runs in CI/local
# tests only (where soffice is installed separately). Bundling LibreOffice here made
# the image ~2GB and stalled the Railway image push, so it is intentionally excluded
# from the runtime image (ENGINE_CONTRACT §13.8 recalc gate stays a CI concern).
FROM python:3.12-slim AS base

# ca-certificates (httpx HTTPS) + Litestream (continuous SQLite -> R2 backups).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.deb -o /tmp/litestream.deb \
    && dpkg -i /tmp/litestream.deb \
    && rm /tmp/litestream.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Python deps ---
COPY pyproject.toml ./
# IMPORTANT: this list MUST cover every runtime dep in pyproject [project.dependencies].
# It is NOT auto-derived from pyproject, so a new runtime dep added there must be added
# here too — scripts/test_dockerfile_deps.py is a CI guard that fails if they drift.
# (bleach was missing here once and crash-looped a prod deploy on `import bleach`.)
RUN pip install --no-cache-dir \
    "fastapi>=0.110" "uvicorn[standard]" "pydantic>=2" httpx openpyxl "python-docx>=1.1" bleach

# --- Frontend build ---
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- Final image ---
FROM base AS final
COPY app/ ./app/
COPY engine/ ./engine/
COPY --from=web /web/dist ./web/dist
COPY litestream.yml /etc/litestream.yml
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

ENV APP_ENV=production
ENV DB_BACKEND=sqlite
ENV DB_PATH=/data/projections.db

EXPOSE 8000
# Boot order: (best-effort restore from R2 if volume lost) -> exec uvicorn ->
# migrate -> validate -> serve. UVICORN is the FOREGROUND/main process; when
# LITESTREAM_BUCKET is set, `litestream replicate` runs as a BEST-EFFORT
# BACKGROUND process so a backup/R2 error logs but NEVER crashes the container
# (see start.sh). start.sh binds Railway's injected $PORT (a hardcoded port makes
# the /api/health check fail even though the app booted).
CMD ["/usr/local/bin/start.sh"]

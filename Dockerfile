# Dockerfile — FastAPI + pinned LibreOffice (soffice) for the recalc gate (M0.7).
# The CI/build image pins the LibreOffice version so recalc values cannot shift
# across versions and undermine the <$0.50 tolerance (ENGINE_CONTRACT §13.8).
FROM python:3.12-slim AS base

# LibreOffice (pinned) for the recalc gate + coreutils for `timeout`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-calc-nogui \
        coreutils \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Python deps ---
COPY pyproject.toml ./
RUN pip install --no-cache-dir \
    "fastapi>=0.110" "uvicorn[standard]" "pydantic>=2" httpx openpyxl

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

ENV APP_ENV=production
ENV DB_BACKEND=sqlite
ENV DB_PATH=/data/projections.db

EXPOSE 8000
# Boot order: migrate -> validate config -> serve (SECURITY.md §11.3).
# Bind Railway's injected $PORT (shell form so it expands); default 8000 locally.
# Railway routes traffic + the /api/health check to $PORT — a hardcoded port makes
# the healthcheck fail even though the app booted fine.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]

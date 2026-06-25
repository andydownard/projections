# Dockerfile — slim FastAPI runtime. The app builds .xlsx via openpyxl; LibreOffice
# (soffice) is NOT a runtime dependency — the recalc golden gate runs in CI/local
# tests only (where soffice is installed separately). Bundling LibreOffice here made
# the image ~2GB and stalled the Railway image push, so it is intentionally excluded
# from the runtime image (ENGINE_CONTRACT §13.8 recalc gate stays a CI concern).
FROM python:3.12-slim AS base

# Only ca-certificates (httpx HTTPS to Places/Census/Anthropic/OpenAI).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
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

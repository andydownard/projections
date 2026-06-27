#!/usr/bin/env bash
# scripts/docker_smoke.sh — build the PROD Docker image and prove it BOOTS.
#
# WHY THIS EXISTS
# A prod deploy once crash-looped because the Dockerfile's hardcoded pip list was
# missing `bleach`, so `import bleach` blew up at boot. CI never builds the Docker
# image, so the break was invisible until it hit prod. scripts/test_dockerfile_deps.py
# guards dep-list DRIFT (pyproject vs Dockerfile), but it cannot catch OTHER boot
# failures: a bad start.sh, a config-gate refusal, or a non-pip import that fails.
# This smoke builds the REAL multi-stage prod image, boots it the way Railway does,
# and fails unless GET /api/health serves a 200 with its load-bearing shape — so the
# WHOLE boot-failure class is caught BEFORE merge/deploy.
#
# HOW IT BOOTS (the env, and why)
# The image already defaults to APP_ENV=production + DB_BACKEND=sqlite (Dockerfile
# ENV), so this runs the LITERAL prod boot path. We feed it DUMMY required secrets
# (GOOGLE_PLACES_API_KEY / ANTHROPIC_API_KEY / CENSUS_API_KEY = test) so the prod
# boot-refuse gate in app/config.py is SATISFIED rather than weakened — the gate
# still runs, we just give it throwaway values. We override DB_PATH to a writable
# /tmp path (there is no /data volume in CI) and leave LITESTREAM_BUCKET UNSET so
# start.sh runs uvicorn directly (no R2 backups are needed to prove the app boots).
# In this config /api/health returns 200 with status "degraded" (backups off in
# prod is degraded-but-serving), db "connected" — exactly what we assert below.
#
# Set SKIP_BUILD=1 to reuse an already-built image (CI builds via buildx with a
# layer cache in a prior step, then runs this with SKIP_BUILD=1 to boot+assert).
set -euo pipefail

IMAGE="${IMAGE:-projections-test}"
CONTAINER="${CONTAINER:-projections-smoke}"
HOST_PORT="${HOST_PORT:-8000}"
TIMEOUT="${TIMEOUT:-60}"
# PLATFORM is only needed to verify locally on a non-amd64 host (e.g. an Apple-
# silicon Mac): the Dockerfile pulls the linux-amd64 litestream .deb, so an arm64
# build fails on `dpkg -i`. Set PLATFORM=linux/amd64 to build+run under emulation.
# CI runs on amd64 (ubuntu-latest), so it leaves this unset and builds natively.
PLATFORM="${PLATFORM:-}"
PLATFORM_BUILD_ARG=""
PLATFORM_RUN_ARG=""
if [ -n "$PLATFORM" ]; then
  PLATFORM_BUILD_ARG="--platform $PLATFORM"
  PLATFORM_RUN_ARG="--platform $PLATFORM"
fi

cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "==== container logs (smoke FAILED, rc=$rc) ====" >&2
    docker logs "$CONTAINER" >&2 2>&1 || true
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ "${SKIP_BUILD:-}" = "1" ]; then
  echo "==> SKIP_BUILD=1 — reusing existing image ($IMAGE)"
else
  echo "==> Building prod image ($IMAGE) — the real multi-stage Dockerfile"
  # No forced DOCKER_BUILDKIT: respect the ambient builder so this works on hosts
  # without buildx (the legacy builder handles this Dockerfile's multi-stage COPY
  # --from just fine). CI builds via docker/build-push-action with a layer cache and
  # runs this script with SKIP_BUILD=1, so this build path is for local runs only.
  docker build $PLATFORM_BUILD_ARG -t "$IMAGE" .
fi

# Remove any stale container from a previous run before booting.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

echo "==> Booting container (production mode, dummy secrets, no litestream)"
docker run -d $PLATFORM_RUN_ARG --name "$CONTAINER" -p "${HOST_PORT}:8000" \
  -e GOOGLE_PLACES_API_KEY=test \
  -e ANTHROPIC_API_KEY=test \
  -e CENSUS_API_KEY=test \
  -e DB_PATH=/tmp/test.db \
  -e PORT=8000 \
  "$IMAGE"

echo "==> Polling http://localhost:${HOST_PORT}/api/health (timeout ${TIMEOUT}s)"
deadline=$(( $(date +%s) + TIMEOUT ))
code="000"
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ -z "$(docker ps -q --filter "name=^/${CONTAINER}$" --filter status=running)" ]; then
    echo "!! container is no longer running — it exited during boot" >&2
    exit 1
  fi
  code=$(curl -s -o /tmp/health.json -w '%{http_code}' \
    "http://localhost:${HOST_PORT}/api/health" 2>/dev/null || true)
  [ -z "$code" ] && code="000"
  if [ "$code" = "200" ]; then
    echo "==> /api/health -> 200"
    cat /tmp/health.json
    echo
    break
  fi
  sleep 2
done

if [ "$code" != "200" ]; then
  echo "!! /api/health never returned 200 within ${TIMEOUT}s (last: ${code})" >&2
  exit 1
fi

echo "==> Asserting /api/health shape (status/build_sha/model_version/db)"
python3 - <<'PY'
import json
with open("/tmp/health.json") as f:
    body = json.load(f)
required = ("status", "build_sha", "model_version", "db")
missing = [k for k in required if k not in body]
assert not missing, f"/api/health is missing keys {missing}; got {sorted(body)}"
# In this CI boot (prod mode, backups intentionally off) status is degraded-but-
# serving; unhealthy would mean the data path is down, which is a real boot failure.
assert body["status"] in ("ok", "degraded"), f"unhealthy status: {body['status']!r}"
assert body["db"] == "connected", f"db not connected: {body['db']!r}"
assert body["model_version"], f"empty model_version: {body!r}"
print("health shape OK:", json.dumps(body))
PY

echo "==> Docker boot smoke PASSED"

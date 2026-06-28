#!/bin/sh
# start.sh — container entrypoint (OPS_RUNBOOK / SECURITY §11).
#
# PROCESS MODEL (load-bearing — a backup failure must NEVER crash prod):
#   UVICORN is the container's FOREGROUND / main process (PID 1 via `exec`).
#   `litestream replicate` runs as a BEST-EFFORT BACKGROUND process, and the
#   boot-time restore-from-R2 is BEST-EFFORT too. Any litestream/R2 error
#   (e.g. R2 `SignatureDoesNotMatch`) is LOGGED but NEVER takes uvicorn down —
#   the app keeps serving traffic with backups degraded. This decouples the
#   crash-loop class where litestream owning the process lifecycle (the old
#   `litestream replicate -exec uvicorn`) turned a backup-credential problem
#   into a container crash loop.
#
# BOOT INTENT (preserved, but every R2/litestream step is non-fatal):
#   restore-if-volume-lost (best-effort) -> exec uvicorn (which then runs
#   migrate -> validate -> serve in app startup; /api/health is the gate).
#
# Regression #13 (PRESERVED): WHAT gets replicated is owned by litestream.yml,
# which replicates /data/projections.db (the DURABLE volume) — NEVER /app.
# start.sh only points litestream at that config; it never names a path here.
#
# If Litestream is not configured (LITESTREAM_BUCKET unset — dev/test/CI), run
# uvicorn directly: no backups, app still works (and the docker smoke boots this
# path). Litestream is never required for the app to serve.
set -e
PORT="${PORT:-8000}"
DB_PATH="${DB_PATH:-/data/projections.db}"

if [ -n "$LITESTREAM_BUCKET" ]; then
  echo "litestream: enabled — bucket=${LITESTREAM_BUCKET} db=${DB_PATH} (best-effort; failures are non-fatal)"

  # 1) BEST-EFFORT RESTORE (foreground so it completes before uvicorn opens the
  #    DB, but NON-FATAL). Restores only if there is no local DB AND a replica
  #    exists (first boot / healthy volume is a no-op). A restore failure logs
  #    and continues — the app boots on the local (or fresh) DB rather than dying.
  if ! litestream restore -if-db-not-exists -if-replica-exists \
        -config /etc/litestream.yml "$DB_PATH"; then
    echo "litestream: restore FAILED (non-fatal) — continuing with local/empty DB; backups degraded"
  fi

  # 2) BEST-EFFORT CONTINUOUS REPLICATION in the BACKGROUND. If litestream cannot
  #    authenticate to R2 (SignatureDoesNotMatch / 403) it exits; that is logged
  #    and IGNORED — uvicorn (below) is unaffected and keeps serving.
  (
    litestream replicate -config /etc/litestream.yml \
      || echo "litestream: replicate EXITED (non-fatal) — backups degraded, app still serving"
  ) &
else
  echo "litestream: disabled (LITESTREAM_BUCKET unset) — running uvicorn directly, NO backups"
fi

# UVICORN is ALWAYS the foreground/main process. Litestream never gates it, so a
# backup/R2 error can never crash-loop the container. Railway healthcheck = /api/health.
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT}"

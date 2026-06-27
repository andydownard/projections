#!/bin/sh
# start.sh — container entrypoint (OPS_RUNBOOK / SECURITY §11).
#
# If Litestream is configured (LITESTREAM_BUCKET set): on boot, RESTORE the DB
# from object storage if the local /data copy is missing but a replica exists
# (recovers data after a volume loss), then run uvicorn UNDER `litestream
# replicate -exec` so every WAL change streams to R2 continuously. If Litestream
# is not configured (dev/test), run uvicorn directly — no backups, app still works.
set -e
PORT="${PORT:-8000}"

if [ -n "$LITESTREAM_BUCKET" ]; then
  echo "litestream: enabled — bucket=${LITESTREAM_BUCKET} db=${DB_PATH:-/data/projections.db}"
  # Restore only if there is no local DB AND a replica exists (first boot is a no-op).
  litestream restore -if-db-not-exists -if-replica-exists \
    -config /etc/litestream.yml "${DB_PATH:-/data/projections.db}" || true
  exec litestream replicate -config /etc/litestream.yml \
    -exec "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"
else
  echo "litestream: disabled (LITESTREAM_BUCKET unset) — running uvicorn directly, NO backups"
  exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT}"
fi

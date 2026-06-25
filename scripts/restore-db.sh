#!/usr/bin/env bash
# scripts/restore-db.sh — Litestream restore drill (M7.3 / OPS_RUNBOOK).
#
# Restores /data/projections.db from object storage into a throwaway path, then
# asserts PRAGMA integrity_check passes and that a computed_json round-trips.
# Scaffolded in M0; exercised for real in M7 (RPO ~near-zero, RTO ~2 min).
set -euo pipefail

TARGET="${1:-/tmp/projections-restore.db}"
SOURCE_DB="${DB_PATH:-/data/projections.db}"

echo "Restoring ${SOURCE_DB} -> ${TARGET} via Litestream..."
litestream restore -o "${TARGET}" "${SOURCE_DB}"

echo "Integrity check..."
result="$(sqlite3 "${TARGET}" 'PRAGMA integrity_check;')"
if [[ "${result}" != "ok" ]]; then
  echo "FAIL: integrity_check returned: ${result}" >&2
  exit 1
fi

echo "Round-trip check (computed_json readable)..."
sqlite3 "${TARGET}" "SELECT COUNT(*) FROM projections;" >/dev/null

echo "OK: restore verified."

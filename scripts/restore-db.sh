#!/usr/bin/env bash
# scripts/restore-db.sh — Litestream restore drill (M7.3 / OPS_RUNBOOK §4.4).
#
# Restores /data/projections.db from object storage into a throwaway path, then
# asserts PRAGMA integrity_check passes AND that a known projection's computed_json
# round-trips with its three decision metrics (capital / break-even / reco) intact
# — proving the restored bytes re-render the same DECISION, not merely open.
# Scaffolded in M0; exercised for real in M7. RPO < 10s; RTO ~2-5 min (record both
# in the deploy log; the drill measures wall time around the restore step).
set -euo pipefail

TARGET="${1:-/tmp/projections-restore.db}"
SOURCE_DB="${DB_PATH:-/data/projections.db}"
# A known seeded view_slug to round-trip (override per environment).
VERIFY_SLUG="${RESTORE_VERIFY_SLUG:-example}"

# RTO measurement: wall time around the restore (OPS_RUNBOOK §4.5 step 3-4).
restore_start="$(date +%s)"
echo "Restoring ${SOURCE_DB} -> ${TARGET} via Litestream..."
litestream restore -o "${TARGET}" "${SOURCE_DB}"
restore_end="$(date +%s)"
echo "Restore wall time: $((restore_end - restore_start))s (RTO budget ~120-300s)."

echo "Integrity check..."
result="$(sqlite3 "${TARGET}" 'PRAGMA integrity_check;')"
if [[ "${result}" != "ok" ]]; then
  echo "FAIL: integrity_check returned: ${result}" >&2
  exit 1
fi

# Decision-level round-trip acceptance (OPS_RUNBOOK §4.4): the verifier asserts the
# three decision metrics survive the restore. Exits non-zero on any failure.
echo "Round-trip check (decision metrics re-render)..."
python -m scripts.verify_restore "${TARGET}" --slug "${VERIFY_SLUG}"

echo "OK: restore verified (integrity ok + decision round-trip)."

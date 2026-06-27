#!/usr/bin/env bash
# scripts/restore-db.sh — Litestream restore drill (M7.3 / OPS_RUNBOOK §4.4).
#
# Restores /data/projections.db from object storage (R2) into a THROWAWAY path, then
# asserts PRAGMA integrity_check passes AND that a known projection's computed_json
# round-trips with its three decision metrics (capital / break-even / reco) intact
# — proving the restored bytes re-render the same DECISION, not merely open.
# Scaffolded in M0; exercised for real in M7. RPO < 10s; RTO ~2-5 min (record both
# in the deploy log; the drill measures wall time around the restore step).
#
# Usage:
#   scripts/restore-db.sh [TARGET]
# Env knobs (all optional):
#   DB_PATH                 source DB the config maps to a replica (def /data/projections.db)
#   LITESTREAM_CONFIG       litestream config (def /etc/litestream.yml; passed with -config if present)
#   RESTORE_REPLICA_URL     restore DIRECTLY from a replica URL (file:///… or s3://…), bypassing config
#   RESTORE_VERIFY_SLUG     known view_slug to round-trip (def `example`)
#   RESTORE_SKIP_LITESTREAM =1 → re-verify an already-present TARGET (no restore): re-check a
#                           recovered volume, or exercise the verify/fail-closed path where the
#                           litestream binary is absent (CI). Same acceptance conditions.
#   PYTHON                  python interpreter for the verifier (def `python`)
set -euo pipefail

TARGET="${1:-/tmp/projections-restore.db}"
SOURCE_DB="${DB_PATH:-/data/projections.db}"
CONFIG="${LITESTREAM_CONFIG:-/etc/litestream.yml}"
REPLICA_URL="${RESTORE_REPLICA_URL:-}"
VERIFY_SLUG="${RESTORE_VERIFY_SLUG:-example}"
PYTHON="${PYTHON:-python}"

if [[ "${RESTORE_SKIP_LITESTREAM:-0}" == "1" ]]; then
  # Dry-run / re-verify: no replica pull; assert the SAME acceptance conditions on
  # an already-present TARGET (recovered volume, or CI without the litestream binary).
  echo "RESTORE_SKIP_LITESTREAM=1 — re-verifying existing ${TARGET} (no litestream restore)."
else
  # RTO measurement: wall time around the restore (OPS_RUNBOOK §4.5 step 3-4).
  restore_start="$(date +%s)"
  echo "Restoring -> ${TARGET} via Litestream..."
  if [[ -n "${REPLICA_URL}" ]]; then
    echo "  (replica=${REPLICA_URL})"
    litestream restore -o "${TARGET}" "${REPLICA_URL}"
  elif [[ -f "${CONFIG}" ]]; then
    echo "  (config=${CONFIG} db=${SOURCE_DB})"
    litestream restore -config "${CONFIG}" -o "${TARGET}" "${SOURCE_DB}"
  else
    echo "  (db=${SOURCE_DB})"
    litestream restore -o "${TARGET}" "${SOURCE_DB}"
  fi
  restore_end="$(date +%s)"
  echo "Restore wall time: $((restore_end - restore_start))s (RTO budget ~120-300s)."
fi

echo "Integrity check..."
# `|| true` so a corrupt/garbage file (non-zero sqlite3) still reaches the fail-closed
# branch below instead of aborting under `set -e` with a misleading message.
result="$(sqlite3 "${TARGET}" 'PRAGMA integrity_check;' 2>/dev/null || true)"
if [[ "${result}" != "ok" ]]; then
  echo "FAIL: integrity_check returned: ${result:-<error/empty>}" >&2
  exit 1
fi

count="$(sqlite3 "${TARGET}" 'SELECT count(*) FROM projections;' 2>/dev/null || echo '?')"
echo "Row count (plausibility): projections=${count}"

# Decision-level round-trip acceptance (OPS_RUNBOOK §4.4): the verifier asserts the
# three decision metrics survive the restore. Exits non-zero on any failure.
echo "Round-trip check (decision metrics re-render)..."
"${PYTHON}" -m scripts.verify_restore "${TARGET}" --slug "${VERIFY_SLUG}"

echo "OK: restore verified (integrity ok + decision round-trip)."

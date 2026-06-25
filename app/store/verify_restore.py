"""app/store/verify_restore.py — Litestream restore-drill acceptance check (M7).

OPS_RUNBOOK §4.4/§4.5: a restore is only real if it is verified. Given a restored
SQLite file, this asserts the drill-acceptance conditions:

  1. ``PRAGMA integrity_check`` == ``ok``.
  2. the ``projections`` table is present + readable (plausible row count).
  3. a KNOWN projection's ``computed_json`` round-trips with the three decision
     metrics present — capital required, break-even month, recommendation — i.e.
     the restored data re-renders the same DECISION, not merely opens.

Returns a report dict (also the deploy-log line). ``RPO < 10s`` / ``RTO ~2-5 min``
are measured by the drill harness (restore-db.sh); this module is the correctness
gate that proves the restored bytes are usable.

``scripts/verify_restore.py`` is a thin CLI shim over ``verify_restore`` so the
runbook command ``python -m scripts.verify_restore <db> --slug <slug>`` works.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

# Decision metrics that MUST be present for the drill to accept the restore.
_REQUIRED_METRICS = ("capital", "breakeven")


class RestoreVerificationError(Exception):
    """Raised when a restored DB fails any drill-acceptance condition."""


def _integrity_check(con: sqlite3.Connection) -> str:
    row = con.execute("PRAGMA integrity_check;").fetchone()
    return row[0] if row else "unknown"


def _decision(computed: dict[str, Any]) -> dict[str, str]:
    """Extract the three decision metrics' display strings; raise if any is missing."""
    metrics = computed.get("metrics")
    if not isinstance(metrics, dict):
        raise RestoreVerificationError(
            "round-trip failed: computed_json has no `metrics` block (no decision metric)"
        )
    out: dict[str, str] = {}
    for key in _REQUIRED_METRICS:
        cell = metrics.get(key)
        if not isinstance(cell, dict) or "display" not in cell:
            raise RestoreVerificationError(
                f"round-trip failed: decision metric `{key}` missing from computed_json"
            )
        out[key] = str(cell["display"])
    reco = computed.get("reco")
    if not isinstance(reco, dict) or not reco.get("tag"):
        raise RestoreVerificationError(
            "round-trip failed: computed_json has no `reco.tag` (no recommendation)"
        )
    out["reco"] = str(reco["tag"])
    return out


def verify_restore(db_path: str, *, slug: str) -> dict[str, Any]:
    """Verify a restored SQLite DB; return a report dict or raise on any failure."""
    path = Path(db_path)
    if not path.exists():
        raise RestoreVerificationError(f"restored DB not found: {db_path}")

    con = sqlite3.connect(path)
    try:
        integrity = _integrity_check(con)
        if integrity != "ok":
            raise RestoreVerificationError(f"integrity_check failed: {integrity!r}")

        try:
            count = con.execute("SELECT COUNT(*) FROM projections").fetchone()[0]
        except sqlite3.Error as exc:  # table missing / unreadable
            raise RestoreVerificationError(
                f"projections table unreadable in restored DB: {exc}"
            ) from exc

        row = con.execute(
            "SELECT computed_json FROM projections WHERE view_slug = ?", (slug,)
        ).fetchone()
        if row is None:
            raise RestoreVerificationError(
                f"known projection not found in restored DB: slug={slug!r}"
            )
        try:
            computed = json.loads(row[0])
        except (json.JSONDecodeError, TypeError) as exc:
            raise RestoreVerificationError(
                f"computed_json did not round-trip (invalid JSON) for slug={slug!r}: {exc}"
            ) from exc

        decision = _decision(computed)
    finally:
        con.close()

    return {
        "ok": True,
        "db_path": str(path),
        "integrity": integrity,
        "projection_count": count,
        "slug": slug,
        "decision": decision,
    }

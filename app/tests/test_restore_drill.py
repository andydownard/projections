"""M7.3 — `scripts/restore-db.sh` restore-drill harness (OPS_RUNBOOK §4.4).

An untested restore is fiction. These exercise the SHELL drill itself (not just the
`verify_restore` module it calls), in two layers:

  * **dry-run / re-verify** (`RESTORE_SKIP_LITESTREAM=1`) — verify an already-present
    target WITHOUT pulling a replica. This runs in CI (no `litestream` binary needed)
    and proves the script's accept/fail-closed branches: integrity-ok + decision
    round-trip pass; a corrupt DB, an unknown slug, or a missing decision metric each
    exit NON-ZERO (fail closed — never falsely report success).
  * **live drill** (skip-guarded on the `litestream` binary) — seed a REAL projection
    with the engine, replicate it to a throwaway file replica, run `restore-db.sh` to
    restore into a throwaway target, and assert the restored projection's computed_json
    re-renders IDENTICAL decision metrics (capital / break-even / recommendation) vs the
    pre-drill snapshot. This is the deliverable: the recorded run lives in OPS_RUNBOOK §4.4.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "restore-db.sh"
LITESTREAM = shutil.which("litestream")

# restore-db.sh shells out to `sqlite3` (integrity + row count) under `bash`; guard
# the shell-driving tests so CI stays green on an image that lacks either binary.
REQUIRES_SHELL = pytest.mark.skipif(
    shutil.which("sqlite3") is None or shutil.which("bash") is None,
    reason="restore-db.sh requires the sqlite3 + bash CLIs",
)

# A known-good computed_json with the three decision metrics + a recommendation.
_GOOD = {
    "reco": {"tag": "proceed", "headline": "Proceed", "sub": "ok"},
    "metrics": {
        "capital": {"raw": 277990, "display": "$277,990"},
        "breakeven": {"raw": 5, "display": "Month 5"},
        "cashGap": {"raw": -12000, "display": "($12,000)"},
    },
}


def _make_db(path: Path, *, computed: dict = _GOOD, slug: str = "example") -> None:
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE projections (view_slug TEXT PRIMARY KEY, computed_json TEXT NOT NULL)"
    )
    con.execute(
        "INSERT INTO projections(view_slug, computed_json) VALUES (?, ?)",
        (slug, json.dumps(computed)),
    )
    con.commit()
    con.close()


def _run(target: Path, **env: str) -> subprocess.CompletedProcess:
    """Invoke restore-db.sh from the repo root with the worktree python on PATH."""
    e = dict(os.environ)
    e["PYTHON"] = sys.executable  # script verifies via `$PYTHON -m scripts.verify_restore`
    e["PYTHONPATH"] = str(REPO)
    e.update({k: str(v) for k, v in env.items()})
    return subprocess.run(
        ["bash", str(SCRIPT), str(target)],
        cwd=str(REPO),
        env=e,
        capture_output=True,
        text=True,
    )


# --- dry-run / re-verify (CI-runnable, no litestream binary) ---------------------


@REQUIRES_SHELL
def test_dry_run_verifies_sound_db(tmp_path: Path) -> None:
    db = tmp_path / "restored.db"
    _make_db(db)
    r = _run(db, RESTORE_SKIP_LITESTREAM="1", RESTORE_VERIFY_SLUG="example")
    assert r.returncode == 0, r.stderr + r.stdout
    assert "restore verified" in r.stdout
    # the deploy-log JSON line is emitted by the verifier
    assert '"ok": true' in r.stdout


@REQUIRES_SHELL
def test_dry_run_fails_closed_on_failed_integrity(tmp_path: Path) -> None:
    # A non-SQLite/corrupt file → PRAGMA integrity_check is not `ok` → exit non-zero.
    db = tmp_path / "corrupt.db"
    db.write_bytes(b"this is not a valid sqlite database " * 16)
    r = _run(db, RESTORE_SKIP_LITESTREAM="1", RESTORE_VERIFY_SLUG="example")
    assert r.returncode != 0
    assert "integrity_check" in r.stderr


@REQUIRES_SHELL
def test_dry_run_fails_closed_on_unknown_slug(tmp_path: Path) -> None:
    db = tmp_path / "restored.db"
    _make_db(db)
    r = _run(db, RESTORE_SKIP_LITESTREAM="1", RESTORE_VERIFY_SLUG="does-not-exist")
    assert r.returncode != 0
    assert "RESTORE VERIFY FAILED" in r.stderr


@REQUIRES_SHELL
def test_dry_run_fails_closed_on_missing_decision_metric(tmp_path: Path) -> None:
    db = tmp_path / "restored.db"
    _make_db(db, computed={"reco": {"tag": "proceed"}})  # no metrics block
    r = _run(db, RESTORE_SKIP_LITESTREAM="1", RESTORE_VERIFY_SLUG="example")
    assert r.returncode != 0
    assert "RESTORE VERIFY FAILED" in r.stderr


# --- live drill (skip-guarded on the litestream binary) --------------------------


@REQUIRES_SHELL
@pytest.mark.skipif(
    LITESTREAM is None,
    reason="litestream binary not installed; the live drill runs where it is present",
)
def test_live_restore_round_trips_real_projection(tmp_path: Path) -> None:
    """Real replicate→restore→verify: a seeded projection's decision survives intact."""
    from app.seed import EXAMPLE_SLUG, seed_example
    from app.store import build_store
    from app.store.verify_restore import verify_restore

    # 1. Seed a REAL db (engine computes the view-model — single math authority).
    src = tmp_path / "source.db"
    store = build_store({"DB_BACKEND": "sqlite", "DB_PATH": str(src)})
    seed_example(store)
    conn = getattr(store, "_conn", None)
    if conn is not None:  # checkpoint + close so litestream snapshots a settled file
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.commit()
        conn.close()

    pre = verify_restore(str(src), slug=EXAMPLE_SLUG)["decision"]
    assert set(pre) == {"capital", "breakeven", "reco"}

    # 2. Replicate to a throwaway FILE replica (stands in for R2 in this env).
    replica = tmp_path / "replica"
    replica.mkdir()
    cfg = tmp_path / "litestream.yml"
    cfg.write_text(
        f"dbs:\n  - path: {src}\n    replicas:\n      - type: file\n        path: {replica}\n"
    )
    # One-shot: litestream snapshots + streams while -exec runs, then shuts down.
    rep = subprocess.run(
        [str(LITESTREAM), "replicate", "-config", str(cfg), "-exec", "sleep 2"],
        capture_output=True,
        text=True,
    )
    assert rep.returncode == 0, rep.stderr

    # 3. Restore into a throwaway target via the drill script + verify round-trip.
    target = tmp_path / "restored.db"
    r = _run(
        target,
        LITESTREAM_CONFIG=str(cfg),
        DB_PATH=str(src),
        RESTORE_VERIFY_SLUG=EXAMPLE_SLUG,
    )
    assert r.returncode == 0, r.stderr + r.stdout
    assert "restore verified" in r.stdout

    # 4. The restored decision is byte-identical to the pre-drill snapshot.
    post = verify_restore(str(target), slug=EXAMPLE_SLUG)["decision"]
    assert post == pre

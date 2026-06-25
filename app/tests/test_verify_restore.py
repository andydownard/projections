"""M7 hardening — Litestream restore-drill verifier (OPS_RUNBOOK §4.4 / §4.5).

`scripts/restore-db.sh` restores the latest replica into a throwaway path; this
verifier is its acceptance check (an untested restore is fiction). It asserts, on
the restored SQLite file:

  * PRAGMA integrity_check == "ok"
  * row counts are plausible (projections table present + readable)
  * a known projection's computed_json round-trips with the THREE decision metrics
    present (capital required, break-even month, recommendation) — proving the
    restored data re-renders the same decision, not just that the file opened.

RPO/RTO are recorded by the drill; the verifier reports the metrics so the deploy
log line is machine-checkable.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from app.store.verify_restore import (
    RestoreVerificationError,
    verify_restore,
)


def _make_db(path: Path, *, computed: dict, slug: str = "known-slug") -> None:
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


_GOOD_COMPUTED = {
    "reco": {"tag": "proceed", "headline": "Proceed", "sub": "ok"},
    "metrics": {
        "capital": {"raw": 277990, "display": "$277,990"},
        "breakeven": {"raw": 5, "display": "Month 5"},
        "cashGap": {"raw": -12000, "display": "($12,000)"},
    },
}


def test_verify_passes_on_sound_db(tmp_path):
    db = tmp_path / "restore.db"
    _make_db(db, computed=_GOOD_COMPUTED)
    report = verify_restore(str(db), slug="known-slug")
    assert report["integrity"] == "ok"
    assert report["projection_count"] == 1
    assert report["ok"] is True
    # the three decision metrics are echoed for the deploy-log line
    assert report["decision"]["capital"] == "$277,990"
    assert report["decision"]["breakeven"] == "Month 5"
    assert report["decision"]["reco"] == "proceed"


def test_missing_file_is_an_error(tmp_path):
    with pytest.raises(RestoreVerificationError):
        verify_restore(str(tmp_path / "nope.db"), slug="known-slug")


def test_unknown_slug_is_an_error(tmp_path):
    db = tmp_path / "restore.db"
    _make_db(db, computed=_GOOD_COMPUTED)
    with pytest.raises(RestoreVerificationError) as ei:
        verify_restore(str(db), slug="does-not-exist")
    assert "does-not-exist" in str(ei.value)


def test_missing_decision_metric_fails_round_trip(tmp_path):
    db = tmp_path / "restore.db"
    # computed_json with no metrics block -> decision does not re-render
    _make_db(db, computed={"reco": {"tag": "proceed"}})
    with pytest.raises(RestoreVerificationError) as ei:
        verify_restore(str(db), slug="known-slug")
    assert "metric" in str(ei.value).lower()


def test_corrupt_json_fails_round_trip(tmp_path):
    db = tmp_path / "restore.db"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE projections (view_slug TEXT PRIMARY KEY, computed_json TEXT NOT NULL)"
    )
    con.execute(
        "INSERT INTO projections(view_slug, computed_json) VALUES (?, ?)",
        ("known-slug", "{not json"),
    )
    con.commit()
    con.close()
    with pytest.raises(RestoreVerificationError):
        verify_restore(str(db), slug="known-slug")


def test_missing_reco_fails_round_trip(tmp_path):
    # metrics present but no recommendation -> decision does not fully re-render.
    db = tmp_path / "restore.db"
    _make_db(
        db,
        computed={
            "metrics": {
                "capital": {"display": "$1"},
                "breakeven": {"display": "Month 2"},
            }
        },
    )
    with pytest.raises(RestoreVerificationError) as ei:
        verify_restore(str(db), slug="known-slug")
    assert "reco" in str(ei.value).lower() or "recommendation" in str(ei.value).lower()


def test_metric_without_display_fails(tmp_path):
    # a metric cell that is not a {raw,display} dict must be rejected.
    db = tmp_path / "restore.db"
    _make_db(
        db,
        computed={
            "reco": {"tag": "proceed"},
            "metrics": {"capital": 277990, "breakeven": {"display": "Month 5"}},
        },
    )
    with pytest.raises(RestoreVerificationError) as ei:
        verify_restore(str(db), slug="known-slug")
    assert "capital" in str(ei.value)


def test_report_shape_is_machine_checkable(tmp_path):
    # the deploy-log line carries exactly the fields OPS_RUNBOOK §4.4 records.
    db = tmp_path / "restore.db"
    _make_db(db, computed=_GOOD_COMPUTED)
    report = verify_restore(str(db), slug="known-slug")
    for key in ("ok", "db_path", "integrity", "projection_count", "slug", "decision"):
        assert key in report, f"missing report key: {key}"
    assert report["slug"] == "known-slug"
    assert report["db_path"].endswith("restore.db")
    assert set(report["decision"]) == {"capital", "breakeven", "reco"}


def test_projection_count_reflects_multiple_rows(tmp_path):
    db = tmp_path / "restore.db"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE projections (view_slug TEXT PRIMARY KEY, computed_json TEXT NOT NULL)"
    )
    for i in range(3):
        con.execute(
            "INSERT INTO projections(view_slug, computed_json) VALUES (?, ?)",
            (f"slug-{i}", json.dumps(_GOOD_COMPUTED)),
        )
    con.commit()
    con.close()
    report = verify_restore(str(db), slug="slug-1")
    assert report["projection_count"] == 3


def test_no_projections_table_is_an_error(tmp_path):
    db = tmp_path / "restore.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE unrelated (id TEXT)")
    con.commit()
    con.close()
    with pytest.raises(RestoreVerificationError) as ei:
        verify_restore(str(db), slug="known-slug")
    assert "projections" in str(ei.value).lower()


def test_cli_shim_success_prints_json(tmp_path, capsys):
    from scripts.verify_restore import main

    db = tmp_path / "restore.db"
    _make_db(db, computed=_GOOD_COMPUTED)
    rc = main([str(db), "--slug", "known-slug"])
    assert rc == 0
    out = capsys.readouterr().out
    report = json.loads(out)
    assert report["ok"] is True
    assert report["decision"]["reco"] == "proceed"


def test_cli_shim_failure_exits_nonzero(tmp_path, capsys):
    from scripts.verify_restore import main

    rc = main([str(tmp_path / "nope.db"), "--slug", "known-slug"])
    assert rc == 1
    err = capsys.readouterr().err
    assert "RESTORE VERIFY FAILED" in err

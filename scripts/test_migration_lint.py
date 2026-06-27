"""Tests for scripts/migration_lint.py — the CI-enforced additive-only scanner.

The standalone scanner is what `.github/workflows/ci.yml` runs so the additive-only
DB discipline (CLAUDE.md / DATA_MODEL §8 / OPS_RUNBOOK §8) fails the build the moment
a DROP/recreate/non-additive statement is introduced — BEFORE it can touch the single
durable volume. It reuses ``app.store.migration_safety`` (the same gate the boot path
enforces fail-closed) over the exact MIGRATIONS list the app applies at boot.
"""
from __future__ import annotations

import pytest

import scripts.migration_lint as ml
from app.store.migrations import MIGRATIONS


def test_shipped_migrations_lint_clean():
    # The real, append-only MIGRATIONS list is additive-only (no findings).
    assert ml.lint(MIGRATIONS) == []


def test_lint_defaults_to_shipped_migrations():
    # Called with no argument it scans the shipped MIGRATIONS list.
    assert ml.lint() == []


def test_main_exit_zero_on_clean(capsys):
    assert ml.main([]) == 0
    out = capsys.readouterr().out
    assert "migration-lint OK" in out
    # report the count of migrations scanned (operator-visible)
    assert str(len(MIGRATIONS)) in out


@pytest.mark.parametrize(
    "sql",
    [
        "DROP TABLE projections;",
        "drop   table  IF EXISTS revisions;",
        "ALTER TABLE projections DROP COLUMN name;",
        "ALTER TABLE projections RENAME TO old_projections;",
        "ALTER TABLE projections RENAME COLUMN name TO title;",
        "DELETE FROM projections;",
        "TRUNCATE TABLE projections;",
        "ALTER TABLE projections ALTER COLUMN name TYPE INTEGER;",
        "DROP INDEX idx_projections_view_slug;",
        # a destructive statement hidden inside an otherwise-additive batch
        "CREATE TABLE x (id TEXT); DROP TABLE projections;",
    ],
)
def test_lint_flags_each_destructive_statement(sql):
    problems = ml.lint([("0099_bad", sql)])
    assert problems, f"expected the scanner to flag: {sql!r}"
    assert problems[0].startswith("0099_bad")


@pytest.mark.parametrize(
    "sql",
    [
        "CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY);",
        "ALTER TABLE narratives ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}';",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx ON t(id);",
        "CREATE INDEX IF NOT EXISTS idx2 ON t(a, b);",
        # a column literally named "drop_off_count" must not trip the DROP scan
        "ALTER TABLE t ADD COLUMN drop_off_count INTEGER NOT NULL DEFAULT 0;",
        # a default string mentioning "drop table" must not trip it
        "ALTER TABLE t ADD COLUMN note TEXT NOT NULL DEFAULT 'do not drop table';",
    ],
)
def test_lint_allows_additive_statements(sql):
    assert ml.lint([("0001_additive", sql)]) == []


def test_main_exit_one_on_destructive_migration(monkeypatch, capsys):
    monkeypatch.setattr(
        ml,
        "MIGRATIONS",
        [("0001_init", "CREATE TABLE t (id TEXT);"),
         ("0099_bad", "DROP TABLE t;")],
    )
    rc = ml.main([])
    assert rc == 1
    err = capsys.readouterr().err
    assert "0099_bad" in err
    assert "DROP TABLE" in err.upper()
    assert "FAILED" in err.upper()
    # the clean migration is NOT implicated in the failure report
    assert "0001_init" not in err


def test_lint_reports_one_entry_per_bad_migration():
    problems = ml.lint(
        [("a_ok", "CREATE TABLE t (id TEXT);"),
         ("b_bad", "DROP TABLE t;"),
         ("c_bad", "TRUNCATE t;")],
    )
    assert len(problems) == 2
    assert any(p.startswith("b_bad") for p in problems)
    assert any(p.startswith("c_bad") for p in problems)


def test_lint_names_the_specific_violations():
    problems = ml.lint([("z_bad", "ALTER TABLE t DROP COLUMN c; DROP INDEX i;")])
    assert len(problems) == 1
    assert "DROP COLUMN" in problems[0]
    assert "DROP INDEX" in problems[0]

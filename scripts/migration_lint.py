"""scripts/migration_lint.py — CI gate: shipped migrations are additive-only.

Standalone scanner wired into ``.github/workflows/ci.yml`` so the additive-only DB
discipline (CLAUDE.md DB discipline / DATA_MODEL §8 / OPS_RUNBOOK §8) fails the build
the moment a ``DROP TABLE`` / ``DROP COLUMN`` / ``RENAME`` / destructive ``ALTER`` /
``TRUNCATE`` / bulk ``DELETE`` / table-recreate is introduced — BEFORE it can run
against the single durable volume with no staging DB copy.

It reuses ``app.store.migration_safety`` (the same gate the boot path enforces
fail-closed in ``SqliteStore.migrate``) over the exact ``MIGRATIONS`` list the app
applies at boot, so the CI gate and the runtime gate can never drift.

    python -m scripts.migration_lint     # exit 0 if all additive, 1 on any violation
"""
from __future__ import annotations

import sys
from collections.abc import Iterable

from app.store.migration_safety import scan_sql
from app.store.migrations import MIGRATIONS


def lint(migrations: Iterable[tuple[str, str]] | None = None) -> list[str]:
    """Return ``"name: violations"`` strings for non-additive migrations (empty = clean)."""
    migrations = MIGRATIONS if migrations is None else migrations
    problems: list[str] = []
    for name, sql in migrations:
        violations = scan_sql(sql)
        if violations:
            problems.append(f"{name}: {', '.join(violations)}")
    return problems


def main(argv: list[str] | None = None) -> int:
    problems = lint()
    if problems:
        print("migration-lint FAILED — non-additive statement(s) detected:",
              file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        print(
            "Migrations are additive-only (CLAUDE.md DB discipline): CREATE TABLE IF "
            "NOT EXISTS / ALTER TABLE ADD COLUMN / CREATE INDEX only — NEVER DROP or "
            "recreate a table/column on the single durable volume.",
            file=sys.stderr,
        )
        return 1
    print(f"migration-lint OK: {len(MIGRATIONS)} migration(s) additive-only.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

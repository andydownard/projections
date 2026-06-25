"""app/store/migration_safety.py — additive-only migration gate (M7 hardening).

CLAUDE.md DB discipline / DATA_MODEL §8: migrations are additive-only —
``CREATE TABLE IF NOT EXISTS`` and ``ALTER TABLE ... ADD COLUMN`` only. A
``DROP TABLE`` / ``DROP COLUMN`` / ``RENAME`` / destructive ``ALTER`` / bulk
``DELETE`` / ``TRUNCATE`` must never ship: by the time a restore drill would help,
the destructive DDL has already run against the durable volume.

This is a static scanner over the migration SQL strings (the same MIGRATIONS list
the app applies at boot). It strips comments and quoted string literals first so a
column literally named ``drop_off_count`` or a default of ``'do not drop table'``
does not false-positive. ``assert_migrations_additive`` is the CI-facing gate.
"""
from __future__ import annotations

import re
from collections.abc import Iterable

# Forbidden, non-additive patterns. Each is matched against SQL with comments and
# string literals removed, case-insensitively, on word boundaries.
_FORBIDDEN: list[tuple[str, str]] = [
    (r"\bDROP\s+TABLE\b", "DROP TABLE"),
    (r"\bDROP\s+COLUMN\b", "DROP COLUMN"),
    (r"\bDROP\s+INDEX\b", "DROP INDEX"),
    (r"\bRENAME\s+TO\b", "RENAME TO"),
    (r"\bRENAME\s+COLUMN\b", "RENAME COLUMN"),
    (r"\bALTER\s+COLUMN\b", "ALTER COLUMN"),
    (r"\bTRUNCATE\b", "TRUNCATE"),
    # Bulk DELETE (no WHERE that scopes it) is destructive in a migration.
    (r"\bDELETE\s+FROM\b", "DELETE FROM"),
]

_LINE_COMMENT = re.compile(r"--[^\n]*")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
# Single- or double-quoted string literals (handles doubled-quote escapes).
_STRING_LIT = re.compile(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"")


class MigrationSafetyError(AssertionError):
    """Raised when a migration contains a non-additive (destructive) statement."""


def _strip(sql: str) -> str:
    """Remove comments and quoted string literals so keyword scans are literal-safe."""
    sql = _BLOCK_COMMENT.sub(" ", sql)
    sql = _LINE_COMMENT.sub(" ", sql)
    sql = _STRING_LIT.sub("''", sql)
    return sql


def scan_sql(sql: str) -> list[str]:
    """Return the list of forbidden constructs found in ``sql`` (empty == additive)."""
    cleaned = _strip(sql)
    found: list[str] = []
    for pattern, label in _FORBIDDEN:
        if re.search(pattern, cleaned, re.IGNORECASE):
            found.append(label)
    return found


def assert_migrations_additive(migrations: Iterable[tuple[str, str]]) -> None:
    """Raise MigrationSafetyError if any (name, sql) migration is non-additive."""
    problems: list[str] = []
    for name, sql in migrations:
        violations = scan_sql(sql)
        if violations:
            problems.append(f"{name}: {', '.join(violations)}")
    if problems:
        raise MigrationSafetyError(
            "non-additive migration statement(s) detected (CLAUDE.md DB discipline):\n  "
            + "\n  ".join(problems)
        )
    return None

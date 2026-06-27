"""m0007 — UNIQUE(projection_id, seq) backstop on revisions (issue #186).

Additive-only (CLAUDE.md DB discipline / DATA_MODEL §8): a new UNIQUE index, no
DROP/RENAME. ``seq`` integrity previously rested ENTIRELY on the app computing
``seq = if_match + 1`` under the version check — there was no DB constraint, so any
future/buggy ``insert_revision`` path that miscomputed ``seq`` would silently produce
a duplicate or gapped snapshot and corrupt the restore/audit trail with no signal.

This index makes a duplicate ``(projection_id, seq)`` fail LOUDLY with an
``IntegrityError`` instead. It pairs with the single-transaction
``update_with_version_check_and_revision`` write path (also #186) so a version bump
can never land without its matching snapshot.

``IF NOT EXISTS`` keeps the migration idempotent. A healthy DB has no duplicate
``(projection_id, seq)`` (the app has always computed seq from the version check), so
the index builds cleanly; OPS_RUNBOOK §8.2 documents the de-dup pre-check for the
(not-expected) case of a legacy DB that already holds a duplicate.
"""

SQL = """
CREATE UNIQUE INDEX IF NOT EXISTS idx_revisions_projection_seq
  ON revisions(projection_id, seq);
"""

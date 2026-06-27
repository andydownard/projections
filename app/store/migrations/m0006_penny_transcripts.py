"""m0006 — penny_transcripts (per-project Penny conversation) + revision actor enum.

Spec B §7/§12 (issue #121). Additive-only (CLAUDE.md DB discipline / DATA_MODEL §8):

- ``CREATE TABLE IF NOT EXISTS penny_transcripts`` — one persisted transcript per
  saved projection. ``projection_id`` is a NULLable FK: ephemeral wizard-draft
  transcripts have no projection and are **never persisted** (Spec §7), so the
  column must permit NULL rather than force a row to exist. ``turns_json`` carries
  the ordered list of turns ``{role, content, tool_name?, tool_args?,
  tool_result_ref?, revision_id?, provider?, ts}`` as opaque TEXT (the app
  (de)serializes — no JSON1 above the Store interface, Postgres path stays
  drop-in).
- ``ALTER TABLE revisions ADD COLUMN actor`` — attributes each revision to its
  author: ``user | penny | penny_undo | user_undo`` (Spec §3/§4 audit trail). NOT
  NULL DEFAULT ``'user'`` backfills legacy revisions as user-authored. The enum is
  app-enforced (SQLite has no native enum); the Postgres DDL adds the same column.

NEVER DROP/RENAME — ``CREATE TABLE IF NOT EXISTS`` + ``ALTER TABLE ADD COLUMN``
only. Idempotent: re-running is a no-op (the migration ledger skips applied names).
"""

SQL = """
CREATE TABLE IF NOT EXISTS penny_transcripts (
  id TEXT PRIMARY KEY,
  projection_id TEXT REFERENCES projections(id),
  turns_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_penny_transcripts_projection
  ON penny_transcripts(projection_id);

ALTER TABLE revisions ADD COLUMN actor TEXT NOT NULL DEFAULT 'user';
"""

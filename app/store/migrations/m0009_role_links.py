"""m0009 — first-class role_links table for indexed resolution (issue #180).

Additive-only (CLAUDE.md DB discipline / DATA_MODEL §8): a new table + index, no
DROP/RENAME. Role-share link resolution previously scanned the whole projections
table with a leading-wildcard ``role_tokens_json LIKE '%"<slug>"%'`` — unindexed,
O(table-size) per UNAUTHENTICATED ``/api/r/{slug}`` request, and non-portable to
Postgres jsonb. This table makes resolution an O(1) exact-match on the slug PK,
identical on Postgres.

- ``role_links`` — one row per role-share link: ``slug`` (PRIMARY KEY, the plaintext
  read-only lookup capability, like ``view_slug``), ``projection_id`` (FK),
  ``role_name`` (board|funder|advisor), ``token_hash`` (SHA-256(slug), the documented
  §6 hashed-at-rest companion), ``created_at``. The slug PK is the UNIQUE exact-match
  index; ``idx_role_links_projection`` backs the per-projection cascade (purge, #202).

``SqliteStore`` keeps this table in sync from ``role_tokens_json`` on every projection
write and runs a ONE-TIME backfill (``_backfill_role_links``) on the boot that applies
this migration. NEVER DROP/RENAME — ``CREATE TABLE/INDEX IF NOT EXISTS`` only.
"""

SQL = """
CREATE TABLE IF NOT EXISTS role_links (
  slug          TEXT PRIMARY KEY,
  projection_id TEXT NOT NULL REFERENCES projections(id),
  role_name     TEXT NOT NULL,
  token_hash    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_role_links_projection ON role_links(projection_id);
"""

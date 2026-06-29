"""m0014 — share_grants: editable shares that FOLLOW a Clerk account (epic #323).

Additive-only (CLAUDE.md DB discipline / DATA_MODEL §8): a new table + indexes, no
DROP/RENAME. Owner decision (#323): shared *edit* access follows the recipient's
Clerk account, not a per-device capability token. A ``share_grant`` is created ONLY
when a signed-in Clerk user presents a VALID edit token for a specific projection
(``POST /api/projections/{slug}/claim-share``); from then on that projection appears
in the recipient's "Shared with me" list and they may edit it via their Clerk JWT on
ANY device — no edit token in localStorage required.

- ``share_grants`` — one row per (projection, grantee) editable grant:
  - ``id`` — app-generated string PK (no DB autoincrement; Postgres-portable).
  - ``projection_id`` — FK to ``projections(id)`` (no ON DELETE CASCADE; the hard
    purge erases children explicitly, §5.4 / #202 — this table is added to that
    cascade list).
  - ``role`` — the granted role; ``'editor'`` in v1 (the only shared-write role).
  - ``grantee_clerk_user_id`` — the Clerk ``sub`` the grant follows (v1 key).
  - ``grantee_owner_token_hash`` — reserved (nullable) for a future token-keyed grant
    (a viewer who has not signed in); NULL in v1.
  - ``created_at`` — ISO-8601 UTC TEXT (DATA_MODEL §2: timestamps are TEXT, set by
    the app, never a DB default — Postgres parity).
  - ``UNIQUE(projection_id, grantee_clerk_user_id)`` — one grant per (projection,
    grantee), the idempotency backstop behind the claim-share INSERT-or-ignore.

``idx_share_grants_grantee`` backs the owner-scoped "Shared with me" list
(``list_shared_card_summaries_by_clerk_owner``); ``idx_share_grants_projection``
backs the per-projection cascade erased by the hard purge (§5.4, #202).

NEVER DROP/RENAME — ``CREATE TABLE/INDEX IF NOT EXISTS`` only.
"""

SQL = """
CREATE TABLE IF NOT EXISTS share_grants (
  id                       TEXT PRIMARY KEY,
  projection_id            TEXT NOT NULL REFERENCES projections(id),
  role                     TEXT NOT NULL DEFAULT 'editor',
  grantee_clerk_user_id    TEXT,
  grantee_owner_token_hash TEXT,
  created_at               TEXT NOT NULL,
  UNIQUE(projection_id, grantee_clerk_user_id)
);
CREATE INDEX IF NOT EXISTS idx_share_grants_grantee
  ON share_grants(grantee_clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_share_grants_projection
  ON share_grants(projection_id);
"""

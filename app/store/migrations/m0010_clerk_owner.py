"""m0010 — nullable Clerk-owner columns on projections (Clerk satellite auth).

Additive-only (CLAUDE.md DB discipline / DATA_MODEL §8): two nullable columns and
one index, no DROP/RENAME. projections is a cross-apex Clerk SATELLITE — an owner
may be a capability **token** (today's model, unchanged) OR a verified Clerk
identity (``owner_clerk_user_id`` / ``owner_org_id``). The columns are NULL for the
token-owned rows that exist today, so this migration changes no existing data and is
a pure no-op while ``CLERK_ENABLED`` is off.

- ``owner_clerk_user_id`` — the Clerk ``sub`` (user id) that owns the row; NULL for
  token-owned projections. v1 keys owner scope on this.
- ``owner_org_id`` — the Clerk ``org_id`` when the session is org-scoped; stored now
  so org-scoped lists can ship later without a second migration (plan §12).
- ``idx_projections_clerk_owner`` — backs the owner-scoped ``list_*_by_clerk_owner``
  WHERE + ORDER BY, mirroring the existing token-owner index.

A CLAIM/bridge path (link a legacy token-owned row to a signed-in Clerk identity)
is a deliberate FOLLOW-UP — these columns are the additive foundation it builds on.
NEVER DROP/RENAME — ``ALTER TABLE ADD COLUMN`` / ``CREATE INDEX IF NOT EXISTS`` only.
"""

SQL = """
ALTER TABLE projections ADD COLUMN owner_clerk_user_id TEXT;
ALTER TABLE projections ADD COLUMN owner_org_id TEXT;
CREATE INDEX IF NOT EXISTS idx_projections_clerk_owner
  ON projections(owner_clerk_user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projections_clerk_org
  ON projections(owner_org_id, status, updated_at DESC);
"""

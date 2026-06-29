"""m0012 — one-shot recovery: re-link the orphaned "House of Hope @ Longview, TX"
projection to its owner's verified Clerk identity (B4 / issue #295).

CONTEXT: the create-overwrite data-loss bug (fixed in the v2 Phase-0 deploy) rotated
the owner's localStorage capability token on every create, orphaning earlier
projections — their only access key (the raw owner token) was lost, and
``owner_clerk_user_id`` was NULL, so the owner could no longer list them. The owner
has since signed in with Clerk and CONFIRMED which single row to recover: the
projection named "House of Hope" with the resolved address "Longview, TX, USA"
(``view_slug = aFk_Lm-RhA9hGc2q7-b8mg``). This re-links exactly that row to the
owner's Clerk ``sub``.

SAFE + ADDITIVE (CLAUDE.md DB discipline): a single, narrowly-scoped UPDATE — NOT a
DROP / DELETE / schema change (migration_lint permits UPDATE). Guarantees:
  - matched by the stable, unique ``view_slug`` → touches at most ONE row;
  - ``owner_clerk_user_id IS NULL`` guard → idempotent (a re-run links 0 more) and
    ANTI-clobber (it can NEVER overwrite an already-owned row);
  - on every non-prod DB (local / CI / e2e) the ``view_slug`` does not exist, so it
    matches 0 rows — a pure no-op.
One-shot data fix; append-only. NEVER edit a shipped migration.
"""

SQL = """
UPDATE projections
   SET owner_clerk_user_id = 'user_3DvN53qoUbgMRuDBjKmWT44m3Cf'
 WHERE view_slug = 'aFk_Lm-RhA9hGc2q7-b8mg'
   AND owner_clerk_user_id IS NULL;
"""

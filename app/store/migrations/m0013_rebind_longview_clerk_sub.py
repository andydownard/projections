"""m0013 — one-shot corrective rebind: fix the wrong Clerk sub stamped by m0012 on
the "House of Hope @ Longview, TX" projection (B4 / issue #323).

CONTEXT: migration m0012 recovered the Longview row (view_slug =
'aFk_Lm-RhA9hGc2q7-b8mg') by writing the owner's Clerk sub — but the sub used was
INCORRECT: 'user_3DvN53qoUbgMRuDBjKmWT44m3Cf'. Andy's REAL Clerk sub (owner-confirmed
against the Clerk dashboard) is 'user_3DiaveyeKg7vzXhxVlSCFIDew5V'. Because the list
endpoint scopes by ``owner_clerk_user_id``, the row was invisible to andy after m0012.

SAFE + ADDITIVE (CLAUDE.md DB discipline / DATA_MODEL §8): a single, narrowly-scoped
UPDATE — NOT a DROP / DELETE / schema change (migration_lint permits UPDATE). Guarantees:
  - matched by BOTH the unique ``view_slug`` AND the explicit known-wrong sub → touches
    at most ONE row, and ONLY the row with exactly the wrong value;
  - double-predicate guard → idempotent: a re-run WHERE the sub is already corrected
    matches 0 rows (the AND on the wrong sub fails), so it is a safe no-op;
  - anti-clobber: a row with any other sub (including the correct one) is NEVER touched;
  - on every non-prod DB (local / CI / e2e) the ``view_slug`` does not exist, so it
    matches 0 rows — a pure no-op.
Does NOT touch ``status`` or ``deleted_at`` (already correct, per owner confirmation).
One-shot data fix; append-only. NEVER edit a shipped migration.
"""

_WRONG_SUB = "user_3DvN53qoUbgMRuDBjKmWT44m3Cf"
_CORRECT_SUB = "user_3DiaveyeKg7vzXhxVlSCFIDew5V"
_SLUG = "aFk_Lm-RhA9hGc2q7-b8mg"

SQL = (
    f"UPDATE projections"
    f"   SET owner_clerk_user_id = '{_CORRECT_SUB}'"
    f" WHERE view_slug           = '{_SLUG}'"
    f"   AND owner_clerk_user_id = '{_WRONG_SUB}';"
)

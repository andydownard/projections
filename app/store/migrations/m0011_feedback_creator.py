"""m0011 — nullable creator-identity columns on feedback (Clerk satellite, Epic F).

Additive-only (CLAUDE.md DB discipline / DATA_MODEL §8): four nullable columns, no
DROP/RENAME. When a signed-in Clerk owner files feedback (decisions #6/#13), the
server records WHO filed it for support follow-up, read from the verified Clerk
session-JWT **claims** (NO Clerk Backend API, NO Clerk secret — finding C1). The
columns are NULL for the anonymous / token-owned feedback that exists today, so this
migration changes no existing data and is a pure no-op while ``CLERK_ENABLED`` is off.

- ``creator_email`` / ``creator_name`` / ``creator_phone`` — optional PII from the
  JWT claims (present only when the issuer's JWT template adds them).
- ``creator_clerk_user_id`` — the Clerk ``sub`` of the signed-in filer; NULL for
  anonymous feedback.

These are SERVER-ONLY: they live next to the existing server-only ``feedback.email``
column and, like it, NEVER reach the redacted GitHub issue (``app/feedback/redact.py``
governs the public payload — a CI test asserts ``creator_*`` never reaches the sink).
NEVER DROP/RENAME — ``ALTER TABLE ADD COLUMN`` only.
"""

SQL = """
ALTER TABLE feedback ADD COLUMN creator_email TEXT;
ALTER TABLE feedback ADD COLUMN creator_name TEXT;
ALTER TABLE feedback ADD COLUMN creator_phone TEXT;
ALTER TABLE feedback ADD COLUMN creator_clerk_user_id TEXT;
"""

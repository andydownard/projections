"""m0003 — the `intent` table (M6 customer-intent capture -> CRM).

Additive-only (DATA_MODEL.md §8). Intent is a SEPARATE store from feedback
(IDEA_FAB §0): it may carry an email + explicit consent and routes to a private
CRM, but it has NO financial column and NO projection foreign key (PRD §22).
"""
SQL = """
CREATE TABLE IF NOT EXISTS intent (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT,
  reason TEXT,
  opening_timeline TEXT,
  request_expert_review INTEGER NOT NULL DEFAULT 0,
  follow_up_consent INTEGER NOT NULL DEFAULT 0,
  crm_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intent_created ON intent(created_at DESC);
"""

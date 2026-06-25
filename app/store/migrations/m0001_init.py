"""0001_init — canonical v1 schema (DATA_MODEL.md Appendix A).

Includes the EMPTY actuals table (schema-only in v1, no UI — built so it is never a
later migration) and projections.cohort_json (frozen cohort fingerprint stamped at
create / on settings change — BACKLOG data-network decision). Additive-only.

Written portably: app-generated string PKs, no SQLite-only constructs above the
Store interface. WAL/busy_timeout PRAGMAs are applied by SqliteStore on connect,
not here (they are SqliteStore internals).
"""

SQL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projections (
  id TEXT PRIMARY KEY,
  view_slug TEXT NOT NULL UNIQUE,
  owner_token_hash TEXT NOT NULL,
  edit_token_hash TEXT,
  role_tokens_json TEXT NOT NULL DEFAULT '{}',
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  model_version TEXT NOT NULL,
  compute_schema_version TEXT NOT NULL,
  location_json TEXT NOT NULL DEFAULT '{}',
  trade_area_json TEXT NOT NULL DEFAULT '{}',
  inputs_json TEXT NOT NULL DEFAULT '{}',
  demand_drivers_json TEXT NOT NULL DEFAULT '{}',
  assumptions_json TEXT NOT NULL DEFAULT '{}',
  overrides_json TEXT NOT NULL DEFAULT '{}',
  monthly_json TEXT NOT NULL DEFAULT '{}',
  computed_json TEXT NOT NULL DEFAULT '{}',
  cohort_json TEXT NOT NULL DEFAULT '{}',
  terms_accepted_at TEXT,
  ai_opt_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projections_view_slug ON projections(view_slug);
CREATE INDEX IF NOT EXISTS idx_projections_owner ON projections(owner_token_hash, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projections_edit  ON projections(edit_token_hash);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  projection_id TEXT NOT NULL REFERENCES projections(id),
  seq INTEGER NOT NULL,
  inputs_json TEXT NOT NULL,
  assumptions_json TEXT NOT NULL,
  overrides_json TEXT NOT NULL,
  monthly_json TEXT NOT NULL,
  computed_json TEXT NOT NULL,
  model_version TEXT NOT NULL,
  actor_token_hash TEXT,
  change_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_projection ON revisions(projection_id, seq DESC);

CREATE TABLE IF NOT EXISTS narratives (
  projection_id TEXT PRIMARY KEY REFERENCES projections(id),
  body_md TEXT NOT NULL DEFAULT '',
  edited INTEGER NOT NULL DEFAULT 0,
  computed_hash TEXT,
  provider TEXT,
  model_version TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  projection_id TEXT NOT NULL REFERENCES projections(id),
  field TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT,
  confidence TEXT,
  method TEXT,
  source_url TEXT,
  source_title TEXT,
  source_date TEXT,
  fetch_date TEXT,
  source_tier TEXT,
  file_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_projection ON evidence(projection_id, field);

CREATE TABLE IF NOT EXISTS research_cache (
  cache_key TEXT PRIMARY KEY,
  households INTEGER,
  basis TEXT,
  acs_vintage INTEGER,
  rent_estimate REAL,
  rent_low REAL,
  rent_high REAL,
  rent_type TEXT,
  opex REAL,
  confidence TEXT,
  sources_json TEXT NOT NULL DEFAULT '[]',
  provider TEXT,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_cache_expiry ON research_cache(expires_at);

CREATE TABLE IF NOT EXISTS feedback (
  support_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  email TEXT,
  context_json TEXT NOT NULL DEFAULT '{}',
  github_issue_url TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

-- Post-launch (M7), schema-only in v1 so it is never a later migration. NO UI.
CREATE TABLE IF NOT EXISTS actuals (
  id TEXT PRIMARY KEY,
  projection_id TEXT NOT NULL REFERENCES projections(id),
  month TEXT NOT NULL,
  revenue REAL,
  donations REAL,
  payroll REAL,
  rent REAL,
  other_expense REAL,
  cohort_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(projection_id, month)
);
CREATE INDEX IF NOT EXISTS idx_actuals_projection ON actuals(projection_id, month);
"""

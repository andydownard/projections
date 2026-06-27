# DATA_MODEL.md — Thrift Store Projection web app

**Repo:** `rallytasks/projections` · **Status:** Build spec (not yet built) · **Authority:** PRD §24 (data model), §13/§14 (compute + override), §20/§22 (access + feedback), §26 (storage/ops) · **Stack:** FastAPI + SQLite (WAL) + Litestream on a durable Railway volume.

This document is the canonical schema and data-access contract for the projections app. It pins exact tables, columns, types, indexes, JSON blob shapes, the override-key format, token hashing at rest, WAL config, the data-access-layer interface, the documented Postgres migration path, and example payloads.

**Sibling docs (cross-linked):** [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`BUILD_PLAN.md`](./BUILD_PLAN.md) · [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md) · [`API_SPEC.md`](./API_SPEC.md) · [`SECURITY.md`](./SECURITY.md) · [`OPS_RUNBOOK.md`](./OPS_RUNBOOK.md) · [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md) · [`CONTRIBUTING.md`](./CONTRIBUTING.md) · [`CLAUDE.md`](./CLAUDE.md) · [`AGENTS.md`](./AGENTS.md) · [`IDEA_FAB.md`](./IDEA_FAB.md).

---

## 0. Design principles (read first)

1. **The database stores facts and snapshots; it does not compute.** All math lives in the server-side engine (PRD §13; see [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md)). Persisted compute output (`computed_json`, `monthly_json`) is always stamped with the `model_version` that produced it and is **never silently recomputed** on read.
2. **Application-generated string primary keys (UUID/ULID), not SQLite `rowid`/`AUTOINCREMENT`.** This mirrors timpager's `TEXT PRIMARY KEY` UUID convention (see timpager `SCHEMA.md`) and is the single most important rule for keeping the Postgres migration path (§22 of this doc) a drop-in. No SQLite-only ID strategy may leak above the data-access interface.
3. **No SQLite-isms above the data-access layer.** No `INSERT OR REPLACE`, no `last_insert_rowid()`, no `rowid` reads, no JSON1-function-dependent queries in app code. JSON blobs are opaque `TEXT`; the app serializes/deserializes them, the DB never parses them in a query that must run on Postgres.
4. **Additive-only migrations.** Following timpager's hard rule: NEVER `DROP TABLE`, NEVER `DROP COLUMN`, always `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN` (wrapped to tolerate "column exists"). WAL mode only; never change the journal mode. See §10.
5. **Tokens are hashed at rest; `view_slug` is plaintext (it is a lookup key, not a secret).** SHA-256 over high-entropy random tokens, compared constant-time. See §7.
6. **Optimistic concurrency on every mutation** via the integer `version` column and `If-Match` (§6, §9). Autosave (PRD §19.3) writes a `revisions` snapshot on each debounced settle.

---

## 1. Entity overview

| Table | Cardinality | Purpose | PRD |
|---|---|---|---|
| `projections` | root aggregate | One projection = one workspace. Holds inputs, assumptions, overrides, and the version-locked compute snapshot. | §24 |
| `revisions` | many per projection | Append-only snapshot per autosave settle / explicit save; powers Revisions + restore. | §24, §19.3 |
| `narratives` | 0..1 per projection | Generated, grounded, sanitized prose for the Board Packet; stale-tracked. | §17, §24 |
| `evidence` | many per projection | Per-field source/method/confidence + user attachments. | §15, §24 |
| `research_cache` | global (not owner-scoped) | TTL'd Census + rent-research results keyed by normalized location+size. | §16, §24 |
| `feedback` | global | Redacted bug reports → GitHub issue; **no projection link, no financial fields.** | §22, §24 |
| `actuals` | many per projection | **Post-launch (M7), schema only in v1.** Monthly forecast-vs-actual + opt-in benchmarks. | §6.3, §24 |
| `penny_transcripts` | 0..1 per projection | Persisted per-project Penny conversation (Spec B §7). Wizard-draft transcripts (no projection) are **never** persisted. | Spec B §7 |
| `role_links` | many per projection | Indexed role-share links (board/funder/advisor): slug PK → projection + role, for O(1) exact-match resolution of `/api/r/{slug}` (#180). | §6.2, §20 |
| `schema_migrations` | global | Applied-migration ledger (timpager pattern). | §26 |

```
projections ──1:N── revisions
            ──1:N── evidence
            ──1:1── narratives
            ──1:N── actuals        (post-launch)
            ──1:1── penny_transcripts  (NULL projection_id => never persisted)
            ──1:N── role_links     (slug PK; indexed role-share resolution)
research_cache  (independent, global, TTL)
feedback        (independent, global, no FK to projections)
schema_migrations (global)
```

`research_cache` and `feedback` deliberately have **no foreign key** to `projections`: research is shared cache; feedback redaction (PRD §22) forbids any resolvable projection link reaching GitHub.

---

## 2. Conventions

- **Types** are the SQLite affinities used in the DDL, with the Postgres equivalent in the migration table (§22). SQLite stores JSON blobs as `TEXT`.
- **Timestamps** are stored as ISO-8601 UTC strings (`TEXT`, e.g. `2026-06-24T17:03:11Z`). We do **not** rely on `DATETIME DEFAULT CURRENT_TIMESTAMP` for app rows; the app sets timestamps explicitly so Postgres behaves identically. (timpager uses the DB default; we deviate intentionally for portability.)
- **Primary keys** are app-generated ULIDs (lexicographically sortable, time-ordered) stored as `TEXT`. Generated in app code (`engine`/`app` layer), never by the DB.
- **Booleans** are `INTEGER` (0/1) in SQLite, `BOOLEAN` in Postgres.
- **Money** is **never** stored as a float in compute output. The engine computes in integer **cents** / `Decimal` and rounds only at display (PRD §12.4); `computed_json`/`monthly_json` carry both raw numeric values and pre-formatted display strings (the `{raw, display}` convention — see [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md) and §5.5). The DB stores these blobs verbatim; it does no arithmetic on them.

---

## 3. Tables — DDL and column reference

The DDL below is the v1 SQLite schema. Every `CREATE TABLE` uses `IF NOT EXISTS`; migrations only `ADD COLUMN` (§10).

### 3.1 `projections` (root aggregate)

```sql
CREATE TABLE IF NOT EXISTS projections (
  id                   TEXT PRIMARY KEY,            -- app-generated ULID
  view_slug            TEXT NOT NULL UNIQUE,        -- >=128-bit, PLAINTEXT lookup key
  owner_token_hash     TEXT NOT NULL,               -- SHA-256 of >=256-bit owner bearer token
  edit_token_hash      TEXT,                        -- SHA-256 of edit token (fragment-delivered)
  role_tokens_json     TEXT NOT NULL DEFAULT '{}',  -- {board|funder|advisor: {slug, token_hash}}
  name                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active', -- 'active' | 'trashed'
  version              INTEGER NOT NULL DEFAULT 1,  -- optimistic concurrency
  model_version        TEXT NOT NULL,               -- semver of engine that produced computed_json
  compute_schema_version TEXT NOT NULL,             -- semver of the view-model SHAPE (Appendix D)
  location_json        TEXT NOT NULL DEFAULT '{}',  -- see 4.1
  trade_area_json      TEXT NOT NULL DEFAULT '{}',  -- see 4.2
  inputs_json          TEXT NOT NULL DEFAULT '{}',  -- see 4.3
  demand_drivers_json  TEXT NOT NULL DEFAULT '{}',  -- see 4.4
  assumptions_json     TEXT NOT NULL DEFAULT '{}',  -- see 4.5
  overrides_json       TEXT NOT NULL DEFAULT '{}',  -- see 4.6, keyed "{node}#{year}"
  monthly_json         TEXT NOT NULL DEFAULT '{}',  -- see 4.7 (M0..M12 cash-flow)
  computed_json        TEXT NOT NULL DEFAULT '{}',  -- see 4.8 (resolved P&L + KPIs + decision + flags)
  cohort_json          TEXT NOT NULL DEFAULT '{}',  -- 0001: frozen cohort fingerprint (BACKLOG data-network)
  terms_accepted_at    TEXT,                        -- terms gate before export/share (§21)
  ai_opt_out           INTEGER NOT NULL DEFAULT 0,  -- 1 = no AI calls (§21)
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  deleted_at           TEXT,                        -- legacy soft-delete marker; the hard purge (§5.4) DELETEs the row outright
  -- 0005: timed cost schedule + opening anchor (Spec §5/§7); canonical copy lives in inputs_json (§4.3).
  target_opening_date  TEXT,                        -- ISO month/date of grand opening
  opening_month_number INTEGER NOT NULL DEFAULT 1,  -- project month (>=1) opening lands on (frozen literal DEFAULT)
  cost_schedule_json   TEXT NOT NULL DEFAULT '[...]', -- [{category,month,amount}]; frozen month-1 lump (see 0005, #187)
  -- 0008: compact owner-list card summary, denormalized from computed_json at write time (#178).
  summary_json         TEXT NOT NULL DEFAULT '{}'   -- {location,basis,y1_revenue,y1_net,capital_required,reco_tag,coords}
);
```

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | ULID, app-generated. |
| `view_slug` | TEXT UNIQUE | ≥128-bit URL-safe token, **stored plaintext** because it is the read lookup key (PRD §20, §24). Generated `secrets.token_urlsafe(16)`. Not a secret on its own — read-only access. |
| `owner_token_hash` | TEXT | SHA-256 hex of the owner bearer token (≥256-bit, `secrets.token_urlsafe(32)`). The raw token lives only in the client `localStorage` (§7). |
| `edit_token_hash` | TEXT, nullable | SHA-256 of the edit token. Raw token is delivered via URL **fragment** only, never path/query, never logged (PRD §20). Null until an edit link is minted. |
| `role_tokens_json` | TEXT | JSON map of role-share links (each a read-only capability link with role-emphasis, PRD §6.2), rotated atomically with owner/edit (§7.4). **Canonical role-link storage + resolution moved to the indexed `role_links` table (§3.10, #180); this column is a denormalized mirror kept in sync on every write.** The store's sync parser tolerates BOTH the documented `{ role_name: {slug, token_hash} }` shape and the legacy shipped `{ slug: role_name }` shape. |
| `name` | TEXT | Display name. |
| `status` | TEXT | `active` \| `trashed`. Trash with restore (PRD §19.1). |
| `version` | INTEGER | Monotonic per-projection. Every mutation does `SET version = version + 1 ... WHERE id=? AND version=?`; 0 rows → HTTP 409 (§6). |
| `model_version` | TEXT | Semver of the math engine (e.g. `2.0.0`) that produced `computed_json`/`monthly_json`. On read, if it differs from the current engine, return the stored snapshot verbatim + an "upgrade available" flag — **never recompute silently** (PRD §13). |
| `compute_schema_version` | TEXT | Semver of the **view-model shape** (Appendix D field names / `{raw,display}` convention). Tracked separately from `model_version` so a renderer/shape change is not mistaken for a math change. See [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md). |
| `location_json` | TEXT | §4.1. |
| `trade_area_json` | TEXT | §4.2 — basis (city/county/manual), geography, households, ACS vintage. |
| `inputs_json` | TEXT | §4.3 — opening, lease/rent type, **explicit `share_y1`/`share_y2`/`share_y3`**, source-of-funds, etc. |
| `demand_drivers_json` | TEXT | §4.4 — confidence inputs (PRD §9). |
| `assumptions_json` | TEXT | §4.5 — cost-structure %s + defaults the user can edit on the Settings tab (PRD §7.3). |
| `overrides_json` | TEXT | §4.6 — pins keyed `"{node}#{year}"` → `{value, note, ts}` (PRD §14, §24). |
| `monthly_json` | TEXT | §4.7 — M0..M12 monthly cash-flow (PRD §10). |
| `computed_json` | TEXT | §4.8 — resolved 3-year P&L + KPIs + decision metrics + `flags` map (PRD §12.4). |
| `terms_accepted_at` | TEXT, nullable | Timestamp of terms acceptance; export/share gated until set (PRD §21). |
| `ai_opt_out` | INTEGER | 1 → app computes/saves/exports `.xlsx` with zero AI calls (PRD §21). |
| `created_at` / `updated_at` | TEXT | App-set ISO-8601 UTC. |
| `deleted_at` | TEXT, nullable | **Legacy** soft-delete marker (`status='trashed'` is the user-visible soft delete). The hard purge now **DELETEs the row outright** + cascades (§5.4, #202); reads still filter `deleted_at IS NULL` to exclude any legacy soft-deleted rows. |
| `summary_json` | TEXT | **0008 (#178).** Compact owner-list card summary `{location, basis, y1_revenue, y1_net, capital_required, reco_tag, coords}`, denormalized from `computed_json` at write time. `list_card_summaries` SELECTs only this + the small identity columns so the owner list never `SELECT *` + parses the full ~10KB `computed_json` per row. See §4.10. |

**Indexes:**
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_projections_view_slug   ON projections(view_slug);
CREATE INDEX        IF NOT EXISTS idx_projections_owner        ON projections(owner_token_hash, status, updated_at DESC);
CREATE INDEX        IF NOT EXISTS idx_projections_edit         ON projections(edit_token_hash);
```
The owner index backs the **owner-scoped list** (`GET /api/projections`) — there is **no global index of projections** (PRD §20). The list query is always `WHERE owner_token_hash = ? AND status = 'active' AND deleted_at IS NULL ORDER BY updated_at DESC`, and (since #178) selects **only** `view_slug, name, status, version, updated_at, summary_json` — never the heavy JSON blobs.

### 3.2 `revisions` (append-only snapshots)

```sql
CREATE TABLE IF NOT EXISTS revisions (
  id               TEXT PRIMARY KEY,            -- ULID
  projection_id    TEXT NOT NULL,
  seq              INTEGER NOT NULL,            -- the projections.version this snapshot represents
  inputs_json      TEXT NOT NULL,                -- recoverable inputs (read by restore)
  assumptions_json TEXT NOT NULL,                -- recoverable inputs (read by restore)
  overrides_json   TEXT NOT NULL,                -- recoverable inputs (read by restore)
  monthly_json     TEXT NOT NULL,                -- 0009/#179: stored '{}' — recomputable, never read back
  computed_json    TEXT NOT NULL,                -- 0009/#179: stored '{}' — recomputable, never read back
  model_version    TEXT NOT NULL,
  actor_token_hash TEXT,                        -- which token made the change (forensics)
  actor            TEXT NOT NULL DEFAULT 'user', -- author class: user|penny|penny_undo|user_undo (Spec B §3/§4)
  change_summary   TEXT NOT NULL DEFAULT '',    -- e.g. "edited labor %", "pinned Payroll#2"
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_projection ON revisions(projection_id, seq DESC);
-- 0007: UNIQUE(projection_id, seq) backstop so a miscomputed/duplicate seq fails
-- loudly (IntegrityError) instead of silently corrupting the restore/audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS idx_revisions_projection_seq ON revisions(projection_id, seq);
```

A snapshot is written **per autosave settle** and per explicit save / model upgrade / restore (PRD §19.3, §24). **It stores the recoverable inputs only — `inputs_json` / `assumptions_json` / `overrides_json` / `model_version` + metadata.** The compute snapshot (`computed_json`, `monthly_json`) is **NOT persisted** in a revision (`strip_recomputable` blanks it to `'{}'` before insert, #179): restore recomputes the view-model from the inputs and **never reads `rev['computed_json']`**, and `list_revisions` returns metadata only — so storing the full ~10KB blob per revision was pure durable-volume + Litestream write-amplification with no reader. The columns remain `NOT NULL` (additive-only; never dropped) and simply hold `'{}'`. `actor_token_hash` records which capability token authored the change (audit/forensics, PRD §20). The **`actor` enum** (`user | penny | penny_undo | user_undo`, added in migration `0006`, default `'user'`) attributes each revision to its author class so the audit trail distinguishes a Penny edit, a per-field undo, and a manual edit (Spec B §3/§4); it is app-enforced (SQLite has no native enum) and carries to Postgres as the same column. Restore (`POST …/revisions/{id}/restore`) writes a **new** revision rather than rewinding in place. `model_version` is captured so a restored snapshot is never silently recomputed.

**Atomic version bump + snapshot (issue #186).** The version-checked UPDATE and its revision snapshot are written in **one transaction** via `update_with_version_check_and_revision` (§9): 0 rows → HTTP 409 and **no** revision is written; otherwise the `projections.version++` and the matching `revisions` row commit together. This closes the crash window where a separate `version++` commit landed but the snapshot commit did not — a version with no recoverable snapshot, a silent hole in the restore/audit trail. The additive **`UNIQUE(projection_id, seq)`** index (migration `0007`) is the DB-level backstop: `seq` integrity no longer rests solely on the app computing `seq = if_match + 1` — a duplicate fails loudly rather than corrupting the list.

> **Retention (#179, `app/store/revision_retention.py`).** Autosave produces heavy append volume on a single projection, so growth is now **bounded**: on each insert the store prunes the oldest revisions beyond `MAX_REVISIONS_PER_PROJECTION` (100) **except protected ones** — any revision whose `change_summary` marks a **model upgrade** (the pre-upgrade restore point, §5.3) or a **token rotation** (security audit, §6.1) is never pruned, so the restore/audit contract survives compaction. The cap is applied above the Store interface so SQLite and Postgres behave identically. Combined with dropping the unread compute snapshot (above), per-projection revision storage is bounded in both count and per-row size.

### 3.3 `narratives` (grounded prose, 0..1 per projection)

```sql
CREATE TABLE IF NOT EXISTS narratives (
  projection_id  TEXT PRIMARY KEY,             -- 1:1 with projection
  body_md        TEXT NOT NULL DEFAULT '',     -- sanitized markdown (server-side allowlist)
  edited         INTEGER NOT NULL DEFAULT 0,   -- 1 = user has hand-edited; never auto-overwrite
  computed_hash  TEXT,                          -- hash of computed_json at generation (stale detect)
  provider       TEXT,                          -- 'anthropic' | 'openai' | 'template' (actual provider used)
  model_version  TEXT,                          -- engine version the facts came from
  edit_origin    TEXT,                          -- 'ai' | 'human' | NULL — how the stored prose was last produced (m0004)
  updated_at     TEXT NOT NULL
);
```

| Column | Notes |
|---|---|
| `body_md` | **Server-side sanitized** (allowlist; e.g. `bleach`) before storage AND before render. This is the primary stored-XSS → token-theft vector given bearer tokens in `localStorage` (PRD §20, SECURITY lens). |
| `edited` | If 1, regeneration must not silently overwrite user prose (PRD §17). UI shows "Out of date" + diff + Regenerate. |
| `computed_hash` | Stable hash of the `computed_json` facts at generation time. If the live hash differs, the narrative is **stale** (PRD §17). |
| `provider` | Records which provider generated the prose (Anthropic primary → OpenAI fallback; `template` when no provider key is configured). Reflects the **actual** provider used (epic-N N6). |
| `edit_origin` | `ai` (regenerated from `computed_json`) \| `human` (hand-edited via `PUT`) \| NULL (none yet). Drives the confirm-before-discard regenerate gate (N6) and the client's "edited by you" badge (epic-N N4, migration m0004). |

**Grounding invariant (enforced in the service, see [`SECURITY.md`](./SECURITY.md)):** every numeric figure in `body_md` must exist in `computed_json`/approved facts; ungrounded figures are rejected at generation, not stored.

### 3.4 `evidence` (per-field sources + attachments)

```sql
CREATE TABLE IF NOT EXISTS evidence (
  id            TEXT PRIMARY KEY,              -- ULID
  projection_id TEXT NOT NULL,
  field         TEXT NOT NULL,                 -- 'rent' | 'households' | 'payroll' | 'donation_value' | ...
  kind          TEXT NOT NULL,                 -- 'researched' | 'user-attached'
  value         TEXT,                          -- the asserted value (string; numeric meaning in computed_json)
  confidence    TEXT,                          -- 'verified' | 'estimated' | 'estimated-low' | 'assumption'
  method        TEXT,                          -- how it was derived (e.g. 'ACS 5-yr', 'broker quote')
  source_url    TEXT,
  source_title  TEXT,
  source_date   TEXT,                          -- date the source asserts (e.g. listing date)
  fetch_date    TEXT,                          -- when the server fetched it
  source_tier   TEXT,                          -- 'broker'|'listing'|'aggregator'|'news'|'gov'|'unknown'
  file_ref      TEXT,                          -- opaque storage ref for user attachments (off-origin)
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_projection ON evidence(projection_id, field);
```

Drives the Evidence & assumptions panel and the verified-vs-estimated visual separation (PRD §15). Attaching user evidence can promote an estimate to `verified` (user-provided) and raise confidence. `file_ref` points at off-origin object storage; uploads are type/size-limited and served with `Content-Disposition` + non-executable content-type (see [`SECURITY.md`](./SECURITY.md) — file-upload hardening). `confidence` badge values map to the frontend's evidence badge enum (Appendix D `evidence[].badge`).

### 3.5 `research_cache` (TTL'd, global)

```sql
CREATE TABLE IF NOT EXISTS research_cache (
  cache_key     TEXT PRIMARY KEY,              -- normalized location+size key (see below)
  households    INTEGER,
  basis         TEXT,                          -- 'city' | 'county' (manual is never cached)
  acs_vintage   INTEGER,                       -- e.g. 2023
  rent_estimate REAL,
  rent_low      REAL,
  rent_high     REAL,
  rent_type     TEXT,                          -- 'gross' | 'nnn'
  opex          REAL,                          -- NNN opex add (per sqft or annual; documented in sources_json)
  confidence    TEXT,                          -- 'high' | 'medium' | 'low' | 'benchmark-fallback'
  sources_json  TEXT NOT NULL DEFAULT '[]',    -- [{url,title,fetch_date,source_date,source_tier,extracted_text}]
  provider      TEXT,                          -- which research provider/model produced the extract
  fetched_at    TEXT NOT NULL,                 -- TTL anchor
  expires_at    TEXT NOT NULL                  -- fetched_at + TTL
);
CREATE INDEX IF NOT EXISTS idx_research_cache_expiry ON research_cache(expires_at);
```

`cache_key` is the **normalized** location + building-size key (PRD §16.6), e.g. `place:4843888|sqft_bucket:10000-12499|basis:city|acs:2023`. Lowercased, whitespace-collapsed, place_id-anchored where available. Manual re-research bypasses the cache (writes a fresh entry); the manual trade-area basis is never cached (it is user-entered). `sources_json` carries the retrieval layer's stored snippets so the LLM extract is auditable and **no citation can appear that was not server-fetched** (PRD §16; SECURITY lens). SSRF-blocked fetches never produce a cache row (see [`SECURITY.md`](./SECURITY.md)).

### 3.6 `feedback` (redacted → GitHub; no projection link)

```sql
CREATE TABLE IF NOT EXISTS feedback (
  support_id       TEXT PRIMARY KEY,           -- random, user-facing (e.g. 'SUP-7F3K9Q')
  type             TEXT NOT NULL,              -- 'bug' | 'idea' | ...
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  email            TEXT,                       -- optional
  context_json     TEXT NOT NULL DEFAULT '{}', -- NON-SENSITIVE ONLY: {route, app_version, model_version, ts}
  github_issue_url TEXT,
  status           TEXT NOT NULL DEFAULT 'open',
  created_at       TEXT NOT NULL
);
```

**Hard rules (PRD §22, the product's top data-leak risk):**
- **No `projection_id`, no `view_slug`, no edit/role token, no resolvable projection link** ever stored here or in the GitHub payload. There is intentionally **no foreign key** to `projections`.
- **No financial fields** in `body` or `context_json`. UI notice: "Don't paste sensitive financial details."
- `context_json` is non-sensitive only: route, app version, `model_version`, support ID, timestamp.
- `support_id` is a random user-facing code; only **server-side staff tooling** resolves it to a projection (the mapping is not in this table — it lives in staff-only audit logs, see [`SECURITY.md`](./SECURITY.md)). Safe even if the repo is public.

A CI test asserts the GitHub payload contains none of the forbidden fields (see [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md), feedback-redaction test). See [`IDEA_FAB.md`](./IDEA_FAB.md) for the bug/idea → GitHub flow and intent → CRM split.

### 3.7 `actuals` (post-launch — schema only in v1)

```sql
CREATE TABLE IF NOT EXISTS actuals (
  id             TEXT PRIMARY KEY,             -- ULID
  projection_id  TEXT NOT NULL,
  month          TEXT NOT NULL,                -- 'YYYY-MM' operating month
  revenue        REAL,
  donations      REAL,
  payroll        REAL,
  rent           REAL,
  other_expense  REAL,
  created_at     TEXT NOT NULL,
  UNIQUE(projection_id, month)
);
CREATE INDEX IF NOT EXISTS idx_actuals_projection ON actuals(projection_id, month);
```

**Built in M7 / post-launch (PRD §6.3, §28).** The table ships in v1 so it is not a later migration, but **no UI is built in v1** (product lens: "ship the actuals table schema so it is not a migration later, but build no UI"). Powers forecast-vs-actual and opt-in anonymized benchmarks.

### 3.8 `schema_migrations`

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,                 -- migration identifier, e.g. '0001_init'
  applied_at TEXT NOT NULL
);
```

Mirrors timpager's applied-migration ledger (timpager `SCHEMA.md`). Migrations run **before** any other statement on boot (§10). Each pending migration's DDL and its `schema_migrations` INSERT commit in **one transaction** (atomic), and every `ALTER ADD COLUMN` re-run is a no-op (idempotent), so an interrupted apply recovers on the next boot rather than crash-looping (§8, issue #185).

### 3.9 `penny_transcripts` (per-project Penny conversation — Spec B §7)

```sql
CREATE TABLE IF NOT EXISTS penny_transcripts (
  id            TEXT PRIMARY KEY,                          -- ULID
  projection_id TEXT REFERENCES projections(id),           -- NULLable: wizard drafts are NEVER persisted
  turns_json    TEXT NOT NULL DEFAULT '[]',                -- ordered list of turn objects (§4.9)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_penny_transcripts_projection ON penny_transcripts(projection_id);
```

Added in migration `0006_penny_transcripts`. One persisted transcript per **saved** projection; the **edit/detail-page** conversation. `projection_id` is a **NULLable** FK by design: a Penny **wizard-draft** conversation has no projection yet, lives only in client state, and is **never written** (Spec B §7) — the Store seam (`create_transcript` / `append_transcript_turn`) **fails closed** (`ValueError`) on a missing/NULL `projection_id` so an ephemeral draft can never be persisted. Owner scoping is enforced at the router: `GET /api/projections/{view_slug}/penny/transcript` resolves the slug under the owner/edit Bearer, then keys on the resolved `projection_id` (no cross-owner read). `turns_json` is opaque `TEXT` ((de)serialized by the app — no JSON1 above the Store interface). **Retention/size cap** (Spec B §7) is applied above the interface on every append (`app/store/penny_retention.py`): keep the most-recent `MAX_TURNS` (200) turns, and truncate the heavy machine payload (`tool_args`, `tool_result_ref`) of `tool` turns older than the most-recent `TOOL_PAYLOAD_RETENTION` (40) window while keeping each turn's human-readable `content` summary. No financial leakage beyond what the projection already holds for that owner.

The **seven-tool surface** (`app/penny/tools.py`, PE4) that drives mutations is registered into the bounded tool-use loop: every mutate tool converges on the shared `apply_projection_patch` service (the same PATCH/`If-Match` write path the manual UI uses), so each applied Penny edit bumps `version` and writes **one revision tagged `actor='penny'`** (§3.2). The **POST endpoint** (`POST …/penny`) that wires the loop to HTTP and appends transcript turns is a later slice (PE5); v1 of this table ships the data model + owner-scoped read seam only.

### 3.10 `role_links` (indexed role-share resolution — #180)

```sql
CREATE TABLE IF NOT EXISTS role_links (
  slug          TEXT PRIMARY KEY,                          -- plaintext role-share lookup key (like view_slug)
  projection_id TEXT NOT NULL REFERENCES projections(id),
  role_name     TEXT NOT NULL,                             -- board | funder | advisor
  token_hash    TEXT,                                      -- SHA-256(slug): documented hashed-at-rest companion (§6)
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_role_links_projection ON role_links(projection_id);
```

Added in migration `0009_role_links`. This is the **canonical, indexed home** for role-share links and the realization of the documented `{ role_name, slug, token_hash }` shape (§3.1) as a relational table. It replaces the previous resolver, which scanned the whole `projections` table with a leading-wildcard `role_tokens_json LIKE '%"<slug>"%'` — **unindexed, O(table-size) per UNAUTHENTICATED `/api/r/{slug}` request, and non-portable to Postgres `jsonb`** (#180). Resolution (`get_projection_by_role_slug`) is now an **O(1) exact match** on the `slug` primary key joined to the live projection (`deleted_at IS NULL`), identical on Postgres.

- **slug is plaintext** — it is a read-only lookup capability exactly analogous to `view_slug` (§6), delivered in the `/api/r/{slug}` path and stored as the indexed PK. `token_hash = SHA-256(slug)` is also stored as the §6 hashed-at-rest companion (decision: **plaintext lookup key + hashed companion**, resolving the §3.1 / §6 ambiguity for role slugs).
- **Kept in sync from `role_tokens_json`.** `SqliteStore` rebuilds a projection's `role_links` rows on every write that carries `role_tokens_json` (`create_projection`, `rotate_tokens` — in the **same transaction** as the rotation, so an old role slug stops resolving the moment it rotates), via the tolerant `parse_role_tokens` (both the documented and legacy shapes). A one-time `_backfill_role_links` populates existing rows on the boot that applies `0009`.
- The `idx_role_links_projection` index backs the per-projection cascade erased by the hard purge (§5.4, #202).

---

## 4. JSON blob shapes

These are the contracts for the opaque `TEXT` JSON columns. The DB treats them as strings; the engine and API layer own the shapes. Field names align with PRD §24 and the Appendix D view-model contract.

### 4.1 `location_json`
```json
{ "query": "Longview, Texas", "place_id": "ChIJ…", "lat": 32.5007, "lng": -94.7405,
  "place_name": "Longview", "county_name": "Gregg County", "state": "TX" }
```

### 4.2 `trade_area_json`
```json
{ "basis": "city", "geography": "Longview city, TX",
  "households": 31798, "acs_vintage": 2023,
  "households_source": "census_api", "editable": true }
```
`basis ∈ {city, county, manual}` (v1 locked; radius/ZCTA deferred, PRD §8). The household count is always editable; a manual edit sets `households_source: "manual"`.

### 4.3 `inputs_json`
```json
{
  "opening": "2027-03",
  "opening_status": "pre_launch",
  "building_sqft": 10000,
  "salesfloor_pct": 0.70,
  "lease_type": "nnn",
  "donation_value": 74,
  "demand": { "mode": "market_share", "share_y1": 0.06, "share_y2": 0.08, "share_y3": 0.10 },
  "source_of_funds": { "cash": 150000, "grant": 50000, "loan": 0, "campaign": 0 },
  "opening_month_number": 5,
  "cost_schedule": [
    { "category": "Build-out / Renovations", "month": 2, "amount": 50000,
      "provenance": { "source": "ai", "turn_id": "pt_…#7", "created_at": "2026-06-27T00:00:00Z" } },
    { "category": "Equipment & Fixtures", "month": 4, "amount": 45000 }
  ]
}
```
**`share_y1`, `share_y2`, `share_y3` are three explicit inputs (PRD §7.1).** The legacy engine's Year-2 = midpoint rule (`generate_projection.py:65`, `methodology.md` lines 17–18) is **superseded** — there is no derived midpoint anywhere in v1. The wizard's "even ramp" helper may *pre-fill* `share_y2` but all three persist as explicit values. `mode` may also be `donations_per_week` (the app converts to share).

**Timed cost schedule + opening anchor (Spec A §5; added in migration `0005`).** `opening_month_number` (`≥ 1`) is the project month grand opening lands on; `cost_schedule` is the list of timed startup rows `{category, month (≥ 1), amount (≥ 0)}`. The canonical copy lives here in `inputs_json`; first-class columns (`cost_schedule_json`, `opening_month_number`, `target_opening_date`) mirror it for queryability. A row MAY carry an optional **`provenance`** object attributing how it was created: Penny stamps `{ "source": "ai", "turn_id", "created_at" }` on each row she builds from a consultant proposal (Spec B §6.2/§9 `edit_cost_schedule`). `provenance` is **opaque audit/UI metadata** — it never feeds the engine (`cost_schedule` is filtered out of the engine args) and is validated as `{ source, … }` (an object) alongside the `{category, month, amount}` shape; manually-created rows simply omit it. Server validation (`month ≥ 1`, `amount ≥ 0`, `opening_month_number ≥ 1`) is enforced on every create/PATCH so the client never relies on client math. The array is also **COUNT-capped at `MAX_COST_SCHEDULE_ROWS = 200`** rows (generous vs. the ~10-30 rows a real launch carries) — because the schedule is serialized into `inputs_json`/`cost_schedule_json` **and** snapshotted into a fresh revision on every save, an unbounded array is a blob / revision-bloat DoS (issue #166). The cap is enforced server-side on the manual PATCH (`_validate_schedule_inputs`) **and** after Penny's `edit_cost_schedule` ops; an over-cap array is rejected with **422 `invalid_inputs`** ([`SECURITY.md`](./SECURITY.md) §9).

### 4.4 `demand_drivers_json`
```json
{ "competition": "low", "drive_time": "short", "dropoff_convenience": "good",
  "pickup_service": true, "visibility": "high", "hours": "extended",
  "income_proxy": "median", "marketing_plan": "launch + ongoing", "seasonality": "default_scurve" }
```
Drivers adjust **confidence** (and seasonality feeds the monthly ramp), not the v1 point estimate (PRD §9). Quick mode (no drivers) is allowed but labeled lower confidence.

### 4.5 `assumptions_json` (cost structure — Settings tab; PRD §7.3)
```json
{
  "labor_pct": 0.40,
  "marketing_pct": 0.0375,
  "supplies_pct": 0.05,
  "card_pct": 0.02,
  "payroll_tax_pct": 0.075,
  "salvage_pct": 0.008,
  "escalator": 0.03,
  "donations_per_hh": 3,
  "basket": 17.08,
  "reserve_buffer": 25000,
  "occupancy_annual": 90000,
  "rent_per_sqft": null,
  "ramp": { "shape": "scurve", "months": 5 },
  "fixed": {
    "Insurance liability": 2000, "Internet, Phones": 3000, "Pest control": 300,
    "Repairs/maintenance": 1600, "Security system": 900, "Utilities/trash service": 22300
  },
  "startup": {
    "Thrift Store Consultant": 100000, "Equipment & Fixtures": 45000,
    "Build-out / Renovations / Tenant Improvements": 50000,
    "Legal, Permits, Insurance Setup, Signage": 13500
  }
}
```

> **Resolved defaults (closes PRD §7.3 open items; authoritative in [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md)).** These constants are reproduced here only so the persisted blob is self-documenting; the engine doc is the single source of truth.

| Driver | v1 default | Note |
|---|---|---|
| Donations / household / yr | `3` | demand engine (`methodology.md` line 11). |
| Average basket value | `$17.08` | chosen to reproduce the Appendix D prototype (`~$426,911` Y1 / break-even ~month 5). |
| **Labor (payroll) % of revenue** | `0.40` | **Resolved to 40%** to match the design's headline numbers; slider editable. Replaces the legacy `DEFAULTS["labor_pct"]=0.60` and `methodology.md` line 27. |
| **Marketing & outreach % of revenue** | `0.0375` | **New line** introduced by the design (`marketing = total_rev × 0.0375`). |
| **Supplies & processing % of revenue** | `0.05` | **Reclassifies** the legacy fixed `Store/office supplies $3,700` into a % of revenue. The fixed supplies line is removed from `fixed`. |
| Credit-card fees % of revenue | `0.02` | unchanged. |
| Payroll tax % of payroll | `0.075` | unchanged. |
| Salvage % of retail | `0.008` | unchanged. |
| **Annual rent escalator** | `0.03` | **New** — compounding: `rent[y] = rent_y1 × (1 + escalator)^(y-1)` for `y ∈ {1,2,3}`. Applies Y2–Y3. |
| Cash reserve buffer | `$25,000` | feeds startup-capital-required (PRD §12.1). |

Occupancy may be entered as an annual dollar amount (`occupancy_annual`, prototype ~$90,000) **or** derived from `building_sqft × rent_per_sqft` (set `occupancy_annual: null` and supply `rent_per_sqft`). The `lease_type` (gross/nnn) toggle and the escalator both apply. Remaining fixed lines and startup lines persist in `fixed`/`startup`. Note `Store/office supplies` is **absent** from `fixed` in v1 (it became a % line).

### 4.6 `overrides_json` (pins on the DAG; PRD §14, §24)

Keyed `"{node}#{year}"` → `{value, note, ts}`:
```json
{
  "Payroll#2":  { "value": 250000, "note": "signed 2 hires", "ts": "2026-06-24T17:03:11Z" },
  "Rent#1":     { "value": 92000,  "note": "broker quote",   "ts": "2026-06-24T17:05:02Z" }
}
```
- **Key format:** `node` is a stable node id from the DAG (PRD §14); `year ∈ {1,2,3}` for annual rows. The format is exactly `"{node}#{year}"` (PRD §24). Monthly pins, if ever added, would extend the key space — out of v1 scope.
- **Pinnable nodes:** only **input/component expense rows** (e.g. `Payroll`, `Rent`, `Credit card fees`, `Marketing`, `Supplies`, the fixed lines). **Derived rows, totals, margins, and KPIs are never pinnable** so the statement always foots (PRD §14). The API rejects a pin on a derived node server-side (not just hidden in UI).
- **No back-solve:** pinning a downstream node does **not** mutate upstream inputs. Upstream rows that no longer drive any pinned downstream value are surfaced as `flags` in `computed_json` (§4.8), not by editing data.
- **Resolution:** the engine resolves topologically — `resolve(node) = pin.value if pinned else f(resolve(parents))` — and emits the resolved values into `computed_json`/`monthly_json` (see [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md)). The DB stores only the pins; resolution is never persisted as a separate truth.

### 4.7 `monthly_json` (M0..M12 launch cash-flow; PRD §10)
```json
{
  "model_version": "2.0.0",
  "breakeven_month": 5,
  "min_cash_month": 1,
  "months": [
    { "m": 0,  "label": "M0 (pre-open)",
      "revenue": {"raw": 0,      "display": "$0"},
      "expenses":{"raw": 0,      "display": "$0"},
      "startup": {"raw": 208000, "display": "$208,000"},
      "net":     {"raw": -208000,"display": "($208,000)"},
      "cumulativeCash": {"raw": -208000, "display": "($208,000)"} },
    { "m": 1,  "label": "M1", "revenue": {"raw": 18540, "display": "$18,540"}, "...": "..." }
  ]
}
```
- `months` is M0 (pre-open, present only when `opening_status = pre_launch`) through M12 — 13 entries max (PRD §10.2).
- **Year-1 annual totals in `computed_json` are a roll-up of these months** (PRD §10.2/§10.3) so the two surfaces never disagree; a golden test asserts `annual_y1 == sum(monthly)` to the penny (see [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md)).
- Timed startup outflows, the donation S-curve ramp (default ~5 months, `assumptions.ramp`), hire-date payroll, and seasonality all live here. Field names match Appendix D `monthly[]` (`revenue/expenses/net/cumulativeCash` + `breakevenMonth`).
- Each numeric value uses the `{raw, display}` convention; negatives render in parentheses (PRD §12.4).

### 4.8 `computed_json` (resolved P&L + KPIs + decision + flags; PRD §12, Appendix D)

This is the **native view-model output** of the engine, consumed verbatim by both the React frontend and the `.xlsx`/packet builders (one structure, no second math/format surface — PRD §13, frontend/engine lenses). Field names follow Appendix D.

```json
{
  "model_version": "2.0.0",
  "compute_schema_version": "1.0.0",
  "reco": { "tag": "proceed", "headline": "Proceed.",
            "sub": "The model clears break-even and stays within committed funding.",
            "severity": "ok" },
  "metrics": {
    "capital":  { "raw": 277990, "display": "$277,990" },
    "cashGap":  { "raw": -149200, "display": "($149,200)" },
    "breakeven":{ "raw": 5, "display": "Month 5" },
    "reasons": { "reasonCapital": "...", "reasonGap": "...", "reasonBreakeven": "..." }
  },
  "milestones": {
    "grandOpening": { "raw": 1, "display": "Month 1" },
    "breakEven":    { "raw": 5, "display": "Month 5" },
    "payback":      { "raw": null, "display": "N/A",
                      "reason": "N/A — startup costs are not recovered within the projection horizon" }
  },
  "kpis": [
    { "label": "Sales / sq ft", "value": {"raw": 61, "display": "$61"}, "sub": "Year 1", "severity": "ok" },
    { "label": "Payback period", "value": {"raw": null, "display": "N/A"}, "sub": "to recover startup" }
  ],
  "rows": [
    { "label": "Donor market share", "group": "drivers",
      "y1": {"raw": 0.06, "display": "6.0%"}, "y2": {"raw": 0.08, "display": "8.0%"},
      "y3": {"raw": 0.10, "display": "10.0%"}, "class": "input", "editable": true, "node": "share" },
    { "label": "Payroll", "group": "expenses",
      "y1": {"raw": 170764, "display": "$170,764"}, "y2": {"raw": 250000, "display": "$250,000"},
      "y3": {"raw": 284607, "display": "$284,607"}, "class": "overridden", "editable": true, "node": "Payroll" },
    { "label": "Net profit", "group": "totals",
      "y1": {"raw": 46900, "display": "$46,900"}, "...": "...", "class": "computed", "editable": false, "node": "net" }
  ],
  "overrides": [
    { "node": "Payroll", "year": 2, "calculated": {"raw": 227685, "display": "$227,685"},
      "value": {"raw": 250000, "display": "$250,000"}, "note": "signed 2 hires",
      "pinnedDate": "2026-06-24T17:03:11Z", "affected": ["Payroll taxes", "Total Expenses", "Net profit", "Net margin"] }
  ],
  "settings": {
    "laborPct": 0.40, "marketingPct": 0.0375, "suppliesPct": 0.05, "cardPct": 0.02,
    "payrollTaxPct": 0.075, "salvagePct": 0.008, "escalator": 0.03, "basket": 17.08,
    "donationsPerHh": 3, "shareY1": 0.06, "shareY2": 0.08, "shareY3": 0.10,
    "occupancyAnnual": 90000, "leaseType": "nnn", "salesfloorSqft": 7000, "reserveBuffer": 25000
  },
  "sensitivity": { "rent": {"downside": "...", "base": "...", "upside": "..."},
                   "donations": {"downside": "...", "base": "...", "upside": "..."} },
  "flags": {
    "payback": null,
    "margin": "ok",
    "share_y1_out_of_band": false,
    "narrative_grounding": "ok",
    "stale_upstream": []
  }
}
```

**Contract notes:**
- `milestones` (`compute_schema_version ≥ 1.2.0`) carries the three detail-page milestones (`grandOpening`, `breakEven`, `payback`), each a `{raw, display}` project-month value with the **server as the formatting authority** ("Month 6"). An unreached milestone is `{raw: null, display: "N/A", reason}` (the N/A-with-reason flag pattern, **never a misleading 0**); `payback` adds a `duration` display ("25 months") when reached. The KPI strip's **Payback period** KPI is sourced from `milestones.payback`; the legacy `simple_payback_years` KPI is retired from the view-model surface (still computed internally). See [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md) §6.6.
- `monthly[]` covers **all project months `1..N`** (`N = opening_month_number + 11`), x-axis from month 1. Each entry is `{ revenue, expenses, scheduledCosts, net, cumulativeCash }` — the same columns as the `.xlsx` Monthly tab, with `net = revenue − expenses − scheduledCosts`, so a pre-opening month (`1..G-1`) reads as a real monthly loss and `cumulativeCash` accumulates from month 1.
- `reco.tag ∈ {proceed, revise, find_cheaper_rent, raise_cash, delay, do_not_proceed}` (PRD §12.3). The engine emits the **semantic tag + severity**, never a hex color; the client maps tag→token (frontend lens, brand-vs-semantic token separation). `reco.color/bg/icon` from the prototype are **not** emitted by the API.
- `flags` is the explicit **null + flags map** required by PRD §12.4: `revenue == 0 → margin/per-unit KPIs null`; `Y1 net ≤ 0 → payback null` (`"N/A — no Year 1 profit"`); `Y1 revenue == 0 → CAGR null`. Negatives carry through as `{raw: <neg>, display: "($X)"}`. The `.xlsx` renders every null as blank + comment, never `#DIV/0!` (PRD §18).
- `class ∈ {input, computed, overridden, estimated}` (Appendix D `rows[].class`) drives the cell-state UI and the Excel cell-class (blue input / live formula / orange override / N/A).
- `stale_upstream` lists nodes that no longer drive any pinned downstream value (the no-back-solve rule, PRD §14).
- Every figure here is what the narrative grounding validator checks against (PRD §17).

### 4.9 `penny_transcripts.turns_json` (Penny conversation turns — Spec B §7)
```json
[
  {
    "role": "user",
    "content": "Set the Year-1 donor share to 8%.",
    "ts": "2026-06-27T17:03:11Z"
  },
  {
    "role": "assistant",
    "content": "Done — Year-1 share is now 8%. Break-even moved to month 6.",
    "provider": "anthropic",
    "ts": "2026-06-27T17:03:14Z"
  },
  {
    "role": "tool",
    "content": "set_assumption(share_y1=0.08) applied",
    "tool_name": "set_assumption",
    "tool_args": {"node": "share_y1", "value": "0.08"},
    "tool_result_ref": "ref_…",
    "revision_id": "01J…",
    "ts": "2026-06-27T17:03:13Z"
  }
]
```
- `role ∈ {user, assistant, tool}`. `content` is the human-readable line shown in the transcript (and the summary kept when an old tool payload is truncated).
- `tool_name` / `tool_args` / `tool_result_ref` appear on `tool` turns (the §6 tool surface). `revision_id` links a turn that mutated to the revision it produced — the provenance side of the §4 audit trail (revisions carry the matching `actor` enum).
- `provider ∈ {anthropic, openai}` records which provider actually produced an assistant turn (Spec B §8). `ts` is ISO-8601 UTC.
- **Retention** (Spec B §7) bounds the list: the oldest turns fall off past `MAX_TURNS`; older `tool` turns keep `content` but have `tool_args`/`tool_result_ref` nulled (marked `"truncated": true`). The cap is applied above the Store interface (`app/store/penny_retention.py`) so both backends behave identically.

### 4.10 `summary_json` (owner-list card summary — #178)
```json
{
  "location": "Longview city",
  "basis": "city",
  "y1_revenue": { "raw": 426911, "display": "$426,911" },
  "y1_net":     { "raw": 46900,  "display": "$46,900" },
  "capital_required": { "raw": 277990, "display": "$277,990" },
  "reco_tag": "proceed",
  "coords": { "place_id": "...", "lat": 32.5007, "lng": -94.7405, "formatted_address": "Longview, TX, USA" }
}
```
The compact card the owner home list (`GET /api/projections`) renders per row, **denormalized from `computed_json` at write time** by `build_card_summary` (`app/store/card_summary.py`) so the list never `SELECT *` + `json.loads` the full ~10KB `computed_json` per row (#178). `list_card_summaries` selects only this blob + the small identity columns. It is pure display derivation (the engine remains the single math authority); a one-time `_backfill_card_summaries` populates legacy rows on the boot that applies `0008`, and every create/PATCH/restore refreshes it from the new `computed_json`.

---

## 5. Cross-cutting data rules

### 5.1 Optimistic concurrency (`version` + `If-Match`)
Every mutating endpoint requires `If-Match: <version>` (PRD §25). The UPDATE is:
```sql
UPDATE projections
   SET version = version + 1, updated_at = :now, /* ...changed columns... */
 WHERE id = :id AND version = :expected_version AND deleted_at IS NULL;
```
A 0-row result → **HTTP 409** with the current server state in the body so the UI can offer reload / overwrite / save-as-copy (PRD §19.4). The new `version` is returned in the body and as an `ETag`-style header. See [`API_SPEC.md`](./API_SPEC.md).

### 5.2 Single-writer + WAL (connection-per-request reads)
SQLite is a single writer under WAL with `busy_timeout` (§10). **Writes** all go through one primary connection under a process-wide write lock, preserving the single-writer invariant; each autosave settle writes one `revisions` row (§3.2). **Reads** use a **per-thread reader connection** (`SqliteStore._read_conn`, issue #177): a single shared connection for every read serialized all access through SQLite's per-connection mutex, nullified WAL's concurrent-reader benefit, and let one slow query head-of-line-block every other request — including the `/api/health` probe, which could then exceed the healthcheck window and trip a restart loop. With a reader per thread, WAL delivers concurrent reads alongside the single writer, and the health probe runs on its own connection. (An in-memory DB is per-connection, so dev/test reads fall back to the primary connection.) Concurrent edit-link sessions on one projection still serialize through the version check (a stale writer gets a 409, not a lost update).

### 5.3 Model-version lifecycle
`computed_json`/`monthly_json` are stored with `model_version`. On read, if `model_version != current_engine_version`, the API returns the stored snapshot verbatim plus an `upgrade_available: true` flag — **never recompute silently** (PRD §13). `POST …/upgrade-model` recomputes under the new engine and writes a **new revision**, preserving the prior. `compute_schema_version` is tracked separately so a view-model shape change is distinguishable from a math change.

### 5.4 Trash (soft delete) vs purge (hard delete + cascade)
`status = 'trashed'` is the user-visible **Trash** — recoverable (PRD §19.1). **Purge** (`DELETE /api/projections/{view_slug}`, owner-only, permitted only when already trashed) is a **true, irreversible hard delete** (#202): `purge_projection` does a version-checked `DELETE FROM projections` **and cascades** to every child the projection owns — `revisions`, `narratives`, `evidence`, `penny_transcripts`, `actuals`, `role_links` — in one transaction (children deleted before the parent, since the FKs carry no `ON DELETE CASCADE` and `PRAGMA foreign_keys = ON`). A version mismatch returns 0 (HTTP 409) and erases nothing.

This is a deliberate, scoped exception to timpager's NEVER-physically-delete discipline: a privacy "purge" of a tool holding a nonprofit's confidential financials **and** the user's Penny conversation must actually erase the data and stop propagating it, not merely hide it behind `deleted_at` (a misleading contract + data-minimization gap). The NEVER-DROP discipline still governs **migrations** (no `DROP TABLE`/`DROP COLUMN`); this is a row-level data-subject erasure in app code, not a schema change. The legacy `deleted_at` soft-delete marker (`soft_delete`) is retained for backward-compatibility and reads still filter `deleted_at IS NULL`, but the purge path no longer uses it.

> **Backups (SECURITY §13 / OPS_RUNBOOK):** erasure clears the live DB immediately; a **finite Litestream backup-retention window** bounds how long a purged row can survive in object-store snapshots before it is unrecoverable everywhere. Document/enforce that window in ops config (out of the app-code scope of #202).

### 5.5 Numeric discipline at rest
The DB never does arithmetic on stored money. The engine computes in cents/`Decimal` and writes both `raw` (numeric) and `display` (formatted string) into the blobs (PRD §12.4). This makes the server the single rounding/formatting authority shared by UI, `.xlsx`, and packet (frontend lens). See [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md) for the golden/LibreOffice reconciliation gate (< $0.50 / 0.1pp, zero formula errors).

---

## 6. Token hashing at rest

(PRD §20; full policy in [`SECURITY.md`](./SECURITY.md).)

| Token | Entropy | Generation | At rest |
|---|---|---|---|
| Owner bearer token | ≥256-bit | `secrets.token_urlsafe(32)` | `owner_token_hash` = SHA-256(token), hex. Raw token only in client `localStorage`. |
| Edit token | ≥128-bit | `secrets.token_urlsafe(24)` | `edit_token_hash`. Raw delivered via URL **fragment** only; never path/query; never logged. |
| Role slugs (board/funder/advisor) | ≥128-bit | `secrets.token_urlsafe(16)` | **plaintext** `role_links.slug` (the read-only lookup capability, like `view_slug`; delivered in the `/api/r/{slug}` path), plus `role_links.token_hash = SHA-256(slug)` as the hashed-at-rest companion (#180, §3.10). |
| `view_slug` | ≥128-bit | `secrets.token_urlsafe(16)` | **plaintext** (lookup key, read-only access only). |

- **Why SHA-256, not bcrypt/argon2:** these are high-entropy random tokens, not user-chosen passwords; a fast hash is appropriate and constant-time comparison defeats timing attacks. Compare with `hmac.compare_digest` (constant-time) — **never** `==`.
- **No secrets in URL paths or query strings; no secrets in logs.** The edit/recovery secret travels in the URL fragment, is read client-side, sent as `Authorization: Bearer`, and scrubbed from the URL. `Authorization` headers and fragments are never logged.
- **One-time recovery code** is shown once at create time; staff **cannot** recover access (only resolve support IDs). Document this to users (key-loss = data-loss is structural — PRD §29).
- **`actor_token_hash`** in `revisions` records which token authored each change (forensics).

### 6.1 Rotate / revoke (`POST …/rotate-tokens`)
Regenerates owner, edit, view_slug, and all role tokens **atomically in one transaction**, re-hashes them, writes a rotation event into `revisions` (audit), and immediately invalidates all previously-shared links (PRD §20). Must be implemented in v1, not deferred.

---

## 7. WAL configuration

Set on every connection at open (PRD §26; OPS in [`OPS_RUNBOOK.md`](./OPS_RUNBOOK.md)):

```sql
PRAGMA journal_mode = WAL;      -- durable, concurrent reads + single writer; NEVER changed
PRAGMA busy_timeout = 5000;     -- ms; serialize writers without immediate SQLITE_BUSY
PRAGMA synchronous  = NORMAL;   -- safe + fast under WAL with Litestream replication
PRAGMA foreign_keys = ON;       -- enforce FKs (projection_id -> projections)
PRAGMA query_only   = ON;       -- READER connections only (#177); writes stay on the primary
```

- **WAL only — never change the journal mode** (timpager hard rule). Litestream relies on WAL for continuous replication.
- **One writer connection, a reader connection per thread (#177).** The PRAGMAs above are applied on *every* connection at open. Writes use the single primary connection under a write lock; reads use a lazily-opened per-thread reader (opened `query_only = ON` so a read path can never write). This is what actually delivers WAL's "concurrent reads + single writer" — a lone shared connection would serialize everything through SQLite's per-connection mutex and could stall the healthcheck into a restart loop.
- The DB lives at `DB_PATH=/data/projections.db` on the **durable Railway volume** — never `/app`, never ephemeral container FS. (Explicitly avoid the timpager `litestream.yml` bug which points at `/app/timpager.db`; our `litestream.yml` replicates `/data/projections.db`.) See [`OPS_RUNBOOK.md`](./OPS_RUNBOOK.md).
- **Litestream** continuous replication to object storage (R2/S3) from the `/data` volume, with a documented, **tested** restore drill (`PRAGMA integrity_check` + `computed_json` round-trip), RPO (near-zero), RTO (~2 min), and backup purge limits (PRD §21, §26).

---

## 8. Migrations & schema discipline

(Mirrors timpager `SCHEMA.md` Schema Rules + ARCHITECTURE Database Rules.)

- **NEVER `DROP TABLE`; NEVER `DROP COLUMN`.** Use `ALTER TABLE ADD COLUMN`. New nullable/defaulted columns only.
- **`CREATE TABLE/INDEX IF NOT EXISTS` always.** Each `ALTER TABLE ADD COLUMN` is applied **idempotently**: the runner swallows "duplicate column name" so a re-run (e.g. after a crash) is a no-op (issue #185). This is now enforced in code (`SqliteStore._execute_idempotent`), not just asserted in a docstring.
- **Atomic apply (issue #185).** Each migration's DDL **and** its `schema_migrations` ledger INSERT run in **one explicit transaction** (`SqliteStore._apply_migration`). `executescript` is NOT used — it issues an implicit COMMIT that auto-committed the DDL independently of the ledger, so a crash/OOM in that window left the column physically added but the migration name absent from the ledger; the next boot re-ran the bare `ALTER`, hit "duplicate column name", and **boot-crash-looped the single durable volume**. With apply+ledger atomic and every `ALTER` idempotent, a partial apply commits nothing and an interrupted run **recovers on the next boot** instead of looping. Re-running the full set on an already-migrated DB is a no-op.
- **Boot never fails on an existing duplicate, even for a UNIQUE-index migration (`0007`, #186).** The `UNIQUE(projection_id, seq)` revisions backstop (below) cannot blindly run `CREATE UNIQUE INDEX`: if a legacy/corrupted durable volume already held a duplicate `(projection_id, seq)`, the index build would raise `IntegrityError` and crash-loop the unattended boot. So `0007` is applied by `m0007_revision_seq_unique.apply` (a runtime hook dispatched by `SqliteStore._apply_migration`, inside the same atomic apply+ledger transaction) which **detects an existing duplicate first**. With none (the expected case) it creates the **UNIQUE** backstop; with a duplicate (unexpected) it **degrades**: it creates a **non-unique** index instead (lookups/restore stay fast), **never deletes a revision row** (additive-only — duplicates are never resolved by deleting data), logs a loud structured warning naming the affected `projection_id`s (`app.migrations`, `event=revision_seq_duplicate_degraded_index`), and still records `0007` so boot proceeds. Idempotent (a no-op when the index already exists). Operator de-dup + UNIQUE-index restore is documented in [`OPS_RUNBOOK.md`](./OPS_RUNBOOK.md) §8.2.
- **Prepared statements only. No string concatenation into SQL. Frozen migration literals.** A migration is an immutable historical artifact: its embedded DEFAULTs are hand-written, apostrophe-escaped literals, **never** `json.dumps(<live engine constant>)` evaluated at import time (issue #187) — which would drift with the engine across deploys and risk an apostrophe terminating the SQL string. A forward-guard test fails RED if the engine default diverges from the frozen literal, forcing a NEW migration.
- **Migrations run before any other statement on boot**, recorded in `schema_migrations`. A single durable volume with no staging copy means a bad migration corrupts live data — take a **pre-migration Litestream checkpoint/snapshot** before applying (see [`OPS_RUNBOOK.md`](./OPS_RUNBOOK.md)).
- **Additive-only** keeps the Postgres path (§9) trivial: every column added to SQLite is added to the Postgres DDL the same way.
- Boot **refuses** if required secrets/env are unset (no fallback chains) — see [`SECURITY.md`](./SECURITY.md). `DB_BACKEND ∈ {sqlite, postgres}` is explicit so the data-access path is never ambiguous.

---

## 9. Data-access layer (the `Store` interface)

All persistence goes through a single `Store` interface (Python `typing.Protocol`/ABC). `SqliteStore` ships in v1; `PostgresStore` is a documented drop-in (PRD §22, §26). **No SQLite-specific SQL leaks above this interface** (no `INSERT OR REPLACE`, no `rowid`, no `last_insert_rowid()`, no JSON1-function queries).

```python
class Store(Protocol):
    # --- projections (root aggregate) ---
    def get_projection_by_slug(self, view_slug: str) -> Projection | None: ...
    def get_projection_by_role_slug(self, role_slug: str) -> Projection | None: ...  # O(1) role_links slug PK (#180)
    def list_by_owner(self, owner_token_hash: str, *, include_trashed: bool = False) -> list[Projection]: ...
    def list_card_summaries(self, owner_token_hash: str, *, include_trashed: bool = False) -> list[dict]: ...  # small card cols only (#178)
    def create_projection(self, p: Projection) -> Projection: ...        # app-generated ULID + view_slug
    def update_with_version_check(self, id: str, expected_version: int,
                                  patch: ProjectionPatch) -> int: ...     # rows-affected; 0 -> 409
    def update_with_version_check_and_revision(self, id: str, expected_version: int,
                                  patch: ProjectionPatch, revision: Revision) -> int: ...  # version++ AND snapshot in ONE txn; 0 -> 409 (no revision)
    def set_status(self, id: str, status: str, expected_version: int) -> int: ...  # trash/restore
    def soft_delete(self, id: str, expected_version: int) -> int: ...     # legacy: sets deleted_at (recoverable)
    def purge_projection(self, id: str, expected_version: int) -> int: ...  # hard DELETE + cascade (#202); 0 -> 409
    def rotate_tokens(self, id: str, expected_version: int,
                      new_hashes: TokenBundle) -> int: ...                # atomic, one txn (re-syncs role_links)

    # --- revisions ---
    def insert_revision(self, rev: Revision) -> None: ...
    def list_revisions(self, projection_id: str, limit: int = 50) -> list[RevisionMeta]: ...
    def get_revision(self, revision_id: str) -> Revision | None: ...

    # --- narratives ---
    def get_narrative(self, projection_id: str) -> Narrative | None: ...
    def upsert_narrative(self, projection_id: str, n: Narrative) -> None: ...  # NOT "INSERT OR REPLACE"

    # --- evidence ---
    def list_evidence(self, projection_id: str) -> list[Evidence]: ...
    def add_evidence(self, e: Evidence) -> Evidence: ...

    # --- research cache ---
    def get_research(self, cache_key: str) -> ResearchCache | None: ...   # caller checks expires_at
    def put_research(self, r: ResearchCache) -> None: ...

    # --- feedback (no projection link) ---
    def insert_feedback(self, f: Feedback) -> Feedback: ...
    def set_feedback_issue_url(self, support_id: str, url: str) -> None: ...

    # --- actuals (post-launch) ---
    def upsert_actual(self, a: Actual) -> None: ...
    def list_actuals(self, projection_id: str) -> list[Actual]: ...

    # --- penny transcripts (Spec B §7) ---
    def create_transcript(self, t: Transcript) -> Transcript: ...            # rejects NULL projection_id (wizard drafts never persisted)
    def append_transcript_turn(self, projection_id: str, turn: Turn) -> Transcript: ...  # create-on-demand + retention cap
    def get_transcript_by_projection(self, projection_id: str) -> Transcript | None: ...  # owner-scoped (projection_id pre-resolved)
```

**Portability rules enforced by a conformance suite run against BOTH backends:**
1. **App-generated string PKs (ULID).** No reliance on `rowid`/`AUTOINCREMENT`/`last_insert_rowid()`.
2. **Upserts are explicit `SELECT`-then-`INSERT`/`UPDATE` (or `INSERT … ON CONFLICT DO UPDATE`), never `INSERT OR REPLACE`** (which has SQLite-specific delete-then-insert semantics that break FKs/triggers).
3. **JSON columns are opaque `TEXT`/`jsonb`**; the app (de)serializes. No query depends on `json_extract`/JSON1.
4. **Booleans via 0/1 ↔ BOOLEAN** through the mapper, never raw in queries.
5. **Version check is the same SQL on both backends** (`WHERE id=? AND version=?`).

---

## 10. Documented Postgres migration path (PRD §22, §26)

The Postgres path is for when concurrency/auth/multi-instance demands exceed a single-writer SQLite host. Because of the portability rules above, the migration is a **backend swap, not a redesign**.

### 10.1 Trigger
Single-writer SQLite serializes all writes; high autosave write-amplification across many concurrent projections, or a need for multiple app instances, is the trigger. Until then, SQLite (WAL) + Litestream on one durable host is correct for a no-login, low-write product.

### 10.2 Type mapping

| SQLite | Postgres | Notes |
|---|---|---|
| `TEXT` (PK, ULID) | `TEXT PRIMARY KEY` | Same app-generated ULID; no `serial`/`uuid` default change. |
| `TEXT` (JSON blob) | `jsonb` | Stored/read as a string by the app; `jsonb` gains indexing/validation later without app changes. |
| `TEXT` (timestamp ISO-8601) | `timestamptz` | App writes ISO-8601 UTC either way. |
| `INTEGER` (`version`) | `INTEGER` | Identical version-check SQL. |
| `INTEGER` (0/1 bool) | `BOOLEAN` | Mapper handles the 0/1 ↔ true/false conversion. |
| `REAL` | `DOUBLE PRECISION` | Only in `research_cache`/`actuals`; compute money stays in `computed_json` blobs. |

### 10.3 Concurrency / safety differences
- **WAL/busy_timeout** are SQLite-specific and live **below** the interface; Postgres uses connection-pool + row-level locking. The version-check optimistic-concurrency pattern is identical, so the 409 path is unchanged.
- **Litestream** is replaced by Postgres-native backup/PITR; the restore drill in [`OPS_RUNBOOK.md`](./OPS_RUNBOOK.md) gets a Postgres variant.
- Migrations remain additive; `schema_migrations` carries over unchanged.

### 10.4 Cutover (documented procedure)
1. Stand up `PostgresStore`; run the **conformance suite** (§9) green against it.
2. Export SQLite rows; import into Postgres (`jsonb` accepts the JSON text verbatim).
3. Flip `DB_BACKEND=postgres` + `DATABASE_URL`; boot-refuse if either is unset.
4. Verify `integrity`/row-count parity and a `computed_json` round-trip on a sample before flipping traffic.

---

## 11. Index summary

| Table | Index | Purpose |
|---|---|---|
| `projections` | `UNIQUE(view_slug)` | Read lookup by slug. |
| `projections` | `(owner_token_hash, status, updated_at DESC)` | Owner-scoped list (no global index). |
| `projections` | `(edit_token_hash)` | Edit-token resolution. |
| `revisions` | `(projection_id, seq DESC)` | Revisions list + restore. |
| `revisions` | `UNIQUE(projection_id, seq)` | Seq-integrity backstop (0007): a duplicate seq fails loudly, never silently corrupts the trail (#186). On a legacy DB that *already* holds a duplicate, 0007 degrades to a **non-unique** index so boot never fails (§8). |
| `evidence` | `(projection_id, field)` | Evidence panel per field. |
| `research_cache` | PK `(cache_key)`, `(expires_at)` | Cache hit + TTL sweep. |
| `actuals` | `UNIQUE(projection_id, month)`, `(projection_id, month)` | Forecast-vs-actual. |
| `narratives` | PK `(projection_id)` | 1:1 lookup. |
| `feedback` | PK `(support_id)` | Support-ID resolution (staff). |
| `penny_transcripts` | PK `(id)`, `(projection_id)` | Per-project transcript read by projection. |
| `role_links` | PK `(slug)`, `(projection_id)` | O(1) exact-match role-share resolution (0009, #180); per-projection cascade on purge. |

---

## Appendix A — Full v1 DDL (canonical)

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;

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
  cohort_json TEXT NOT NULL DEFAULT '{}',         -- frozen cohort fingerprint (0001)
  terms_accepted_at TEXT,
  ai_opt_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  -- 0005: timed cost schedule + opening anchor (Spec §5/§7). Frozen literal DEFAULTs.
  target_opening_date TEXT,
  opening_month_number INTEGER NOT NULL DEFAULT 1,
  cost_schedule_json TEXT NOT NULL DEFAULT '[{"category": "Thrift Store Consultant", "month": 1, "amount": 100000}, {"category": "Equipment & Fixtures", "month": 1, "amount": 45000}, {"category": "Build-out / Renovations / Tenant Improvements", "month": 1, "amount": 50000}, {"category": "Legal, Permits, Insurance Setup, Signage", "month": 1, "amount": 13500}]',
  summary_json TEXT NOT NULL DEFAULT '{}'         -- 0008: owner-list card summary, denormalized from computed_json (#178)
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
  actor TEXT NOT NULL DEFAULT 'user',            -- 0006: user|penny|penny_undo|user_undo (Spec B §3/§4)
  change_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_projection ON revisions(projection_id, seq DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_revisions_projection_seq ON revisions(projection_id, seq);  -- 0007: seq backstop (#186)

CREATE TABLE IF NOT EXISTS narratives (
  projection_id TEXT PRIMARY KEY REFERENCES projections(id),
  body_md TEXT NOT NULL DEFAULT '',
  edited INTEGER NOT NULL DEFAULT 0,
  computed_hash TEXT,
  snapshot_json TEXT NOT NULL DEFAULT '{}',       -- 0002: computed_json at generation time
  provider TEXT,
  model_version TEXT,
  edit_origin TEXT,                               -- 0004: 'ai' | 'human' | NULL
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

CREATE TABLE IF NOT EXISTS actuals (
  id TEXT PRIMARY KEY,
  projection_id TEXT NOT NULL REFERENCES projections(id),
  month TEXT NOT NULL,
  revenue REAL,
  donations REAL,
  payroll REAL,
  rent REAL,
  other_expense REAL,
  created_at TEXT NOT NULL,
  UNIQUE(projection_id, month)
);
CREATE INDEX IF NOT EXISTS idx_actuals_projection ON actuals(projection_id, month);

CREATE TABLE IF NOT EXISTS penny_transcripts (
  id TEXT PRIMARY KEY,
  projection_id TEXT REFERENCES projections(id),   -- NULLable: wizard drafts are NEVER persisted
  turns_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_penny_transcripts_projection ON penny_transcripts(projection_id);

CREATE TABLE IF NOT EXISTS role_links (             -- 0009: indexed role-share resolution (#180)
  slug TEXT PRIMARY KEY,                            -- plaintext role-share lookup key (like view_slug)
  projection_id TEXT NOT NULL REFERENCES projections(id),
  role_name TEXT NOT NULL,                          -- board | funder | advisor
  token_hash TEXT,                                  -- SHA-256(slug): hashed-at-rest companion (§6)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_role_links_projection ON role_links(projection_id);
```

---

## Appendix B — Example payloads

### B.1 Create-projection request (PRD Appendix B, design-aligned)
```json
{
  "name": "House of Hope — Longview, TX",
  "location": { "query": "Longview, Texas", "place_id": "ChIJ…" },
  "trade_area": { "basis": "city", "households": 31798, "acs_vintage": 2023 },
  "inputs": {
    "opening": "2027-03", "opening_status": "pre_launch",
    "building_sqft": 10000, "salesfloor_pct": 0.70, "lease_type": "nnn",
    "donation_value": 74,
    "demand": { "mode": "market_share", "share_y1": 0.06, "share_y2": 0.08, "share_y3": 0.10 },
    "source_of_funds": { "cash": 150000, "grant": 50000 }
  },
  "demand_drivers": { "competition": "low", "pickup_service": true, "marketing_plan": "launch + ongoing" },
  "assumptions": { "labor_pct": 0.40, "marketing_pct": 0.0375, "supplies_pct": 0.05,
                   "escalator": 0.03, "basket": 17.08, "reserve_buffer": 25000 },
  "overrides": { "Payroll#2": { "value": 250000, "note": "signed 2 hires" } }
}
```
> Note: the legacy PRD Appendix B example used `labor_pct: 0.60` and `share_y1: 0.06` without `share_y2`. v1 resolves labor to `0.40` (§4.5) and requires all three explicit shares (§4.3).

### B.2 Stored `projections` row (abbreviated)
```json
{
  "id": "01J8Z9K3M7QF2V0CWR5T8YH4AB",
  "view_slug": "v_8kQ2m9fLpR3xZ1aW7tB",
  "owner_token_hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "edit_token_hash": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  "role_tokens_json": "{\"board\":{\"slug\":\"r_b2L…\",\"token_hash\":\"…\"}}",
  "name": "House of Hope — Longview, TX",
  "status": "active",
  "version": 7,
  "model_version": "2.0.0",
  "compute_schema_version": "1.0.0",
  "inputs_json": "{…}", "assumptions_json": "{…}",
  "overrides_json": "{\"Payroll#2\":{\"value\":250000,\"note\":\"signed 2 hires\",\"ts\":\"2026-06-24T17:03:11Z\"}}",
  "monthly_json": "{…}", "computed_json": "{…}",
  "terms_accepted_at": "2026-06-24T16:59:00Z",
  "ai_opt_out": 0,
  "created_at": "2026-06-24T16:58:40Z",
  "updated_at": "2026-06-24T17:05:02Z",
  "deleted_at": null
}
```

### B.3 `feedback` row (redacted — what reaches GitHub)
```json
{
  "support_id": "SUP-7F3K9Q",
  "type": "bug",
  "title": "Cash-flow chart break-even marker off by one",
  "body": "Banner says month 5 but the chart marks month 6.",
  "email": "ed@houseofhope.org",
  "context_json": "{\"route\":\"/v_…/edit\",\"app_version\":\"1.4.2\",\"model_version\":\"2.0.0\",\"ts\":\"2026-06-24T17:10:00Z\"}",
  "github_issue_url": "https://github.com/rallytasks/projections/issues/812",
  "status": "open"
}
```
The GitHub issue contains the `support_id`, `type`, `title`, `body`, and non-sensitive `context_json` only — **never** `view_slug`, any token, a projection link, or any financial field (PRD §22).

### B.4 Three golden fixtures (data shape; expected outputs are golden-test targets in [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md))

| Fixture | `inputs`/`assumptions` highlights | Expected `computed_json` highlights |
|---|---|---|
| **House of Hope (conservative)** | shares 6/8/10%, basket $17.08, labor 0.40, NNN, 10k sqft @70% floor | `reco.tag: proceed`, Y1 revenue ~$426,911, Y1 net margin ~11%, `metrics.capital` ~$277,990, `breakeven` ~month 5, `flags.payback` non-null |
| **Aggressive (flagged)** | shares 15/20/25% | net margin ~39% → `flags.margin: "out_of_band"` + `share_y1_out_of_band: true`; guardrail (PRD §12.2) requires a justification note that travels into the packet |
| **Grace Mission (loss case)** | low share, $14/sqft low-confidence rent, one `Payroll#?` override | Y1 net ≈ ($12,400), `metrics.breakeven` null, `flags.payback: null` ("N/A — no Year 1 profit"), one `overrides[]` entry; `.xlsx` renders N/A as blank + comment, **no `#DIV/0!`** |

These fixtures drive the golden + LibreOffice reconciliation gate (PRD §13/§18; `recalc.py` asserts `total_errors == 0` across `#VALUE! #DIV/0! #REF! #NAME? #NULL! #NUM! #N/A`), run **with and without overrides**.

---

## Appendix C — Field → PRD / view-model traceability

| Column / blob field | PRD ref | Appendix D view-model |
|---|---|---|
| `projections.version` | §24, §25 | `version` |
| `projections.model_version` / `compute_schema_version` | §13 | (stamped on compute output) |
| `inputs_json.demand.share_y{1,2,3}` | §7.1, §24 | `settings.shareY{1,2,3}` |
| `assumptions_json.labor_pct/marketing_pct/supplies_pct/escalator/...` | §7.3 | `settings.*` |
| `overrides_json` `"{node}#{year}"` | §14, §24 | `overrides[]` |
| `monthly_json.months[]` | §10 | `monthly[]` + `breakevenMonth` |
| `computed_json.reco` | §12.3 | `reco{tag,headline,sub,severity}` |
| `computed_json.metrics` | §12.1 | `metrics{capital,cashGap,breakeven}` + reasons |
| `computed_json.kpis` | §11 | `kpis[]` |
| `computed_json.rows` | §10.3, §18 | `rows[]{...,class,editable}` |
| `computed_json.flags` | §12.4 | (null + flags map) |
| `evidence.*` | §15, §16 | `evidence[]{label,value,method,badge,change,meta}` |
| `narratives.*` | §17 | (Board Packet prose) |
| `research_cache.*` | §16 | (rent estimate object) |
| `feedback.*` | §22 | (idea fab) |

---

*End of DATA_MODEL.md. Schema changes must update this doc in the same PR (Docs-Are-Code; see [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md)).*

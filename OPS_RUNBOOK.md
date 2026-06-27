# OPS_RUNBOOK.md — Thrift Store Projection Web App

**Repo:** `rallytasks/projections` · **Owner:** Andy Downard · **Updated:** 2026-06-24 · **Status:** Build-ready spec (pre-build)

This is the operations runbook for the Thrift Store Projection app: how it is deployed, where its data lives, how that data is backed up and restored, how it stays healthy, and every environment variable it needs. It is derived from PRD §13/§18/§20/§21/§26/§27, the design's view-model contract (PRD Appendix D), and the operational patterns proven in the sibling product `timpager` (Railway + SQLite/WAL + Litestream). Where this runbook deviates from timpager, the deviation is called out explicitly — most importantly the **Litestream DB-path fix** (timpager replicates an ephemeral `/app` path; we replicate the durable `/data` volume).

This document is **build/spec only**. No product code is defined here. It is self-consistent with the sibling docs and cross-links them where relevant:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — service layout, compute core, data-access interface
- [`DATA_MODEL.md`](./DATA_MODEL.md) — SQLite schema (PRD §24)
- [`API_SPEC.md`](./API_SPEC.md) — endpoint surface (PRD §25), `If-Match`/409 concurrency
- [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md) — math authority, golden-test gate (PRD §13/§18)
- [`SECURITY.md`](./SECURITY.md) — capability tokens, CSP, SSRF, sanitization (PRD §20/§21)
- [`BUILD_PLAN.md`](./BUILD_PLAN.md) — milestone sequencing (PRD §28)
- [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md) — release gates
- [`CONTRIBUTING.md`](./CONTRIBUTING.md), [`CLAUDE.md`](./CLAUDE.md), [`AGENTS.md`](./AGENTS.md) — build process
- [`IDEA_FAB.md`](./IDEA_FAB.md) — feedback → GitHub (redacted), intent → CRM (PRD §22)

---

## 0. TL;DR — what an operator needs to know

| Thing | Value |
|---|---|
| Platform | Railway, service inside the existing **`thriftly.com`** project |
| Source | `rallytasks/projections` (config-as-code: `railway.toml`) |
| Runtime | Python **FastAPI** + Uvicorn, single container |
| DB | **SQLite (WAL)** at `DB_PATH=/data/projections.db` on a durable Railway **volume mounted at `/data`** |
| Backup | **Litestream** continuous WAL replication to **Cloudflare R2** (S3-compatible) + periodic snapshots |
| RPO | **< 10 s** (continuous WAL streaming) |
| RTO | **≈ 2–5 min** (restore + integrity check + restart) |
| Health | `GET /api/health` (liveness + build SHA + DB + replication) |
| Replicas | **1** (single writer; SQLite/WAL is not multi-instance safe) |
| Promote | merge → staging → **verify new build SHA on `/api/health`** → production |
| Migrations | **additive-only**, run **before** any schema/statement setup, on every boot |
| Excel gate | LibreOffice `recalc.py` must report `total_errors: 0` and cell deltas `< $0.50 / 0.1pp` — **CI-blocking** |

---

## 1. Deployment topology

### 1.1 Where it runs

A single Railway **service** lives inside the existing **`thriftly.com` Railway project**, wired to the **`rallytasks/projections`** GitHub repo. There are two environments:

| Environment | Purpose | Domain (public) | Direct Railway domain (deploy verification) |
|---|---|---|---|
| `staging` | Pre-production verification | `staging-projections.thriftly.com` *(set at provision)* | `projections-staging-<hash>.up.railway.app` |
| `production` | Live | `projections.thriftly.com` *(set at provision)* | `projections-production-<hash>.up.railway.app` |

> **Why the direct Railway domains matter:** if the public hostnames sit behind a WAF/proxy that blocks unfamiliar IPs (as in timpager), healthcheck polling and `curl`-from-dev-box verification must hit the **direct** `*.up.railway.app` domain, which bypasses the edge. Record both per environment once provisioned and keep them in `scripts/verify-deploy.sh` as `DEPLOY_URL` defaults.

**Single replica is intentional and load-bearing.** SQLite/WAL with Litestream is a **single-writer, single-host** design (PRD §26). `numReplicas = 1` and `sleepApplication = false` are not tunables — raising replicas would give two writers on one volume and corrupt the DB. The Postgres path (PRD §22/§26, documented in [`ARCHITECTURE.md`](./ARCHITECTURE.md)) is the only supported route to horizontal scale; do not scale SQLite horizontally.

### 1.2 `railway.toml` (config-as-code)

Config-as-code overrides the dashboard. This guarantees every change deploys and prevents the timpager class of bug where dashboard watch-paths silently skipped directories and PRs deployed as SKIPPED.

```toml
[build]
builder = "dockerfile"
dockerfilePath = "./Dockerfile"
# Deploy on ANY repo change. Do NOT narrow this to a pattern that can silently
# drop app/, frontend/, or engine/ changes (timpager shipped SKIPPED deploys
# that way). If deploy frequency ever becomes a problem, exclude only docs/tests
# explicitly — never app code.
watchPatterns = ["**"]

[deploy]
startCommand = "uvicorn app.main:app --host 0.0.0.0 --port 8080"
healthcheckPath = "/api/health"
healthcheckTimeout = 30
numReplicas = 1
sleepApplication = false
restartPolicyType = "always"
restartPolicyMaxRetries = 10
```

### 1.3 The Docker image (ops-relevant contents)

The image is a single Python container that must contain three operationally critical things beyond the app:

1. **Litestream binary** + `litestream.yml`, started as a supervisor so the DB is replicated from process start. The container entrypoint runs `litestream replicate -exec "uvicorn app.main:app ..."` so Litestream owns the process lifecycle and flushes on shutdown.
2. **A pinned LibreOffice** (`soffice`) + the `timeout`/`gtimeout` wrapper that `recalc.py` depends on. This is required by the Excel-correctness release gate (§9). **Pin the LibreOffice version in the Dockerfile** — `recalc.py` recalculation values are version-sensitive and an unpinned `soffice` can drift the `< $0.50` tolerance or flake the gate. The gate runs in CI (the same image), not in the production request path.
3. **The Python engine** (`engine/`) — the single math authority (PRD §13), including the `.xlsx` builder. See [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md).

> The math engine is **pure compute with no network, subprocess, secret, or `eval` surface** when invoked by the API. The server controls the output directory for `.xlsx`/`.docx` generation (a per-request temp dir, streamed then cleaned up) — **never** a user-supplied path. `org_name`/output paths from user input must never reach the filesystem unsanitized (path-traversal guard).

### 1.4 Startup order (must not be reordered)

On every boot, in this exact order:

1. **`validate_config()`** — boot-refuse if any required env var is unset in production (§5.3). No fallback chains.
2. **`run_migrations(db)`** — apply pending versioned migrations (§8). Migrations run **first**, before any table/index/statement creation, mirroring timpager regression #14 ("Schema before migrations" → migrations before schema).
3. **`init_schema(db)` / `prepare_statements(db)`** — create-if-not-exists schema and prepared statements.
4. **`open_store(DB_BACKEND)`** — open the data-access store (`SqliteStore` for v1).
5. Bind the HTTP listener; `/api/health` begins answering only after steps 1–4 succeed.

If step 1 fails in production, **the process exits non-zero and Railway restarts it** (which will keep failing until the env is fixed — this is the desired loud failure, not a silent degraded boot).

---

## 2. Data durability — the volume & SQLite

### 2.1 The durable volume

- A Railway **volume is mounted at `/data`** on the service (both environments, separate volumes).
- The database lives at **`DB_PATH=/data/projections.db`**. The WAL sidecar files `/data/projections.db-wal` and `/data/projections.db-shm` live alongside it.
- **Nothing else durable is stored on the volume** except the DB and its Litestream metadata. Generated `.xlsx`/`.docx`/packets are produced on demand to a temp dir and streamed — they are **never** persisted to the volume (re-generation from `computed_json` is deterministic; PRD §13). User-attached evidence files (PRD §15/§24 `file_ref`), if/when stored, must be hardened per [`SECURITY.md`](./SECURITY.md) (type/size limits, non-executable content-type, `Content-Disposition`, ideally off-origin in R2) and are out of scope for the v1 volume.

> **CRITICAL — do NOT copy timpager's path bug.** timpager's `litestream.yml` replicates `/app/timpager.db`, which is the **ephemeral container filesystem**, not its durable volume. For projections, the DB MUST be on `/data` and Litestream MUST replicate `/data/projections.db`. Replicating an `/app` path would mean backups of an ephemeral disk — i.e., effectively no backup. This is the single most important correction relative to the reference.

### 2.2 SQLite settings (applied on every connection)

| Pragma / setting | Value | Why |
|---|---|---|
| `journal_mode` | `WAL` | Concurrent readers during a write; crash-safe; required by Litestream |
| `busy_timeout` | `5000` ms | Autosave (PRD §19.3) drives frequent writes; serialize gracefully instead of `SQLITE_BUSY` errors |
| `synchronous` | `NORMAL` | Safe under WAL + Litestream; good write throughput |
| `foreign_keys` | `ON` | Integrity of `revisions`/`evidence`/`narratives` → `projections` |
| `wal_autocheckpoint` | default (1000 pages) | Litestream relies on a live WAL; do not disable checkpointing |
| Writes | **single-writer, serialized** | One replica; debounced autosave; app-level write serialization |

### 2.3 Write-load profile (autosave) and revision growth

The detail page autosaves on a debounce (PRD §19.3): each settle issues one `PATCH` that recomputes and **writes one `revisions` snapshot** (PRD §24). This is a **single-row update + one append to an append-only `revisions` table** per settle.

- **Mitigations (must ship):** client debounce (~300–400 ms) + request cancellation by `version`; server-side single-writer serialization (WAL + `busy_timeout`); **`If-Match: <version>` enforced on every mutation** so stale concurrent edits 409 instead of clobbering (PRD §25; see §3 below).
- **Revision retention (must define):** `revisions` is append-only and unbounded by default. Define a retention/compaction policy so a heavily-edited projection cannot bloat the DB and slow Litestream: **keep all revisions for 90 days, then keep every Nth / daily-last snapshot beyond that**, and always keep restore-pointed and pre-upgrade revisions. Compaction is a scheduled job (§7), additive/non-destructive to schema. Document the chosen policy to users as part of retention (PRD §21).

---

## 3. Concurrency & data-safety invariants (ops-visible)

These are application invariants but they have direct operational consequences (lost updates, restore confusion), so they belong in the runbook.

- **Every mutating request requires `Authorization: Bearer <token>` + `If-Match: <version>`** (PRD §25). The `UPDATE` is `SET version = version + 1, ... WHERE id = ? AND version = ?`. A 0-row result returns **HTTP 409** with the current server state in the body so the UI can offer reload / overwrite / save-as-copy (PRD §19.4). The new version is returned in the body and as an `ETag`-style header.
- **Version-locked compute** (PRD §13): `computed_json` is persisted with the `model_version` that produced it. On read, if the stored `model_version` differs from the current engine, the server returns the **stored snapshot verbatim** and surfaces an "upgrade available" flag. **Never silently recompute.** `POST …/upgrade-model` writes a **new revision** (the prior is preserved). Track **two** versions: `model_version` (the math) and `compute_schema_version` (the shape of `computed_json` / view-model) so a renderer change is never mistaken for a math change.
- **Migrations are additive-only** (§8). A bad migration on a single durable volume corrupts the live DB; the discipline + the pre-migration snapshot checkpoint (§8.2) are the safety net.

---

## 4. Disaster recovery — Litestream

### 4.1 Configuration (`litestream.yml`)

Continuous replication of the WAL to Cloudflare R2 (S3-compatible). **The path is `/data/projections.db`** — the durable volume, not `/app`.

```yaml
dbs:
  - path: /data/projections.db          # the durable Railway volume — NOT /app
    replicas:
      - type: s3
        bucket: ${LITESTREAM_BUCKET}
        path: projections.db
        endpoint: ${LITESTREAM_ENDPOINT}            # e.g. https://<acct>.r2.cloudflarestorage.com
        access-key-id: ${LITESTREAM_ACCESS_KEY_ID}
        secret-access-key: ${LITESTREAM_SECRET_ACCESS_KEY}
        region: ${LITESTREAM_REGION}                # R2: "auto"
        # Retention / snapshot cadence — backup purge limits (PRD §21):
        retention: 720h           # keep 30 days of WAL/snapshots in R2
        snapshot-interval: 24h    # full snapshot daily; WAL streamed continuously
        validation-interval: 12h  # Litestream self-checks restore-ability
```

### 4.2 Objectives

| Metric | Target | Basis |
|---|---|---|
| **RPO** (max data loss) | **< 10 s** | WAL frames stream continuously; only the in-flight (sub-second) frame is at risk |
| **RTO** (time to restored service) | **≈ 2–5 min** | `litestream restore` + `PRAGMA integrity_check` + restart (matches timpager's ~2 min, plus integrity verification) |
| **Backup retention** | **30 days** in R2 | `retention: 720h`; stated to users as the backup purge limit (PRD §21) |

### 4.3 Replication must not silently be off

timpager's runbook marks Litestream "conditional — runs only if `LITESTREAM_BUCKET` is set," which makes it easy to ship with replication silently disabled. **For projections, the `LITESTREAM_*` vars are REQUIRED in production (boot-refuse)** — see §5. In addition, `/api/health` reports `replication` status (last successful WAL push age) and a daily scheduled check (§7) alerts if replication has not advanced.

### 4.4 Restore drill (a deliverable, not just docs)

A `scripts/restore-db.sh` MUST exist and MUST be **exercised before launch (M0/M7)** against a throwaway volume — an untested restore is fiction. The drill:

```bash
# scripts/restore-db.sh — restore the latest replica into a target path
litestream restore \
  -o "$TARGET_DB" \
  -config /etc/litestream.yml \
  /data/projections.db

# Verify the restored DB is sound:
sqlite3 "$TARGET_DB" "PRAGMA integrity_check;"        # must print: ok
sqlite3 "$TARGET_DB" "SELECT count(*) FROM projections;"
# Round-trip a known projection's computed_json (decision metrics present):
python -m scripts.verify_restore "$TARGET_DB" --slug "<known-view-slug>"
```

**Drill acceptance:** `integrity_check` returns `ok`; row counts are plausible; at least one projection's `computed_json` round-trips and re-renders identical decision metrics (capital required, break-even month, recommendation) to a pre-drill snapshot. Record the drill date + restored-version in the deploy log.

### 4.5 Real recovery procedure (production data loss / volume corruption)

1. **Stop writes.** Scale the service to 0 (or take it out of the LB) so no new writes race the restore.
2. **Provision/clear the target volume** at `/data`.
3. **Restore:** `litestream restore -o /data/projections.db /data/projections.db` (from the R2 replica).
4. **Integrity-check:** `sqlite3 /data/projections.db "PRAGMA integrity_check;"` → must be `ok`. If not `ok`, restore from a prior snapshot generation.
5. **Restart** the service (boot runs migrations first, then schema; §1.4).
6. **Verify** `/api/health` reports the new build, DB reachable, replication live; spot-check a known projection.
7. **Log** the incident: time, RPO actually achieved (gap between last WAL frame and incident), RTO, restored generation.

---

## 5. Environment variable inventory (complete)

This is the **single source of truth** for ops; it MUST be mirrored 1:1 by a code module (`app/env_requirements.py`) that `validate_config()` reads at boot, exactly as timpager uses `lib/env-requirements.js`. **Status** reflects what is wired today in the `thriftly.com` Railway project versus what an operator must still provision before the corresponding milestone.

### 5.1 Required in production — boot refuses if unset

| Secret / config | Env var | Status | Purpose | Behavior if missing |
|---|---|---|---|---|
| DB backend | `DB_BACKEND` | **TODO** (set at M0) | Must be explicit: `sqlite` (v1) or `postgres`. Removes data-access ambiguity (mirrors timpager). | Boot refuses |
| DB location | `DB_PATH` | **TODO** (set at M0) | `=/data/projections.db` (sqlite). Durable volume path. | Boot refuses |
| Census | `CENSUS_API_KEY` | **TODO** (M3) | ACS household base per locked trade-area basis (PRD §8/§16.5) | Boot refuses *(required from M3; before M3, city/county research is stubbed)* |
| Google Places | `GOOGLE_PLACES_API_KEY` | **TODO** (M3) | Location autocomplete → place/county + lat/lng (PRD §7.1) | Boot refuses *(required from M3)* |
| AI primary | `ANTHROPIC_API_KEY` | **TODO** (M3/M5) | Anthropic primary for research-extract + narrative (PRD §16/§17) | Boot refuses *(at-least-one AI rule, below)* |
| Litestream bucket | `LITESTREAM_BUCKET` | **TODO** (M0) | R2 bucket for WAL replication | **Boot refuses** — replication must never be silently off (§4.3) |
| Litestream endpoint | `LITESTREAM_ENDPOINT` | **TODO** (M0) | R2 S3-compatible endpoint | Boot refuses |
| Litestream key id | `LITESTREAM_ACCESS_KEY_ID` | **TODO** (M0) | R2 credential | Boot refuses |
| Litestream secret | `LITESTREAM_SECRET_ACCESS_KEY` | **TODO** (M0) | R2 credential | Boot refuses |
| Litestream region | `LITESTREAM_REGION` | **TODO** (M0) | `auto` for R2 | Boot refuses |
| Canonical URL | `PLATFORM_URL` | **TODO** (M0) | Canonical base for share links, CSP, CORS | Boot refuses |

**At-least-one AI rule:** production must have **`ANTHROPIC_API_KEY` (primary)** set. `OPENAI_API_KEY` (fallback, PRD §17) is optional but recommended in production. If *neither* is set, the AI features hard-fail at boot **only if AI is not globally disabled**; if the operator intends an AI-disabled deployment, set `AI_DISABLED=1` (below) and the opt-out path (PRD §21) keeps compute + `.xlsx` working. This makes the §21 "compute/save/export with zero AI calls" guarantee an explicitly testable boot mode.

**Ship Penny "dark" in prod (keys stay set).** To disable AI at runtime **without unsetting the provider keys** — so the boot rule above stays satisfied and the server boots normally — set `AI_DISABLED=1` (truthy: `1`/`true`/`yes`, case-insensitive) and **keep `ANTHROPIC_API_KEY` set**. `app/penny/providers.build_provider_chain` then builds an **empty** chain regardless of the keys, so Penny makes zero provider calls and the `/penny*` endpoints return `409 ai_disabled` (the FAB is muted), while compute/save/`.xlsx`/narrative-disabled all keep working. **To enable Penny live, flip it OFF — unset `AI_DISABLED` (or set it to `0`/`false`) — no secrets change required.** This is the production go-live toggle for Penny.

### 5.2 Optional — graceful degrade (no boot warning, feature disables cleanly)

| Secret / config | Env var | Status | Degrades to |
|---|---|---|---|
| AI fallback | `OPENAI_API_KEY` | **TODO** (M5) | No fallback provider; Anthropic-only. If both unset + `AI_DISABLED=1`, AI features off. |
| GitHub feedback token | `GITHUB_TOKEN` *(a.k.a. `GH_PAT`)* | **TODO** (M6) | Feedback stored locally with a `support_id` but no GitHub issue created (PRD §22). Accept either name; `GITHUB_TOKEN` canonical, `GH_PAT` honored for parity with timpager. |
| GitHub org | `GITHUB_ORG` | **TODO** (M6) | `=rallytasks`. Without it, issue routing disabled. |
| GitHub repo | `GITHUB_REPO` | **TODO** (M6) | `=projections`. Without it, issue routing disabled. |
| CRM | `CRM_API_KEY` | **TODO** (M6) | Intent capture stored locally; no CRM push (PRD §6.1/§22). |
| AI kill switch | `AI_DISABLED` | **live** (PE3) | Truthy (`1`/`true`/`yes`, case-insensitive) forces the PRD §21 opt-out mode globally: `build_provider_chain` returns an empty chain **even with `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` set** (keys stay set → boot rule §5.1 unaffected); Penny → `409 ai_disabled`, zero provider calls; compute + save + `.xlsx` still work. The prod "ship Penny dark" switch — unset/`0`/`false` enables Penny live. |
| Sentry | `SENTRY_DSN` | **TODO** (M0/M7) | No error/observability reporting; app still runs (§6). |
| Census app id | `CENSUS_API_BASE` | optional | Defaults to the public ACS base. |
| Litestream snapshot tuning | `LITESTREAM_RETENTION`, `LITESTREAM_SNAPSHOT_INTERVAL` | optional | Falls back to `litestream.yml` defaults (30d / 24h). |

### 5.3 Boot-refuse policy (no fallback chains)

- Production (`ENV=production`): **any unset required var (§5.1) crashes the boot** with a structured, secret-free error naming the missing var(s). No silent fallback, no default substitution (this is timpager's strongest pattern; absent there originally, it caused regression-class outages).
- Dev/test: **permissive** — a missing required var logs a structured event and boot proceeds, so local and CI runs work without the full secret set. The AI-disabled and feedback-disabled paths are exercised in CI precisely because the keys are unset there (this is how the §21 opt-out guarantee stays tested).
- **Secrets are never logged, never returned to clients, never placed in URL paths/query, and never in `X-Forwarded`/`Authorization` log lines** (PRD §20; [`SECURITY.md`](./SECURITY.md)). Capability tokens (owner ≥256-bit, `view_slug` ≥128-bit) are app-generated CSPRNG values, stored hashed (SHA-256), compared constant-time — they are not in this inventory because they are per-projection data, not deploy-time config.

### 5.4 Minimum env set for a new production environment

```
ENV=production
DB_BACKEND=sqlite
DB_PATH=/data/projections.db
PLATFORM_URL=https://projections.thriftly.com
CENSUS_API_KEY=...
GOOGLE_PLACES_API_KEY=...
ANTHROPIC_API_KEY=sk-ant-...
LITESTREAM_BUCKET=...
LITESTREAM_ENDPOINT=https://<acct>.r2.cloudflarestorage.com
LITESTREAM_ACCESS_KEY_ID=...
LITESTREAM_SECRET_ACCESS_KEY=...
LITESTREAM_REGION=auto
# Recommended:
OPENAI_API_KEY=sk-...
GITHUB_TOKEN=...        GITHUB_ORG=rallytasks      GITHUB_REPO=projections
CRM_API_KEY=...
SENTRY_DSN=...
```

---

## 6. Health checks & observability

### 6.1 Health endpoint — `GET /api/health`

`healthcheckPath = "/api/health"` (railway.toml). **A bare HTTP 200 is NOT proof of a successful deploy** — Railway serves 200s from the *old* instance during a build. The promotion gate (§7.1) verifies the **new build SHA**.

`/api/health` returns:

```json
{
  "status": "ok",
  "deployment_sha": "<git-sha-of-running-build>",
  "uptime_seconds": 87,
  "model_version": "2.0.0",
  "compute_schema_version": "1.0.0",
  "db": { "reachable": true, "integrity": "ok", "wal_mode": true },
  "replication": { "enabled": true, "last_push_seconds_ago": 3 },
  "ai": { "anthropic": "configured", "openai": "configured", "disabled": false }
}
```

- `deployment_sha` is the load-bearing field for deploy verification. Fallback when absent: a fresh boot (`uptime_seconds < 120`).
- `db.integrity` is a cheap reachability/`quick_check`, not a full `PRAGMA integrity_check` on every poll (that is reserved for the restore drill and incident response).
- `replication.last_push_seconds_ago` makes silent backup failure visible (§4.3). The daily scheduled check (§7.2) alerts if this exceeds a threshold.
- Health must answer only after migrations + schema succeed (§1.4).

### 6.2 Sentry (errors + tracing)

- `SENTRY_DSN` (optional; recommended in prod). Initialize at boot; tag every event with `deployment_sha`, `model_version`, environment.
- **Never send PII or financial fields to Sentry.** Scrub request bodies for projection financials; `Authorization` headers and URL fragments are dropped before send (consistent with PRD §20/§22 — no resolvable projection link, no financial fields ever leave the server unredacted).
- Capture: unhandled 5xx, provider failures (Anthropic/OpenAI/Places/Census/GitHub/CRM), recalc-gate failures in CI, 409 conflict rate (a spike signals an autosave/concurrency bug), and boot-config failures.

### 6.3 Per-provider observability (PRD §27)

Emit structured metrics — **latency, error rate, and call volume per external provider** — for: Anthropic, OpenAI, Google Places, US Census, GitHub, CRM. These feed cost control (cap regenerations, cache research; PRD §16.6/§27) and incident triage (§10). Surface them via logs + Sentry breadcrumbs; a lightweight `GET /api/metrics` (owner/admin-gated) can expose rolling counters.

### 6.4 Audit / access log (PRD §20/§25)

A durable audit trail (in `revisions.actor_token_hash` + a dedicated access log) records: mutations, **token rotations**, exports (`.xlsx`/packet), and **share-link access events** — for forensics after a leaked edit fragment. Logs store **hashed** tokens only, never plaintext tokens or fragments.

---

## 7. Deploy & promotion

### 7.1 Promotion flow

```
feature branch → PR → CI green (incl. golden + recalc gate) → merge to main
   → merge main → staging → VERIFY staging /api/health shows the NEW build SHA
   → merge staging → production → VERIFY production /api/health shows the NEW build SHA
```

The promote gate is `scripts/promote.py` (#90). It polls `GET <base>/api/health` and declares success **only** when the response proves the NEW build is live — all of: HTTP 200 + a JSON body, `build_sha` == the just-pushed commit (a bare 200 from the OLD instance is **refused**), `db == "connected"`, and `litestream == "replicating"`. It is **fail-closed**: a wrong/missing SHA, db-not-ok, replication-off, non-JSON, non-200, or fetch error refuses the promote (exit 1). If the public domain is WAF-gated, point it at the direct `*.up.railway.app` URL via `STAGING_URL`/`PROD_URL`:

```bash
# After merge to staging, gate before promoting staging → production:
python -m scripts.promote --base-url "$STAGING_URL" --sha "$GIT_SHA" --attempts 60 --delay 10
# Exit 0 = new build verified live; exit 1 = REFUSED (do not promote).
python -m scripts.promote --base-url "$PROD_URL"    --sha "$GIT_SHA" --attempts 60 --delay 10
```

The acceptance/refusal matrix (new SHA → accept; old/missing SHA, db down, replication off, bare 200 → refuse) is pinned by `scripts/test_promote.py`.

**Never promote without a healthcheck that confirms the new build SHA** (timpager regressions #15/#52/#87). A 200 from the old instance is not a pass.

### 7.2 Scheduled operational jobs

| Job | Cadence | Action |
|---|---|---|
| Replication freshness check | every 15 min | Alert if `/api/health.replication.last_push_seconds_ago` exceeds threshold |
| Restore drill (staging) | weekly | Run `restore-db.sh` into a throwaway path; assert `integrity_check: ok` + `computed_json` round-trip; record date |
| Revision compaction | daily | Apply the retention policy (§2.3) |
| Research-cache TTL sweep | daily | Expire stale `research_cache` rows (PRD §16.6) |

### 7.3 Rollback

- **App rollback:** `git revert <sha>` → PR → re-promote. Or redeploy the prior image from Railway. Because compute is **version-locked**, rolling the app back does **not** silently mutate stored `computed_json` (PRD §13).
- **Data rollback:** restore from Litestream to a prior snapshot generation (§4.5). Use this only for corruption/loss, not for app bugs.

---

## 8. Migrations (versioned, on deploy)

### 8.1 Discipline

- **Versioned migrations run on every boot, before schema/statement setup** (§1.4). A numbered, append-only migrations directory (`app/store/migrations/NNNN_*.sql` or equivalent), each idempotent.
- **Additive-only. NEVER DROP TABLE; NEVER DROP COLUMN** (timpager's hard rule). Schema changes are `ALTER TABLE ADD COLUMN` / new tables / new indexes. The single durable volume + no staging copy means a destructive migration corrupts live data with no clean undo. **This is enforced as code, twice (#90):** a CI gate `python -m scripts.migration_lint` (wired in `.github/workflows/ci.yml`) fails the build the moment a `DROP TABLE`/`DROP COLUMN`/`DROP INDEX`/`RENAME`/destructive `ALTER`/`TRUNCATE`/bulk `DELETE`/table-recreate is introduced; and the boot path calls `assert_migrations_additive(MIGRATIONS)` first in `SqliteStore.migrate()`, so a destructive migration **refuses to boot** before any DDL touches the volume. Both reuse the same `app/store/migration_safety.py` scanner (comment/string-literal-stripped keyword scan), so they cannot drift.
- App-generated **string PKs (UUID/ULID)** and **no SQLite-specific SQL above the data-access interface** (no `INSERT OR REPLACE`, no `last_insert_rowid()`) so the documented Postgres path stays a drop-in (PRD §22/§26; [`ARCHITECTURE.md`](./ARCHITECTURE.md)).
- Ship the **`actuals` table schema from day one** (PRD §24/§6.3) so post-launch actuals are not a later migration — but build **no actuals UI in v1**. (Pinned by a regression test that asserts `actuals` exists from `0001_init`.)

### 8.2 Migration safety procedure (production)

1. Migration is additive and reviewed (PR; [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md)). The CI additive-only gate (`scripts/migration_lint.py`) must be green before merge.
2. **Force a Litestream checkpoint/snapshot before the migration runs** so there is a clean pre-migration restore point. The migration runner does this automatically: when `SqliteStore.migrate()` detects pending migrations it calls `force_pre_migration_checkpoint()` (`app/store/litestream.py`) **once, before any pending DDL** — a truncating WAL checkpoint (`PRAGMA wal_checkpoint(TRUNCATE)`) that flushes the WAL into the main DB file so the next continuous Litestream sync (`sync-interval: 1s`) ships the clean pre-migration image. When `LITESTREAM_BUCKET` is set the checkpoint logs a `replicating` restore-point line; when it is not (dev/test) it is a harmless no-op. The checkpoint is skipped entirely when there is no pending migration (no snapshot for a no-op boot).
3. Deploy to **staging first**; verify migration applied and `/api/health` healthy (and that the boot log shows the pre-migration checkpoint line).
4. Promote to production with the promote gate (§7.1, `scripts/promote.py`); verify; spot-check a known projection.
5. If a migration fails: the boot fails loudly (restart loop), data is untouched (additive), fix forward with a new migration or restore from the pre-migration snapshot (§4.5).

**Exercised once (#90):** `python -m scripts.migration_lint` → `migration-lint OK: 6 migration(s) additive-only`; the pre-migration checkpoint ordering, the promote-gate outcomes, and the day-one `actuals` regression are covered by `app/tests/test_migration_checkpoint.py`, `scripts/test_promote.py`, and `scripts/test_migration_lint.py`.

---

## 9. Excel-correctness release gate (CI-blocking)

The math engine is the single authority (PRD §13). The release gate is what keeps that claim true across three surfaces: server Python compute, the persisted `computed_json`, and the live formulas in the exported `.xlsx`.

- **Three-way reconciliation:** server compute == `computed_json` == **LibreOffice recalc of the exported `.xlsx`** (via `recalc.py`), within **`< $0.50` on dollar cells** and **`< 0.1pp` on percent cells**, with **`total_errors == 0`** across `{#VALUE!, #DIV/0!, #REF!, #NAME?, #NULL!, #NUM!, #N/A}`.
- **Run in BOTH states: with overrides and without.** The current skill only recalcs the no-override happy path; the gate MUST also cover an overridden-component fixture and the N/A edge paths (revenue=0, Y1 net ≤ 0, negative net) — these are exactly the cases that produce `#DIV/0!` today (the legacy builder's `=net/totrev` and `=startup/Y1net` have no zero-guard).
- **Fail closed.** The CI step asserts `status == "success"` **and** `total_errors == 0` explicitly — a `recalc.py` *error dict* (e.g. `soffice` missing) is a **failure**, never a silent pass. **Pin the LibreOffice version** in the build image and ensure `timeout`/`gtimeout` is present.
- This gate is CI-blocking and a release-blocking item in [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md). It runs in CI, not in the production request path (the production export still re-runs compute deterministically and could optionally spot-recalc asynchronously).
- See [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md) for the formula appendix, the golden fixtures (House of Hope conservative; the aggressive flagged case; the Grace Mission loss case), and the numeric-discipline rules (cents internally, round at display).

---

## 10. Incident response

| Incident | Symptom | Response | User experience |
|---|---|---|---|
| **Anthropic down / 429** | Narrative + research-extract fail | Fall back to OpenAI (PRD §17); if both down, return 503 on AI endpoints only. **Compute, save, and `.xlsx` export keep working** (PRD §21). | Narrative shows "AI unavailable — try again"; projection + decision outputs + Excel unaffected |
| **OpenAI down** | Fallback unavailable | Anthropic-only; if Anthropic also down, AI features 503 | Same as above |
| **Google Places down** | Autocomplete fails | Manual location entry path (PRD §19.4) | "Couldn't search — enter manually" |
| **US Census down** | Household base lookup fails | Manual households entry (PRD §8/§19.4) | "Couldn't fetch households — enter manually" |
| **GitHub down** | Feedback issue not created | Store feedback locally with `support_id`; retry later (PRD §22) | User still gets a support ID |
| **CRM down** | Intent push fails | Store intent locally; retry | Transparent to user |
| **DB volume near full** | Write latency / `SQLITE_FULL` risk | Grow the Railway volume; run revision compaction (§2.3); archive old `revisions`. Monitor at 80%. | None if caught early |
| **DB corruption / data loss** | `integrity_check` not `ok`; read errors | **Litestream restore** (§4.5); integrity-check; restart | Brief downtime ≈ RTO (2–5 min) |
| **Railway cold start** | Brief 502s | Auto-recovery (`restartPolicyType="always"`); WAL recovers an unclean shutdown | Momentary, self-heals |
| **Recalc gate flake in CI** | `recalc.py` error dict / timeout | Confirm pinned `soffice` + `timeout` present in image; re-run; do **not** override a real failure | (No prod impact; blocks deploy) |
| **Replication stalled** | `last_push_seconds_ago` high; alert fires | Check `LITESTREAM_*` creds + R2 reachability; restart Litestream supervisor; verify a fresh restore | (Backups at risk — fix before next write-heavy period) |
| **Leaked edit fragment** | Unexpected edits; audit shows foreign actor | `POST …/rotate-tokens` (invalidates shared links atomically; PRD §20); review access log; advise owner | Old links stop working; owner re-shares |
| **Key-loss = data-loss** | User lost owner token + recovery code | **Staff CANNOT recover access** (no login; PRD §29). Staff can only resolve a `support_id` to a projection record — not grant access. Set user expectations accordingly. | Projection is effectively orphaned; one-time recovery code shown at create time is the only mitigation |

---

## 11. Security/ops cross-checks (summary; full detail in SECURITY.md)

These are enforced in code and verified in CI; listed here so the operator knows what "secure by deploy" means.

- **Enforcing CSP from day one** (greenfield SPA, no inline-script debt): `default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; connect-src 'self' api.anthropic.com api.openai.com`. The browser never talks to Places/Census/GitHub/CRM/R2 directly — those are server-side only.
- **CORS locked to `PLATFORM_URL`**; **`X-Robots-Tag: noindex`** + `robots.txt` disallow on every response (PRD §20).
- **SSRF guard** on the research fetcher: block private/link-local/loopback/metadata ranges (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `::1`, `fc00::/7`) and disallow redirects into them — the fetcher pulls attacker-influenceable web pages from inside Railway's network (PRD §16.1).
- **Server-side allowlist sanitization** of narrative `body_md` and any user rich text before storage and render — closes the stored-XSS → token-theft path inherent to `localStorage` bearer tokens (PRD §20/§24).
- **Rate limits per IP + per token** on the expensive/abuse-prone endpoints (`/api/research`, `…/narrative:regenerate`, `/api/feedback`, `/api/intent`, projection create) — tokens are free to mint, so these are the only brakes on cost-amplification and GitHub-issue spam (PRD §20/§27/§29).
- **LLM grounding as hard server-side validators** (not prompt politeness): unfetched citations rejected; web text treated as untrusted data; post-generation numeric grounding rejects any prose figure absent from `computed_json` (PRD §16/§17).
- **Feedback redaction:** no `view_slug`/resolvable link, no financial fields ever in the GitHub payload — only a random `support_id` (PRD §22; [`IDEA_FAB.md`](./IDEA_FAB.md)).
- **Terms acceptance before export/share** + AI-disclosure UI + documented provider retention (prefer zero-retention endpoints) (PRD §21).

---

## 12. Provisioning checklist (new environment, M0)

1. Create the Railway **service** in the **`thriftly.com`** project, link `rallytasks/projections`.
2. Create and **mount a volume at `/data`**.
3. Set the **minimum env set** (§5.4); confirm **boot refuses** if any required var is missing.
4. Provision a **Cloudflare R2 bucket** + S3 credentials; set `LITESTREAM_*`.
5. Confirm the Dockerfile pins **LibreOffice** and includes **Litestream** + `litestream.yml` (path `/data/projections.db`).
6. Deploy to **staging**; verify `/api/health` shows the new `deployment_sha`, `db.wal_mode: true`, `replication.enabled: true`.
7. **Run the restore drill** (`restore-db.sh`) into a throwaway path; assert `integrity_check: ok` + `computed_json` round-trip. Record the date.
8. Confirm migrations ran (boot logs) and the **`actuals` table exists** (schema-only, no UI).
9. Verify the **Excel recalc gate** is green in CI (with and without overrides).
10. Confirm `SENTRY_DSN` reporting and per-provider metrics are emitting.
11. Set the public domain; verify CORS/CSP/noindex headers; record the direct `*.up.railway.app` URL.
12. Promote to **production** via the verified-new-SHA flow (§7.1).

---

## 13. Deviations from the timpager reference (explicit)

| timpager pattern | projections decision | Reason |
|---|---|---|
| `litestream.yml` replicates `/app/timpager.db` | **Replicate `/data/projections.db`** | `/app` is ephemeral container FS — replicating it is effectively no backup |
| Litestream "conditional, runs only if `LITESTREAM_BUCKET` set" | **`LITESTREAM_*` required in prod (boot-refuse)** + health-reported | Replication must never be silently off |
| CSP ships Report-Only (`'unsafe-inline'` debt from 83 inline handlers) | **Enforcing CSP from day one**, no `'unsafe-inline'` | Greenfield React+TS SPA, no inline-script debt |
| Cookie/session auth | **Capability bearer tokens, no cookies** | No login; no CSRF on mutations (PRD §20) |
| Node/Express runtime | **Python FastAPI** | Reuse the Python math engine as the single authority (PRD §13/§23) |

---

*End of OPS_RUNBOOK.md. Operational invariants trace to PRD §13, §18, §20, §21, §22, §24, §25, §26, §27, §28. For the math contract see [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md); for the security model see [`SECURITY.md`](./SECURITY.md); for the build sequence see [`BUILD_PLAN.md`](./BUILD_PLAN.md).*

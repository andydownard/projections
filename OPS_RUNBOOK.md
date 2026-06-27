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
# NO startCommand here ON PURPOSE. The Docker image's start.sh entrypoint runs
# uvicorn UNDER `litestream replicate -exec` and binds Railway's injected ${PORT}.
# A startCommand would OVERRIDE start.sh and thereby DISABLE continuous Litestream
# backups (turns OFF replication); a hardcoded `:8080` also breaks the healthcheck
# because Railway routes to $PORT, not 8080. Do NOT add startCommand here — pasting
# one during recovery silently kills the only backup mechanism (issue #191).
healthcheckPath = "/api/health"
healthcheckTimeout = 120
numReplicas = 1
restartPolicyType = "always"
restartPolicyMaxRetries = 10
sleepApplication = false
```

> **This block matches the shipped `railway.toml` exactly.** The deliberate
> *absence* of `startCommand` and `healthcheckTimeout = 120` (not `30`) are
> load-bearing — see the in-block comment. Copy it verbatim; do not "helpfully"
> add a `startCommand`.

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
| `query_only` | `ON` (reader connections) | Reader connections fail closed on a write; writes stay on the primary (#177) |
| Writes | **single primary connection, serialized** | One replica; debounced autosave; app-level write lock on one writer connection |
| Reads | **per-thread reader connection** | WAL concurrent reads (#177); the `/api/health` probe gets its own connection and can't be head-of-line-blocked into a restart loop |

### 2.3 Write-load profile (autosave) and revision growth

The detail page autosaves on a debounce (PRD §19.3): each settle issues one `PATCH` that recomputes and **writes one `revisions` snapshot** (PRD §24). This is a **single-row update + one append to an append-only `revisions` table** per settle.

- **Mitigations (must ship):** client debounce (~300–400 ms) + request cancellation by `version`; server-side single-writer serialization (WAL + `busy_timeout`); **`If-Match: <version>` enforced on every mutation** so stale concurrent edits 409 instead of clobbering (PRD §25; see §3 below).
- **Revision retention (must define):** `revisions` is append-only and unbounded by default. Define a retention/compaction policy so a heavily-edited projection cannot bloat the DB and slow Litestream: **keep all revisions for 90 days, then keep every Nth / daily-last snapshot beyond that**, and always keep restore-pointed and pre-upgrade revisions. Compaction is a scheduled job (§7), additive/non-destructive to schema. Document the chosen policy to users as part of retention (PRD §21).

---

## 3. Concurrency & data-safety invariants (ops-visible)

These are application invariants but they have direct operational consequences (lost updates, restore confusion), so they belong in the runbook.

- **Every mutating request requires `Authorization: Bearer <token>` + `If-Match: <version>`** (PRD §25). The `UPDATE` is `SET version = version + 1, ... WHERE id = ? AND version = ?`. A 0-row result returns **HTTP 409** with the current server state in the body so the UI can offer reload / overwrite / save-as-copy (PRD §19.4). The new version is returned in the body and as an `ETag`-style header.
- **The version bump and its revision snapshot are one transaction** (`update_with_version_check_and_revision`, issue #186): 409 → no revision; success → `version++` and the snapshot commit together. No crash can leave a bumped version with no recoverable snapshot. A `UNIQUE(projection_id, seq)` index (migration `0007`) makes a duplicate/miscomputed `seq` fail loudly rather than silently corrupt the restore/audit trail.
- **One writer connection, a reader connection per thread** (issue #177). All writes serialize on a single primary connection under a write lock; reads use a per-thread reader so WAL delivers concurrent reads and a slow query can never head-of-line-block another request — including the `/api/health` probe, whose stall could otherwise trip Railway's healthcheck into a restart loop.
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
        # Path PREFIX inside the (possibly shared) R2 bucket — env-driven, not a
        # literal, so a re-provision can't collide with another DB's prefix.
        path: ${LITESTREAM_PATH}
        endpoint: ${LITESTREAM_ENDPOINT}            # e.g. https://<acct>.r2.cloudflarestorage.com
        region: ${LITESTREAM_REGION}                # R2: "auto"
        access-key-id: ${LITESTREAM_ACCESS_KEY_ID}
        secret-access-key: ${LITESTREAM_SECRET_ACCESS_KEY}
        # Backup purge limit (PRD §21) + WAL stream cadence (RPO < 10 s):
        retention: 720h           # keep 30 days of WAL/snapshots in R2
        sync-interval: 1s         # ship WAL frames ~every second
```

> **This block matches the shipped `litestream.yml` exactly.** It intentionally has
> **no `snapshot-interval` and no `validation-interval`** — earlier drafts of this
> runbook showed both, but they are NOT in the shipped file (issue #191). Restore-
> ability is NOT self-validated by Litestream; it is proven by the **restore drill**
> (`scripts/restore-db.sh`, §4.4) run weekly against a throwaway volume (§7.2).
> Replication *liveness* (that WAL is still advancing) is surfaced separately via
> `/api/health` + the scheduled freshness check (§4.3 / §7.2) — see the §4.3 note.

### 4.2 Objectives

| Metric | Target | Basis |
|---|---|---|
| **RPO** (max data loss) | **< 10 s** | WAL frames stream continuously; only the in-flight (sub-second) frame is at risk |
| **RTO** (time to restored service) | **≈ 2–5 min** | `litestream restore` + `PRAGMA integrity_check` + restart (matches timpager's ~2 min, plus integrity verification) |
| **Backup retention** | **30 days** in R2 | `retention: 720h`; stated to users as the backup purge limit (PRD §21) |

### 4.3 Replication must not silently be off

timpager's runbook marks Litestream "conditional — runs only if `LITESTREAM_BUCKET` is set," which makes it easy to ship with replication silently disabled. **For projections, the `LITESTREAM_*` vars are REQUIRED in production (boot-refuse)** — see §5. In addition, `/api/health` reports `replication` status (last successful WAL push age) and a daily scheduled check (§7) alerts if replication has not advanced.

### 4.4 Restore drill (a deliverable, not just docs)

`scripts/restore-db.sh` MUST exist and MUST be **exercised before launch (M0/M7)** against a throwaway volume — an untested restore is fiction. The script restores the latest replica into a **throwaway** target, then **fails closed** unless every acceptance condition holds:

```bash
# Restore the latest R2 replica into a throwaway target, then verify it.
DB_PATH=/data/projections.db RESTORE_VERIFY_SLUG=<known-view-slug> \
  scripts/restore-db.sh /tmp/restore-drill.db
```

Under the hood the script: **(1)** `litestream restore -config "$LITESTREAM_CONFIG" -o "$TARGET" "$DB_PATH"` (or, with `RESTORE_REPLICA_URL`, straight from a `file://` / `s3://` replica); **(2)** `PRAGMA integrity_check` — must print `ok`; **(3)** `SELECT count(*) FROM projections` — plausibility; **(4)** `python -m scripts.verify_restore "$TARGET" --slug …` — round-trips a known projection's `computed_json` and asserts the three decision metrics (capital required, break-even month, recommendation) re-render. **Any failure exits NON-ZERO** — it never falsely reports success. Env knobs: `LITESTREAM_CONFIG` (def `/etc/litestream.yml`), `RESTORE_REPLICA_URL`, `RESTORE_VERIFY_SLUG` (def `example`), `PYTHON`, and `RESTORE_SKIP_LITESTREAM=1` to **re-verify an already-restored volume** without pulling a replica (also how CI exercises the verify/fail-closed branches where the `litestream` binary is absent).

**Drill acceptance:** `integrity_check` == `ok`; row counts plausible; ≥1 projection's `computed_json` re-renders **identical** capital / break-even / recommendation vs a pre-drill snapshot.

**Automated coverage:** `app/tests/test_restore_drill.py` drives the script end-to-end — a CI-runnable dry-run leg (sound DB passes; corrupt DB, unknown slug, and missing decision metric each fail closed) plus a live leg (skip-guarded on the `litestream` binary) that seeds a REAL engine-computed projection, replicates it to a throwaway file replica, restores via `restore-db.sh`, and asserts the decision is byte-identical. `app/tests/test_litestream_config.py` locks the replicated path to `/data/projections.db` (regression #13 — never `/app`).

#### Recorded drill — 2026-06-27 (M7.3)

Executed with `litestream v0.5.10` + `sqlite3` against a **throwaway file replica** (R2 credentials are not present in the build env; the live R2 leg runs from the deployed container — §4.5 — once `LITESTREAM_*` are provisioned). A real `example` projection was seeded by the engine, replicated, then restored into a throwaway path:

```text
pre-drill decision: {"capital": "$279,446", "breakeven": "Month 5", "reco": "proceed"}

litestream replicate … "snapshot complete" db=source.db txid=0000000000000001 size=13043

$ scripts/restore-db.sh /…/restored.db
Restoring -> /…/restored.db via Litestream...
Restore wall time: 0s (RTO budget ~120-300s).
Integrity check...
Row count (plausibility): projections=1
Round-trip check (decision metrics re-render)...
{"ok": true, "integrity": "ok", "projection_count": 1, "slug": "example",
 "decision": {"capital": "$279,446", "breakeven": "Month 5", "reco": "proceed"}}
OK: restore verified (integrity ok + decision round-trip).
```

| Drill field | Result |
|---|---|
| Date | 2026-06-27 |
| Litestream | v0.5.10 (local drill) · v0.3.13 in the runtime image |
| Restored generation / txid | `ltx` generation, txid `0000000000000001` (snapshot 13,043 B) |
| `integrity_check` | `ok` |
| Row count | 1 projection (throwaway seed) |
| Decision round-trip | **IDENTICAL** — capital `$279,446`, break-even `Month 5`, reco `proceed` |
| **RPO** (basis) | **< 10 s** — `sync-interval: 1s`; only the in-flight sub-second WAL frame is at risk |
| **RTO** (measured) | restore+verify in **< 1 s** on the throwaway DB; budget **≈ 2–5 min** in prod (network pull of the full replica + restart) |

**Backup purge limit (surface to users — PRD §21):** R2 retention is **30 days / 720h** (`retention: 720h`, §4.1). Snapshots/WAL older than 30 days are purged and are **not** recoverable; restores can recover data up to 30 days old, no further. This bound is the user-facing backup-retention promise and MUST appear in the privacy/retention copy (PRD §21).

**Live R2 leg (run from the deployed container before launch):** with `LITESTREAM_*` set, run `scripts/restore-db.sh /data/restore-drill.db` on the service to exercise the real R2 path, then record date + restored generation + measured RTO in the deploy log.

### 4.5 Real recovery procedure (production data loss / volume corruption)

1. **Stop writes.** Scale the service to 0 (or take it out of the LB) so no new writes race the restore.
2. **Provision/clear the target volume** at `/data`.
3. **Restore:** `litestream restore -config /etc/litestream.yml -o /data/projections.db /data/projections.db` (from the R2 replica). Equivalently, run `scripts/restore-db.sh /data/projections.db` to restore **and** verify (integrity + decision round-trip) in one fail-closed step.
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
| Litestream replica prefix | `LITESTREAM_PATH` | **set at M0** | Path PREFIX inside the R2 bucket (e.g. `projections.db`); `litestream.yml` substitutes it so a shared bucket can't collide. |
| Litestream retention/cadence | (none) | n/a | `litestream.yml` hardcodes `retention: 720h` (30-day purge limit, PRD §21) and `sync-interval: 1s` (RPO < 10 s). There is **no `snapshot-interval`/`validation-interval`** and no env override for these — change them in `litestream.yml`, not via env. |

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
LITESTREAM_PATH=projections.db          # path PREFIX in the bucket (litestream.yml substitutes ${LITESTREAM_PATH})
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

There are **two** endpoints (issue #190 — the primary used to "fail open": it hard-coded `status:"ok"` and returned 200 even with the DB down, so Railway kept routing to a broken instance):

**Primary — `GET /api/health` (the Railway deploy gate; ALWAYS HTTP 200 when reachable):**

```json
{ "status": "ok", "build_sha": "<git-sha>", "model_version": "2.3.0",
  "db": "connected", "litestream": "replicating" }
```

- **Shape is load-bearing and frozen.** Exactly `{status, build_sha, model_version, db, litestream}`. The Railway healthcheck AND the deploy smoke test (`scripts/promote.py`) require **200 + `build_sha` (== the just-pushed SHA) + `db == "connected"` + `litestream == "replicating"`** — do NOT add/rename fields and do NOT make this endpoint flap to non-200 on a transient blip (that fail-loops deploys).
- **`status` now reflects REAL state** (it is no longer hard-coded): `ok` when healthy; `unhealthy` when the DB ping fails (`db` reads `"unavailable"`); `degraded` when the DB is up but replication is off **in production** (backups silently off, §4.3). The HTTP code stays **200** — the trouble is surfaced LOUDLY in the `status` field, not by flapping the deploy gate.
- `build_sha` is `config.build_sha()` (driven by `RAILWAY_GIT_COMMIT_SHA`) — the load-bearing field for deploy verification. Fallback when absent: a fresh boot.

**Readiness — `GET /api/health/ready` (deeper probe for monitoring; MAY return HTTP 503):**

```json
{ "status": "ok", "build_sha": "<git-sha>", "model_version": "2.3.0",
  "compute_schema_version": "1.2.0", "uptime_seconds": 87,
  "checks": { "db": { "ok": true, "detail": "connected" },
              "litestream": { "ok": true, "detail": "replicating", "required": true } } }
```

- Returns **HTTP 503** when `status == "unhealthy"` (the DB / data path is down) — the loud, unmissable signal that fixes the fail-open gap. Point an external uptime monitor / alert at THIS endpoint (the primary `/api/health` must stay 200 for the deploy gate).
- A `degraded` instance (e.g. backups off in prod) stays **200** here — it can still serve, so we alert on the `status`/`checks` fields rather than restart-looping a serveable replica.
- Health answers only after migrations + schema succeed (§1.4).
- **Deeper DB diagnostics (`PRAGMA quick_check`, `wal_mode`) require a `Store`-interface extension** (`app/store/*`, out of #190's scope) and are deliberately NOT yet in `checks.db` — `checks.db.ok` is the public-interface `ping()` reachability signal. Tracked as a follow-up; full `PRAGMA integrity_check` stays reserved for the restore drill / incident response.

### 6.2 Sentry + structured logging (errors + incident triage)

Wired in `app/observability.py` and called first in `create_app()` boot (`configure_logging()` then `init_sentry()`), so even boot-config failures are captured.

- **Structured JSON logging (always on).** `configure_logging()` installs a JSON formatter on the root logger; every line carries `deployment_sha` / `model_version` / `env` and is **secret-scrubbed** via `app.metrics.scrub` (bearer tokens, provider key shapes, high-entropy capability tokens, live secret env values, and `$`/percent financial figures are redacted — SECURITY §6.3/§10). The handler is additive + tagged so it never clobbers pytest `caplog`/uvicorn.
- **Sentry (opt-in, safe).** `init_sentry()` is a **no-op unless `SENTRY_DSN` is set AND `sentry-sdk` is installed** — it never breaks boot. `sentry-sdk` is intentionally not a hard dependency; **to activate Sentry in production, add `sentry-sdk` to the runtime image and set `SENTRY_DSN`** (a DSN with the SDK missing logs a one-line `sentry_dsn_set_but_sdk_missing` nudge and continues). When active it tags every event with `deployment_sha` / `model_version` / environment, sets `send_default_pii=False`, and runs a `before_send` that **drops `Authorization` headers + cookies + query strings and scrubs request bodies / financial fields** (PRD §20/§22 — no resolvable projection link, no financial fields ever leave the server unredacted).
- Capture (once active): unhandled 5xx, provider failures (Anthropic/OpenAI/Places/Census/GitHub/CRM, via the #95 breadcrumbs), 409 conflict-rate spikes (autosave/concurrency bug), and boot-config failures.

### 6.3 Per-provider observability (PRD §27)

Emit structured metrics — **latency, error rate, and call volume per external provider** — for: Anthropic, OpenAI, Google Places, US Census, GitHub, CRM. These feed cost control (cap regenerations, cache research; PRD §16.6/§27) and incident triage (§10). Surface them via logs + Sentry breadcrumbs; a lightweight `GET /api/metrics` (owner/admin-gated) can expose rolling counters.

**Emitter — `app/metrics.py` (M7.7 / #95).** A process-local, thread-safe registry (mirrors `app/ratelimit.py`; swap for a shared store if the service scales horizontally). Provider call sites wrap their network seam in `metrics.track(<provider>)`, which times the call, increments **call volume**, records **latency**, and increments the **error** counter on an exception (the exception still propagates — behavior is unchanged). `record_provider_call(...)` is the lower seam when a latency is already measured. Each metric is tagged with a **canonical provider label** (`anthropic`, `openai`, `google_places`, `us_census`, `github`, `crm`) — never a URL, payload, or key. Every emission also writes a **scrubbed structured breadcrumb** to the `app.metrics` logger and a best-effort **Sentry breadcrumb** (no-op when `sentry_sdk` is absent).

**LLM token + cost counters.** `record_llm_usage(<provider>, input_tokens=, output_tokens=)` accumulates per-AI-provider token counts and the **server-computed USD cost**. Cost is derived from a server-owned per-MTok price table (Anthropic default = Claude Opus 4.8 list price, $5 in / $25 out per 1M tokens; OpenAI carries an illustrative default). Ops override per provider without a deploy via env: `LLM_PRICE_ANTHROPIC_INPUT`, `LLM_PRICE_ANTHROPIC_OUTPUT`, `LLM_PRICE_OPENAI_INPUT`, `LLM_PRICE_OPENAI_OUTPUT` (USD per 1M tokens). **No client math** — cost is never supplied or recomputed by the browser.

**Cost-control verification counters (PRD §16.6/§27).** Generic named counters surface the spend brakes built by M3.4 / M5.5: `research_cache_hit` / `research_cache_miss`, `narrative_cache_hit` / `narrative_cache_miss`, and `narrative_regen_blocked` (the per-IP+token regeneration cap). A rising hit rate and a non-zero `narrative_regen_blocked` confirm the caches and the regen cap are holding.

**Owner/admin-gated surface — `GET /api/metrics`.** Returns the secret-free `snapshot()`: per-provider `{calls, errors, error_rate, avg_latency_ms, input_tokens, output_tokens, cost_usd}` for all six providers, the cost-control `counters`, and LLM `totals`. The gate is a dedicated server-env **`METRICS_TOKEN`** (secrets are server-env only; no fallback chain — SECURITY.md §4):

- `METRICS_TOKEN` **unset** → `404` (the endpoint does not exist; an unauthenticated probe learns nothing, and it is never an open surface — so it does **not** block boot if unset);
- missing `Authorization` → `401`; wrong bearer → `403` (constant-time `hmac.compare_digest` on the SHA-256 hash; the token never appears in a path/query/log);
- correct bearer → `200`. Read-only (only `GET` is registered).

**No secrets in metrics (hard invariant, SECURITY.md §6.3/§10).** The registry holds only provider labels and numbers, so `snapshot()` is secret-free by construction. As defense-in-depth, every structured log/breadcrumb value passes through `metrics.scrub()`, which redacts bearer tokens, provider key shapes (`sk-…`, `AIza…`, `ghp_…`/`github_pat_…`), high-entropy capability tokens, the live secret env **values**, and `$`/percent financial figures. With AI keys unset (opt-out, PRD §21), the AI providers are never called, so **no AI-provider metric is emitted** while the keyless compute path still records its non-AI providers.

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

- **Versioned migrations run on every boot, before schema/statement setup** (§1.4). A numbered, append-only migrations directory (`app/store/migrations/NNNN_*.sql` or equivalent).
- **Atomic + idempotent apply (issue #185).** Each pending migration's DDL **and** its `schema_migrations` ledger INSERT commit in **one explicit transaction** (`SqliteStore._apply_migration`); every `ALTER TABLE ADD COLUMN` re-run is guarded so it tolerates "duplicate column name". `executescript` is deliberately NOT used — it issues an implicit COMMIT that auto-commits the DDL independently of the ledger, so a crash/OOM/redeploy in the window between the two could leave a column physically added but the migration name absent from the ledger; the next boot then re-ran the bare `ALTER`, hit "duplicate column name", and **boot-crash-looped the single durable volume** (fixable only by hand-editing the DB). With apply+ledger atomic and every `ALTER` idempotent: a partial apply commits **nothing** and an interrupted run **recovers on the next boot**; re-running the full set on an already-migrated DB is a no-op. Covered by `app/tests/test_store_robustness.py` (crash-window-then-reboot recovery, atomic rollback on a failed statement, full-rerun no-op).
- **Additive-only. NEVER DROP TABLE; NEVER DROP COLUMN** (timpager's hard rule). Schema changes are `ALTER TABLE ADD COLUMN` / new tables / new indexes. The single durable volume + no staging copy means a destructive migration corrupts live data with no clean undo. **This is enforced as code, twice (#90):** a CI gate `python -m scripts.migration_lint` (wired in `.github/workflows/ci.yml`) fails the build the moment a `DROP TABLE`/`DROP COLUMN`/`DROP INDEX`/`RENAME`/destructive `ALTER`/`TRUNCATE`/bulk `DELETE`/table-recreate is introduced; and the boot path calls `assert_migrations_additive(MIGRATIONS)` first in `SqliteStore.migrate()`, so a destructive migration **refuses to boot** before any DDL touches the volume. Both reuse the same `app/store/migration_safety.py` scanner (comment/string-literal-stripped keyword scan), so they cannot drift.
- App-generated **string PKs (UUID/ULID)** and **no SQLite-specific SQL above the data-access interface** (no `INSERT OR REPLACE`, no `last_insert_rowid()`) so the documented Postgres path stays a drop-in (PRD §22/§26; [`ARCHITECTURE.md`](./ARCHITECTURE.md)).
- Ship the **`actuals` table schema from day one** (PRD §24/§6.3) so post-launch actuals are not a later migration — but build **no actuals UI in v1**. (Pinned by a regression test that asserts `actuals` exists from `0001_init`.)

### 8.2 Migration safety procedure (production)

1. Migration is additive and reviewed (PR; [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md)). The CI additive-only gate (`scripts/migration_lint.py`) must be green before merge.
2. **Force a Litestream checkpoint/snapshot before the migration runs** so there is a clean pre-migration restore point. The migration runner does this automatically: when `SqliteStore.migrate()` detects pending migrations it calls `force_pre_migration_checkpoint()` (`app/store/litestream.py`) **once, before any pending DDL** — a truncating WAL checkpoint (`PRAGMA wal_checkpoint(TRUNCATE)`) that flushes the WAL into the main DB file so the next continuous Litestream sync (`sync-interval: 1s`) ships the clean pre-migration image. When `LITESTREAM_BUCKET` is set the checkpoint logs a `replicating` restore-point line; when it is not (dev/test) it is a harmless no-op. The checkpoint is skipped entirely when there is no pending migration (no snapshot for a no-op boot).
3. Deploy to **staging first**; verify migration applied and `/api/health` healthy (and that the boot log shows the pre-migration checkpoint line).
4. Promote to production with the promote gate (§7.1, `scripts/promote.py`); verify; spot-check a known projection.
5. If a migration fails *to apply*: the apply transaction rolls back (no partial schema), the boot fails loudly, and the next boot **re-attempts and recovers** (apply is atomic + idempotent, #185) — it no longer crash-loops on an already-added column. Data is untouched (additive); fix forward with a new migration or restore from the pre-migration snapshot (§4.5).
6. **`UNIQUE(projection_id, seq)` backstop (migration `0007`, #186).** A `CREATE UNIQUE INDEX` over existing rows would fail if the live DB already held a duplicate `(projection_id, seq)`. A healthy DB never does (the app has always written `seq = if_match + 1` under the version check), so the index builds cleanly. If a legacy/corrupted DB ever blocks the index, de-duplicate first: `SELECT projection_id, seq, COUNT(*) FROM revisions GROUP BY 1,2 HAVING COUNT(*) > 1;` then resolve before deploying.

**Exercised:** `python -m scripts.migration_lint` → `migration-lint OK: 7 migration(s) additive-only`; the pre-migration checkpoint ordering and the day-one `actuals` regression are covered by `app/tests/test_migration_checkpoint.py`; the atomic+idempotent apply and the crash-window-then-reboot recovery by `app/tests/test_store_robustness.py`; the promote-gate by `scripts/test_promote.py` and `scripts/test_migration_lint.py`.

---

## 9. Excel-correctness release gate (CI-blocking)

The math engine is the single authority (PRD §13). The release gate is what keeps that claim true across three surfaces: server Python compute, the persisted `computed_json`, and the live formulas in the exported `.xlsx`.

- **Three-way reconciliation:** server compute == `computed_json` == **LibreOffice recalc of the exported `.xlsx`** (via `recalc.py`), within **`< $0.50` on dollar cells** and **`< 0.1pp` on percent cells**, with **`total_errors == 0`** across `{#VALUE!, #DIV/0!, #REF!, #NAME?, #NULL!, #NUM!, #N/A}`.
- **Run in BOTH states: with overrides and without.** The current skill only recalcs the no-override happy path; the gate MUST also cover an overridden-component fixture and the N/A edge paths (revenue=0, Y1 net ≤ 0, negative net) — these are exactly the cases that produce `#DIV/0!` today (the legacy builder's `=net/totrev` and `=startup/Y1net` have no zero-guard).
- **Fail closed.** The CI step asserts `status == "success"` **and** `total_errors == 0` explicitly — a `recalc.py` *error dict* (e.g. `soffice` missing) is a **failure**, never a silent pass. **Pin the LibreOffice version** in the build image and ensure `timeout`/`gtimeout` is present.
- This gate is CI-blocking and a release-blocking item in [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md). It runs in CI, not in the production request path (the production export still re-runs compute deterministically and could optionally spot-recalc asynchronously).
- See [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md) for the formula appendix, the golden fixtures (House of Hope conservative; the aggressive flagged case; the Grace Mission loss case), and the numeric-discipline rules (cents internally, round at display).

---

## 9a. Flip the price/gate flag (no-deploy)

The free-vs-paid business-model gate (PRD §3, [`API_SPEC.md`](./API_SPEC.md) §10a) is a **single server config** flipped **without a deploy**. The flag is re-read on every request, so a value change takes effect on the **next** request — no restart, no rebuild.

- **The two vars (Railway service variables):**
  - `GATE_MODE` — `free` (default) or `paid_review`. Unset/unknown ⇒ `free` (safe default; never refuses boot).
  - `GATE_PRICE_USD` — the dollar price surfaced in the CTA. Read **only** in `paid_review`; ignored (and `price_usd:null`) in `free`. Garbage/negative ⇒ `null`.
- **To turn the gate ON:** set `GATE_MODE=paid_review` and `GATE_PRICE_USD=<dollars>`. Verify with `curl -s $PROD_URL/api/config` → `{"gate_mode":"paid_review","price_usd":<n>}`. The basic `.xlsx`/packet stay free in every mode; only the expert-review / sign-off surface gates (`402 payment_required`).
- **To turn it OFF:** set `GATE_MODE=free` (or unset it). Verify `/api/config` returns `{"gate_mode":"free","price_usd":null}`.
- **A/B (M-1):** a per-cohort override `GATE_MODE__<COHORT>` (e.g. `GATE_MODE__B=paid_review`) addresses a split without a rebuild; the experiment surface itself is wired in M-1. The gate state is emitted on the expert-review response for conversion attribution.
- **Caution:** this is a **product/business** toggle, NOT a security control. It never gates the basic export and is orthogonal to the terms-acceptance gate (terms are always required before export/share). Do not use it to restrict data access.

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

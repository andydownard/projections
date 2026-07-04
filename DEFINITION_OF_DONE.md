# Definition of Done — Thrift Store Projection Web App

**Repo:** `rallytasks/projections` · **Status:** ready-to-build (not yet built) · **Stack:** FastAPI + React/TS · SQLite (WAL) + Litestream on a durable Railway volume (`/data/projections.db`) · capability-token access (no login).

> **Global engineering contract:** https://github.com/rallytasks/agents/blob/main/AGENTS.md — every rule there applies, cited by ID (`SECRETS`, `TENANT`, `DB`, `MUTATION`, `SERVER`, `VERIFY`, `TDD`, `GIT`, `DOCS`, `AI`, `INJECTION`, `SESSION`, `PII`, `UI`, `STANDARD`, …). Project rules, overrides, and the build loop are in [AGENTS.md](./AGENTS.md). **This doc is the single home of the project "done bar"** — the Verification Bar, the focused per-surface checklists, and the Failure Mode Registry. It restates global rules only as one-line ID references.

This is the quality bar a change must clear before it is "done," adapted from the PRD's correctness/trust/security gates (PRD §13, §14, §16, §17, §18, §20, §22, §25, §26, §27). **Nothing merges to `main` with a red gate.** Evidence before assertions (`VERIFY`).

**How to use.** Run the [Verification Bar](#verification-bar) commands and paste their output. Walk [Tier 1 — GATE](#tier-1--gate-every-commit) and [Tier 2 — QUALITY](#tier-2--quality-every-pr-merge). For touched surfaces, complete the matching checklist: [Engine & Excel](#engine--excel-contract-when-engine-or-xlsx-touched), [Mutations](#mutation-safety-quad-every-patchpost-endpoint), [Frontend & a11y](#frontend--accessibility-when-ui-touched), [LLM & Research](#llm--research-grounding-when-researchnarrative-touched), [Security](#security-checks-every-change), [Ops](#deploy--ops-health-before-promote).

> **Load-bearing context.** M1 is an **engine rewrite, not a wire-up** — the as-built `generate_projection.py` is annual-only, midpoints Year-2, has fixed-dollar supplies, no monthly cash-flow / decision metrics / override DAG, and emits `#DIV/0!`-prone formulas. The prototype's `support.js` client math is **forbidden in production** (`SERVER`/PRD §13). The full gap table is single-sourced in [AGENTS.md](./AGENTS.md) → [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md). These two facts drive most gates below.

---

## Verification Bar

A change is not "done" until these commands are run and their literal output is shown in the **same message** that claims completion (`VERIFY` — a bare HTTP 200, "tests should pass," or "I fixed it" is not proof).

| Proof | Command | Required output |
|---|---|---|
| Backend tests green | `pytest -q` | `0 failed`, exit 0 |
| Frontend tests green | `npm test -- --run` | `0 failed`, exit 0 |
| Engine golden + 3-way reconcile | `pytest -q engine/tests/test_golden_gate.py` | all golden fixtures pass; deltas `< $0.50` / `< 0.1pp` |
| Excel formula-error gate | `python reference/thrift-store-projections-skill/scripts/recalc.py "<exported>.xlsx"` | `{"status":"success","total_errors":0}` (parse JSON; `status=="success"` AND `total_errors==0`, fail closed on `{"error":...}`) |
| Test:code ratio (HARD) | `python scripts/ratio.py` | `> 1.3` on PR diff **and** repo-wide |
| Lint / types | `ruff check . && mypy app engine` · `npm run lint && npm run typecheck` | clean |
| Boot-refuse config | `python -c "import app.config as c; c.validate_required()"` (prod env) | refuses with the missing-secret name, or passes |
| Deploy health (post-promote) | `curl -s $URL/api/health` | JSON shows the **new build SHA**, `db: ok`, `litestream: replicating` |

Golden reconciliation compares three artifacts that must agree (PRD §13/§18): server `compute()` result == values embedded in stored `computed_json` == LibreOffice recalc of the exported `.xlsx`. Run **with and without overrides**.

---

## Tier 1 — GATE (every commit)

- [ ] `pytest -q` and `npm test -- --run` pass, **zero failures**.
- [ ] On a feature branch, not `main` (`GIT`; docs-only `.md` may go direct).
- [ ] **No secrets** in code, logs, responses, or test fixtures (`SECRETS`). Project env keys: `GOOGLE_PLACES_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CENSUS_API_KEY`, `GITHUB_TOKEN`, `CRM_API_KEY`, `LITESTREAM_*`. `Authorization` headers and URL fragments are **never** logged (PRD §20).
- [ ] **Server is the only math authority** (`SERVER`/PRD §13). No client-side computation of any projection figure; no `calc*`/`scenario` ported from `support.js`. New numbers come from the server's `computed_json` only.
- [ ] **Every mutation** carries the [Mutation Safety Quad](#mutation-safety-quad-every-patchpost-endpoint).
- [ ] If the **engine or `.xlsx` builder** was touched: golden tests + LibreOffice recalc pass **with and without** overrides, zero formula errors.
- [ ] TDD honored — a red test was committed and watched-fail before production code; bugfixes ship a reproducing regression test (`TDD`).

## Tier 2 — QUALITY (every PR merge)

- [ ] **HARD GATE — test:code ratio > 1.3 (measured, CI-blocking).** `scripts/ratio.py` reports test-LOC / code-LOC `> 1.3` on **both** the PR diff (added lines via `git diff` numstat, bucketed by the path map) **and** repo-wide (code = `engine/**` + `app/**` minus tests; test = `engine/tests/**`, `app/tests/**`, `frontend/**/*.{test,spec}.*`, `e2e/**`; excluded = migrations, generated fixtures, golden `.xlsx`, vendored, `__init__`). Paired with **`engine/**` branch coverage ≥ 90%** so the ratio can't be gamed by trivial assertions. *(This is the project's measured floor for the global `TDD` ≥1.3× rule — see [DECISIONS.md](./DECISIONS.md).)*
- [ ] **End-to-end browser tests pass (extensive, not a single happy path).** Playwright E2E in `e2e/` covers at minimum: create→compute→decision-banner→autosave→reopen-by-owner-token→`.xlsx` export; edit/override→recompute→409-conflict; a read-only `view_slug` cannot edit; feedback files a redacted issue; the AI-disabled path. Headless in CI at **1440 / 768 / 375** against the Appendix-D stress dataset, screenshots archived.
- [ ] **Error handling:** every external/IO call retries-with-backoff, degrades gracefully, or re-raises with context. **Zero silent failures.** Each new failure mode gets a [Failure Mode Registry](#failure-mode-registry) row.
- [ ] **Threat model for new endpoints** recorded in the PR (who calls it, what they receive, what they can change, rate-limit cost) — `STANDARD`/`SESSION`.
- [ ] **Docs are code** (`DOCS`). A PR touching the engine, the compute view-model, the API contract, or the schema updates the matching sibling doc in the **same PR** (`ENGINE_CONTRACT.md` / `API_SPEC.md` / `DATA_MODEL.md`); the Regression registry in [AGENTS.md](./AGENTS.md) is updated when a new trap is closed.
- [ ] **YAGNI / milestone fence respected** (`STANDARD`). No M3+ feature pulled into an earlier milestone; M2 stays the smallest shippable loop (PRD §28; see [BUILD_PLAN.md](./BUILD_PLAN.md)).
- [ ] Panel/code review (portfolio Panel review) on the most-capable model for engine-math and security PRs; whole-branch review at each milestone close ([AGENTS.md](./AGENTS.md)).
- [ ] `model_version` **and** `compute_schema_version` are stamped wherever `computed_json` is written; a math/shape change that should not silently recompute stored projections is verified to **not** recompute on read (PRD §13).

---

## Mutation Safety Quad (every PATCH/POST endpoint)

Project instantiation of `MUTATION` + `TENANT` in the capability-token model. Every state-mutating handler (`PATCH /api/projections/{slug}`, `POST …/duplicate|upgrade-model|rotate-tokens|trash|restore|evidence|revisions/{id}/restore`, `POST /api/research|feedback|intent|actuals`, projection create — PRD §25) MUST have all four, **each with a test**:

1. **Bearer auth required.** `Authorization: Bearer <token>` → owner/edit/role via **SHA-256 hash + `hmac.compare_digest`** (constant-time). Unauthenticated → 401. No cookies (no CSRF).
2. **Owner-scope isolation.** Lists/reads owner-scoped, **never global**; test asserts owner A cannot touch owner B's projection.
3. **Optimistic concurrency.** Requires `If-Match: <version>`; `UPDATE … SET version=version+1 … WHERE id=? AND version=?`; a 0-row result returns **HTTP 409** with `{error, current_version, current_state}` (Reload / Overwrite / Save-as-copy — PRD §19.4/§24/§25). New version returned in body + `ETag`. Real, tested, not cosmetic.
4. **Negative / abuse path.** Per-IP **and** per-token rate limit + a test of the rejection path. Cost-amplifying endpoints capped.

Mutations also have a **transaction boundary** and write **one revision snapshot per autosave settle** (PRD §19.3/§24) with `actor_token_hash` recorded. Derived rows / totals / KPIs are **non-pinnable** — rejected at the API boundary, not just hidden in the UI (PRD §14).

## Engine & Excel Contract (when engine or `.xlsx` touched)

Authoritative formula spec in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md); this is the done-gate.

- [ ] **Pure compute core.** Math in `engine/compute.py` with **zero `openpyxl`/`python-docx` imports**; `xlsx.py`/`packet.py` consume its output. No web request imports an Excel/Word builder to get numbers.
- [ ] **Native view-model output.** `compute()` emits the Appendix-D contract verbatim — `reco`, `metrics`+reasons, `kpis[]`, `monthly[]`+`breakevenMonth`, `rows[]` (`class: input|computed|overridden|estimated`), `overrides[]`, `evidence[]`, `settings`, `flags`, `model_version`, `compute_schema_version`. Each numeric field carries `{raw, display}` (one rounding authority: whole dollars / 0.1%).
- [ ] **New/changed model lines implemented and fixtured** (absent from the old engine): three **explicit** per-year shares (no `AVERAGE`/midpoint — §7.1); **Marketing & outreach** = `total_rev × marketing_pct`; **Supplies & processing** = `total_rev × supplies_pct` (replaces the fixed $3,700); **annual rent escalator** `rent_y1 × (1+escalator)^(y-1)` Y2–Y3; **$25k reserve buffer** into capital-required.
- [ ] **Monthly-first consistency.** Year-1 annual totals are a **roll-up of M0–M12**, equal to the sum of the 12 monthly rows to the penny (golden asserts `annual == sum(monthly)`). The `.xlsx` Year-1 P&L column **references** the monthly roll-up cells; never recomputes independently (PRD §18).
- [ ] **Decision metrics computed in the core and asserted by golden tests:** break-even month; **startup capital required** = Σ startup + |peak cumulative cash shortfall| + reserve buffer; first-year cash gap = most-negative cumulative cash M0–M12; cash runway; payback = startup ÷ Y1 net (N/A guard); sensitivity (base/downside/upside ±25% on rent & donations); rules-based **recommendation** with reasons (PRD §12).
- [ ] **Override DAG.** Topological `resolve(node) = pin.value if pinned else f(resolve(parents))`. **No back-solve** (orphaned upstream → `stale` flag). Keys `"{node}#{year}"` (PRD §14/§24). Tests: pin component → total refoots via formula; pin then reset → returns to computed; pin a derived/total/KPI → **rejected**; pin orphaned upstream → stale flag. Each test also exports an `.xlsx` that recalcs clean.
- [ ] **Excel cell-class contract** (PRD §18): inputs = hard-coded **blue**; computed = **live formula**; overridden component = hard-coded **orange** + comment `"Manual override — calc was =<formula> → $X; set to $Y on <date>"`; totals/net/margin/KPIs = **always formulas** over components (foots even with overrides); N/A = blank + comment, **never** `#DIV/0!`.
- [ ] **Edge-case math discipline** (PRD §12.4): compute in cents/`Decimal`, round only at display (document which side rounds for the `< $0.50` tolerance). Explicit `null` + `flags` for every N/A: revenue=0 → margins & per-unit KPIs N/A; Y1 net ≤ 0 → payback `"N/A — no Year 1 profit"`; Y1 revenue=0 → CAGR N/A; negatives in parentheses + error color; 0 sq ft blocked at input. Every divided Excel cell guarded `IF(denom=0,"",num/denom)`.
- [ ] **Named golden fixtures pass** (single-sourced in [AGENTS.md](./AGENTS.md)): **House of Hope canonical** (6/8/10%, **labor 60%** owner default, Y1 rev ≈ $426,911) **plus its 40% design-parity twin** (margin ≈ 11%, capital ≈ $277,990, break-even ≈ month 5, reco=proceed — design-QA only); **Aggressive flagged** (15/20/25% → §12.2 guardrail + justification note); **Grace Mission loss case** (Y1 net `($12,400)`, payback N/A, $14/sqft, one overridden Payroll cell). Plus edge fixtures: revenue=0, Y1 net ≤ 0, a sensitivity downside.
- [ ] **Resolved defaults pinned, not floating** (see [AGENTS.md](./AGENTS.md) / [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md)): labor % = **60%** (owner decision; canonical golden at 60%, 40% kept as design-parity), basket $17.08, escalator `(1+e)^(y-1)`, marketing 3.75%, supplies 5%, reserve $25k, donations/hh 3.
- [ ] **Three-way reconcile is CI-blocking** (the `GOLDEN` rule), run **with and without overrides**, tolerance `< $0.50` / `< 0.1pp`, `total_errors == 0`. CI image **pins the `soffice` version** and ensures `timeout`/`gtimeout` is present; the gate fails closed on any `{"error":...}`.

## Frontend & Accessibility (when UI touched)

WCAG-AA baseline (contrast, tap targets, keyboard-reachable, reduced-motion, VoiceOver order, mobile-first) per global `UI` — not restated. Project mechanics:

- [ ] **No client math authority.** Edit loop: cell edit → debounce (~300–400ms) → optimistic **pending** render → `PATCH` (`Bearer` + `If-Match`) → reconcile to server `computed_json`. The optimistic preview is a visual pending state only, never a second math surface (PRD §13).
- [ ] **Stale responses dropped by version**; request cancellation so dense-table editing doesn't flicker. `saveLabel` state machine: "All changes saved" / "Saving…" / "Save failed — retry."
- [ ] **409 conflict UX** wired to the save-conflict modal (Reload latest / Overwrite / Save as copy); client tracks the server `version`, never silently overwrites (PRD §19.4).
- [ ] **Override cell state machine** (calculated → editing → overridden, auto-clears the pin within $0.50 of calc) + tap popover (calc vs override + note) + Override Inspector drawer (node·year, calculated strikethrough, override, note, `pinnedDate`, `affected[]`, per-pin Reset + Reset-all, "prefer driver-level edits" banner). `affected[]`/orphaned-upstream hints come from the server, not faked client-side (PRD §14).
- [ ] **Two-layer design tokens.** `brand-*` (e.g. `--brand-primary #35644f`) vs `semantic-*` (`--success #257648`, `--warning #b45309`, `--error #dc2626`, `--override #cbb7a9`). Meaning never depends on brand: negative profit = error, low-confidence = warning, overridden = override-tan. The API emits a `reco.tag` **enum** (`proceed|revise|find_cheaper_rent|raise_cash|delay|do_not_proceed`); the **client** maps enum → token (API never hardcodes hex).
- [ ] **N/A & negatives render explicitly** — parentheses + error color for negatives; "N/A" for null KPIs; never `#DIV/0!`, `NaN`, or `Infinity` on screen (PRD §12.4).
- [ ] **Tabular figures:** `font-variant-numeric: tabular-nums`, right-aligned money, consistent decimals across UI / `.xlsx` / packet.
- [ ] **Responsive screenshots at 1440 / 768 / 375** populated with the **stress dataset** (long org name, negative Y1 net, low-confidence rent, overridden Payroll cell, aggressive flag) attached to the PR. 768 stacks with sticky first column + horizontal scroll; 375 uses the per-year stacked editor (no hover, reachable reset).
- [ ] **Degraded states are first-class** and tested: AI opt-out, rent-research-failed (manual), low-confidence rent, location-not-found, offline/save-failure (retry + local draft), stale-narrative banner + Regenerate, read-only edit attempt (PRD §19.4/§21).
- [ ] **Wizard draft recovery:** local draft after step 1, **no server record until Generate**; three explicit per-year share fields (no auto-midpoint); live share helper; research failure never blocks (manual entry) (PRD §19.2).

## LLM & Research Grounding (when research/narrative touched)

Umbrella principles per `AI` + `INJECTION` (untrusted input is data; redact PII; provider fallback; opt-out). These are the project's hard server-side **validators with adversarial tests**, not prompt politeness (PRD §16/§17):

- [ ] **Retrieval-grounded research.** Server fetches and stores candidate sources (`url`, `title`, `fetch_date`, `extracted_text`, `source_date`, `source_tier`); the LLM extracts **only** from provided snippets. **Test:** a citation URL not in the server-fetched set is **rejected**.
- [ ] **Prompt-injection defense.** Snippet text wrapped as untrusted **data**; injection markers ("ignore previous instructions", "system:") stripped; inputs token-capped. **Test:** injected web instructions are treated as data and ignored.
- [ ] **Numeric grounding.** Every figure in narrative prose must exist in `computed_json`/approved facts; post-generation validation **rejects** any unverified figure. **Test:** a hallucinated figure forces rejection. Rent is stated as estimate/range, never fact.
- [ ] **SSRF hardening** of the fetcher: block private/link-local/loopback/metadata ranges (`10/8`, `127/8`, `169.254/16`, `*.railway.internal`, `169.254.169.254`) and disallow redirects into them. Test asserts a private-target URL is refused.
- [ ] **Stale-narrative handling.** `computed_hash` stored at generation; on figure change show "Out of date" + diff + Regenerate; **never** auto-overwrite user-edited prose (`edited` flag respected).
- [ ] **AI opt-out works end-to-end.** A test runs the full create → compute → save → `.xlsx` flow with **all AI keys unset** and succeeds (manual rent, no narrative) (PRD §21).
- [ ] **Provider routing & cost control** (`AI`). Anthropic primary → OpenAI fallback; research/narrative cached; regenerations capped per IP+token. Compute (`< 50 ms` p95, excluding research/LLM) works fully with AI disabled.

## Security Checks (every change)

Authoritative detail in [SECURITY.md](./SECURITY.md) (canonical on its topic). Generic `SECRETS` / `SESSION` / `PII` baselines are not restated. Project done-gate:

- [ ] **No secrets client-side** (`SECRETS`). Owner bearer in `localStorage`; edit/recovery secrets in the URL **fragment** only (never path/query/log), scrubbed after read (`searchParams.delete()` + `replaceState()`).
- [ ] **Capability tokens** (`Override SESSION`): CSPRNG (`secrets.token_urlsafe`), owner ≥ 256-bit, `view_slug` ≥ 128-bit; stored **hashed** (SHA-256), compared `hmac.compare_digest`; `view_slug` plaintext lookup key only. `rotate-tokens` regenerates owner/edit/view/role atomically + writes an audit event.
- [ ] **Stored-XSS closed** (`INJECTION`). Narrative `body_md` and any user rich text / evidence fields server-side **allowlist-sanitized** (e.g. `bleach`) before storage and render. (Stored XSS = bearer-token theft = full takeover.)
- [ ] **CSP from day one** (greenfield SPA): `default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; connect-src 'self' api.anthropic.com api.openai.com`. The browser never talks to Places/Census/GitHub/CRM directly. **CORS** locked to the app origin. `X-Robots-Tag: noindex` + robots disallow on every response.
- [ ] **Rate limits per IP and per token** on abuse-prone endpoints: `POST /api/research`, `…/narrative:regenerate`, `/api/feedback`, `/api/intent`, projection create.
- [ ] **Feedback redaction (top data-leak risk).** CI test asserts the GitHub-issue payload contains **no** `view_slug`, edit token, resolvable link, or financial field — only a random `support_id` + non-sensitive context. See [IDEA_FAB.md](./IDEA_FAB.md).
- [ ] **Engine IO is server-controlled.** `.xlsx`/`.docx` generated to a per-request temp dir from a **server-controlled** output path (never user-supplied), streamed, then cleaned up. No path traversal via `org_name`/output dir; raw user JSON never round-tripped through the filesystem.
- [ ] **Attached-evidence upload hardening:** type/size limits; no executable or script-bearing SVG stored; served with `Content-Disposition` + a non-executable content-type (ideally off-origin).
- [ ] **Boot-refuse config validation in production** (`SECRETS`; the `timpager` regression #21), single-source-of-truth requirements module, **no fallback chains**. Required in prod: `DB_PATH=/data/projections.db`, `GOOGLE_PLACES_API_KEY`, `CENSUS_API_KEY`, at-least-one AI provider (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`), `LITESTREAM_*`. Optional/graceful-degrade: `GITHUB_TOKEN`+`GITHUB_REPO`, `CRM_API_KEY`.
- [ ] **Terms acceptance** required before export/share; AI-disclosure UI when data is sent to providers; documented provider/app retention + backup purge limits (PRD §21).
- [ ] **Audit log** records mutations, token rotations, exports, and share-link access with `actor_token_hash` (`PII`/PRD §20).
- [ ] `/security-review` completed for any change touching auth, tokens, sanitization, the research fetcher, or secrets handling.

## Deploy & Ops Health (before promote)

Authoritative detail in [OPS_RUNBOOK.md](./OPS_RUNBOOK.md) (canonical on its topic). Generic `DB` (additive migrations) and `GIT` (new-build-SHA promote check) not restated. Project deltas:

- [ ] **DB on the durable volume.** `DB_PATH=/data/projections.db` on the Railway volume at `/data` (never `/app`, never ephemeral). WAL + `busy_timeout` + serialized single-writer.
- [ ] **Litestream replicates `/data/projections.db`** (not an `/app` path — do not copy `timpager`'s `litestream.yml` bug). Replication verified **live** (health check or boot assertion), not silently off.
- [ ] **Restore drill exercised**, not just documented: `restore-db.sh` restores from object storage into a throwaway volume; `PRAGMA integrity_check` passes and `computed_json` round-trips. RPO (near-zero) / RTO (~2 min) recorded.
- [ ] **Migrations additive-only** (`DB`), run **before** schema use, with a pre-migration Litestream checkpoint. The post-launch `actuals` table schema exists so it is not a later migration (PRD §24); no actuals UI in v1.
- [ ] **`railway.toml`** mirrors the reference shape: dockerfile builder, `healthcheckPath = "/api/health"`, `restartPolicyType = "always"`, `numReplicas = 1`, `sleepApplication = false`, volume at `/data`. The build image **pins the LibreOffice version** for the recalc gate.
- [ ] **Promote verifies the new build** (`GIT`/`VERIFY`): not "done" until `GET /api/health` returns the **new build SHA** plus `db: ok` and `litestream: replicating`.
- [ ] **Incident behavior:** Anthropic/OpenAI down → narrative 503, compute + `.xlsx` still work; Places/Census down → manual entry; DB full → grow volume; cold start → WAL recovery.

---

## Failure Mode Registry

Document every failure mode **before** coding. A row with **Rescued? = N AND Tested? = N is CRITICAL — never merge.** Add a row for each new external/IO/edge surface.

| Mode | Rescued? | User sees | Tested? |
|---|---|---|---|
| Provider 429 / timeout (Anthropic/OpenAI) | Y | "Narrative unavailable — compute & .xlsx still work" (503 on narrative only) | Y |
| LibreOffice recalc cell-mismatch (> $0.50 / formula error) | Y | CI blocks; never ships | Y |
| Stale-version edit (lost-update) | Y | 409 → Reload / Overwrite / Save-as-copy | Y |
| Offline / save failure | Y | "Save failed — retry"; local draft retained | Y |
| Unfetched citation returned by LLM | Y | Citation dropped; not shown / not in packet | Y |
| Hallucinated narrative figure (not in `computed_json`) | Y | Generation rejected; "Out of date — Regenerate" | Y |
| Injected web instructions in research snippet | Y | Ignored (treated as data); facts only extracted | Y |
| SSRF: source URL targets private/metadata range | Y | Source refused; no fetch | Y |
| Location not found | Y | Manual households entry | Y |
| Rent research failed / low confidence | Y | Manual rent / "verify locally" warning badge | Y |
| AI opt-out (all AI keys unset) | Y | Full compute + save + .xlsx; no narrative | Y |
| Revenue = 0 / Y1 net ≤ 0 (N/A paths) | Y | "N/A" + parentheses for negatives; no `#DIV/0!` | Y |
| Owner/edit token loss (no login) | N (structural) | One-time recovery code at create; staff **cannot** recover access | Y (expectation copy) |
| DB volume full | Y | Grow volume (runbook); writes serialized, no corruption | Y |

---

## Milestone-Linked Gates & Top Damage Risks

Both are **single-sourced in [AGENTS.md](./AGENTS.md)** — the [Milestone gate map](./AGENTS.md#milestone-gate-map-the-single-home--dodcontributing-point-here) (M-1…M7 entry gates, required lenses, tests, ops deliverable) and the [Top damage risks](./AGENTS.md#top-damage-risks-the-single-home--dod-references-this) list. M1 is the keystone — the golden gate is CI-blocking and built **before** feature breadth.

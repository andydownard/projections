# Thrift Store Projection Web App

> **Repo:** `rallytasks/projections` · **Owner:** Andy Downard · **Status:** **Built & deployed (engine 2.6.0; iterative feedback phase)** · **Source PRD:** v3.1 (design-aligned)

A web app that helps a nonprofit operator **decide whether and how to launch a thrift store**, and produce a board/funder-ready case for it. From a few inputs it researches the local trade area and a market-rent estimate, builds a **monthly launch cash-flow** plus a **3-year projection** with KPIs and **decision outputs** -- break-even month, startup capital required, first-year cash gap, and a rules-based go/no-go recommendation -- then exports a cited **Board Packet** and a formula-driven `.xlsx`. Every number shows its evidence and confidence. (PRD §1.)

This is a **decision and funding tool, not just a calculator.** The single customer is a small nonprofit or church-backed operator planning their **first** store in the next 3-12 months, where the buyer is the board/treasurer/ED and the user is *not* a finance expert (PRD §2). The product's differentiator over DIY spreadsheets and consultants is the trust/evidence layer (§15-16) plus the three things that must ship together to be credible: the **monthly cash-flow**, the **decision metrics**, and the **explainable recommendation**.

---

## Current status: Built and deployed

The application is **live at `projections.thriftly.com`** on Railway (thriftly.com project). The engine runs at `MODEL_VERSION 2.6.0` / `COMPUTE_SCHEMA 1.5.0`. The project is in an iterative owner-feedback phase: the free create-compute-decision-export loop ships; the paid/reviewed path and demand-validation gate for that path remain open (see [AGENTS.md](./AGENTS.md) and PRD §3/§28).

These documents are the **live engineering contract** -- not a build-readiness plan. Where this README and a sibling doc disagree, defer to the PRD and the named doc, and fix the drift in the same PR ("Docs Are Code").

The engine in `engine/` (`MODEL_VERSION 2.6.0`) is the one math authority. `reference/.../generate_projection.py` is the calibration golden only. The M1 rewrite is complete -- see [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) for the live formula spec.

---

## Documentation map

Every build document, with a one-line purpose. Start with **[CLAUDE.md](./CLAUDE.md)** (or [AGENTS.md](./AGENTS.md)) and **[BUILD_PLAN.md](./BUILD_PLAN.md)**.

| Doc | Purpose |
|---|---|
| **[README.md](./README.md)** | This file -- product overview, status, doc map, tech stack. |
| **[BUILD_PLAN.md](./BUILD_PLAN.md)** | The milestone plan (M-1...M7), entry gates, per-milestone deliverables, and the credibility map. |
| **[ARCHITECTURE.md](./ARCHITECTURE.md)** | System shape: FastAPI app layout, pure compute core vs. renderers, the data-access `Store` interface, endpoint-to-module map, versioning/upgrade lifecycle. |
| **[ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md)** | The math authority: live formula spec, defaults, override-DAG resolution, the Excel cell contract, and the golden-test gate. |
| **[DATA_MODEL.md](./DATA_MODEL.md)** | SQLite schema (projections, revisions, evidence, narratives, research_cache, feedback, actuals), the `computed_json`/`overrides_json` shapes, and Postgres-portability rules. |
| **[API_SPEC.md](./API_SPEC.md)** | REST endpoints, the `If-Match`/`version` optimistic-concurrency contract, the 409 body, and the Appendix-D view-model as the shared request/response schema. |
| **[SECURITY.md](./SECURITY.md)** | Capability-token model, secret/env inventory + boot-refuse policy, prompt-injection/grounding rules, SSRF/XSS hardening, CSP/CORS/noindex, rate limits, feedback redaction. |
| **[OPS_RUNBOOK.md](./OPS_RUNBOOK.md)** | Railway deploy (thriftly.com project, `/data` volume), `railway.toml`/`litestream.yml`, restore drill + RPO/RTO, migration safety, incident-response table. |
| **[CLAUDE.md](./CLAUDE.md)** | Repo constitution (thin pointer to AGENTS.md): top damage risks, hard rules, vocabulary, the regression registry, and the doc index -- the agent's working memory. |
| **[AGENTS.md](./AGENTS.md)** | Full project rules and overrides, build loop, per-milestone plan-TDD-subagent-review-qa-ship pipeline, model-selection policy. |
| **[DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md)** | Tier-1 GATE and Tier-2 QUALITY bars, the mutation-safety quad, the failure-mode registry, and the exact verification commands that count as proof. |
| **[CONTRIBUTING.md](./CONTRIBUTING.md)** | How to set up, branch, test, and open a PR; the "Docs Are Code" rule (engine/API/schema changes update the matching doc in the same PR). |
| **[IDEA_FAB.md](./IDEA_FAB.md)** | The redacted feedback ("idea fab") + intent loop: bugs to GitHub with a random support ID and no projection link; intent to CRM. |
| **[docs/archive/README.md](./docs/archive/README.md)** | Index of historical/superseded docs (shipped or abandoned planning artifacts). |

---

## Tech stack at a glance

| Layer | Choice | Notes |
|---|---|---|
| Frontend | **React 18 + TypeScript + Vite** | TanStack Query for the server-owned `computed_json` cache; thin local UI store (Zustand/useReducer) for transient state. Hand-rolled SVG charts. **No client-side math** (PRD §13). |
| Backend | **Python FastAPI** | Stateless, deterministic **pure compute core** decoupled from the `.xlsx`/`.docx` renderers; LLM/research as bounded async services off the compute hot path. |
| Math engine | **Python `engine/` (MODEL_VERSION 2.6.0)** | Single, version-locked math authority. Emits the Appendix-D view-model as native output. Golden + LibreOffice reconciliation gate (< $0.50 / 0.1pp, zero formula errors). |
| Database | **SQLite (WAL) + Litestream** | Durable Railway volume; `busy_timeout`, serialized writes. Data-access behind a `Store` interface with a documented **Postgres** path. |
| Access | **Capability tokens, no login** | Owner bearer token (>=256-bit) in `localStorage`; `view_slug` (>=128-bit) lookup key; edit/role secrets via URL fragment. No cookies -- no CSRF. |
| AI | **Anthropic primary, OpenAI fallback** | Retrieval-grounded rent research (extract-only); post-generation numeric grounding for narrative. Fully optional -- AI opt-out still computes + exports `.xlsx`. |
| External services | Google Places · US Census · Anthropic · OpenAI · GitHub · CRM | All secrets server-side only. |
| Deploy | **Railway (thriftly.com project)** | Docker; volume mounted at **`/data`**, `DB_PATH=/data/projections.db`; healthcheck `/api/health`; `numReplicas=1`. See [Deploy target](#deploy-target). |
| Compute budget | **< 50 ms** p95 server compute | Excludes research/LLM. Debounced server compute + optimistic-pending UI + reconcile to server-authoritative `computed_json`. |

---

## The `reference/` folder

The product's source-of-truth inputs live under `projections/reference/`. Read these before forming conclusions -- they hold the exact numbers, formulas, and design tokens the build must honor.

| Path | What it is |
|---|---|
| `reference/PRD.md` | The adversarially-revised PRD (v3.1) -- **authoritative requirements.** ICP §2, decision outputs §4/§12, monthly cash-flow §10, override DAG §14, trust/research §15-17, Excel contract §18, security §20, milestones §28, and **Appendix D** (committed brand tokens + the view-model contract). |
| `reference/DESIGN_PROMPT.md` | The design brief: finance-grade, table-first, dense, desktop-first 1440 with required 768/375 behavior, AA accessibility, and the named stress/sample datasets. |
| `reference/thrift-store-projections-skill/SKILL.md` | The original engine skill -- how the bottom-up donor-market-share model connects, plus the mandatory recalc step. |
| `reference/thrift-store-projections-skill/reference/methodology.md` | Formula-by-formula method, default constants, and the Longview, TX calibration (~31,800 households, ~7% established share, ~$83 resale value/donation). |
| `reference/thrift-store-projections-skill/scripts/generate_projection.py` | The calibration golden (original annual-only seed engine). The live engine is `engine/`; this script exists only to verify the driver chain via the golden gate. |
| `reference/thrift-store-projections-skill/scripts/recalc.py` | LibreOffice headless recalc + formula-error check. Reused directly as the Excel half of the golden gate. |
| `reference/thrift-store-projections-skill/examples/house_of_hope.json` | A worked config (House of Hope, Longview TX) -- the calibration golden. |

### Engine history note (M1 rewrite is complete)

`generate_projection.py` was the original annual-only seed -- it implemented roughly 30% of v1 requirements (no monthly cash-flow, no decision metrics, no override DAG, unguarded divisions). The M1 rewrite into `engine/` is **complete**. The gap table in [AGENTS.md](./AGENTS.md) and [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) shows all rows as DONE. The defaults that were open before M1 (labor %, basket value, escalator semantics) are resolved -- see [DECISIONS.md](./DECISIONS.md) and [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) §1.

---

## Deploy target

Railway service inside the **thriftly.com** project. Docker builder, healthcheck at `/api/health`, `numReplicas=1`, `restartPolicyType="always"`:

- **Durable DB on a volume.** Volume mounted at **`/data`**; **`DB_PATH=/data/projections.db`**. Do **not** put the DB on the ephemeral container FS.
- **Litestream replicates the durable path.** `litestream.yml` replicates **`/data/projections.db`** to object storage. (Note: timpager's config pointed at `/app/timpager.db` -- that bug is not repeated here.) Replication is verifiably live; restore drill and RPO/RTO are in [OPS_RUNBOOK.md](./OPS_RUNBOOK.md).

Boot refuses to start in production if required secrets are unset, with no fallback chains: `DB_PATH`, `GOOGLE_PLACES_API_KEY`, `CENSUS_API_KEY`, `ANTHROPIC_API_KEY` (plus at-least-one AI provider). Optional/graceful-degrade: `OPENAI_API_KEY`, `GITHUB_TOKEN`+`GITHUB_REPO`, `CRM_API_KEY`, `LITESTREAM_*`. Full table and the restore drill are in [SECURITY.md](./SECURITY.md) and [OPS_RUNBOOK.md](./OPS_RUNBOOK.md).

---

## The idea-fab feedback loop

Feedback is split so **no resolvable projection link or financial data ever reaches GitHub** (PRD §22):

- **Bugs to GitHub** as issues carrying only non-sensitive context (route, app version, `model_version`, a random **support ID**, timestamp). The user sees the support ID; only server-side staff tooling resolves it to a projection. Safe even if the repo is public. A CI test asserts no `view_slug` / edit token / financial field ever appears in a GitHub payload.
- **Intent to CRM** -- optional email, role, reason, opening timeline, "request expert review," and follow-up consent. This is the discovery engine, not a support afterthought.

Details and the redaction test live in [IDEA_FAB.md](./IDEA_FAB.md).

---

*The PRD in `reference/PRD.md` is authoritative; where this README and a sibling doc disagree, defer to the PRD and the named doc, and fix the drift in the same PR ("Docs Are Code").*

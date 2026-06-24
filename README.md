# Thrift Store Projection Web App

> **Repo:** `rallytasks/projections` · **Owner:** Andy Downard · **Status:** **SCAFFOLDED — docs only, not built** · **Source PRD:** v3.1 (design-aligned)

A web app that helps a nonprofit operator **decide whether and how to launch a thrift store**, and produce a board/funder-ready case for it. From a few inputs it researches the local trade area and a market-rent estimate, builds a **monthly launch cash-flow** plus a **3-year projection** with KPIs and **decision outputs** — break-even month, startup capital required, first-year cash gap, and a rules-based go/no-go recommendation — then exports a cited **Board Packet** and a formula-driven `.xlsx`. Every number shows its evidence and confidence. (PRD §1.)

This is a **decision and funding tool, not just a calculator.** The single customer is a small nonprofit or church-backed operator planning their **first** store in the next 3–12 months, where the buyer is the board/treasurer/ED and the user is *not* a finance expert (PRD §2). The product's differentiator over DIY spreadsheets and consultants is the trust/evidence layer (§15–16) plus the three things that must ship together to be credible: the **monthly cash-flow**, the **decision metrics**, and the **explainable recommendation**.

---

## Current status: SCAFFOLDED

**Nothing here is built yet.** This repository currently contains **specification and build-process documents only**. There is no application code, no database, no deployed service. These docs exist to make the product **ready to build** under a disciplined agent workflow — they define the requirements, the architecture, the math contract, the data model, the API, the security posture, the ops runbook, and the milestone plan.

Before any heavy build, the product is gated behind **M-1 pre-build validation** (PRD §28): 20 ICP interviews · 10 manually produced projections · 5 board/funder shares · 3 paid-or-sales-qualified conversions. This gate is a hard precondition documented in [AGENTS.md](./AGENTS.md), not a coding milestone — an eager agent must not skip it.

> **The #1 thing to understand before building:** the PRD repeatedly calls the existing Python engine (`reference/.../generate_projection.py`) "the single math authority," but that script implements the **old** model. M1 is an **engine rewrite, not a wire-up** — see the [Engine reality check](#engine-reality-check) below and the gap table in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md).

---

## Documentation map

Every build document, with a one-line purpose. Start with **[CLAUDE.md](./CLAUDE.md)** and **[BUILD_PLAN.md](./BUILD_PLAN.md)** (see [How to start building](#how-to-start-building)).

| Doc | Purpose |
|---|---|
| **[README.md](./README.md)** | This file — product overview, status, doc map, tech stack, how to start. |
| **[BUILD_PLAN.md](./BUILD_PLAN.md)** | The milestone plan (M-1…M7), entry gates, per-milestone deliverables, and the credibility map (which milestone first makes the product board-defensible). |
| **[ARCHITECTURE.md](./ARCHITECTURE.md)** | System shape: FastAPI app layout, pure compute core vs. renderers, the data-access `Store` interface, endpoint→module map, versioning/upgrade lifecycle. |
| **[ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md)** | The math authority: frozen formula & defaults appendix, the engine gap table (EXISTS / REWRITE / NEW), override-DAG resolution, the Excel cell contract, and the golden-test gate. |
| **[DATA_MODEL.md](./DATA_MODEL.md)** | SQLite schema (projections, revisions, evidence, narratives, research_cache, feedback, actuals), the `computed_json`/`overrides_json` shapes, and Postgres-portability rules. |
| **[API_SPEC.md](./API_SPEC.md)** | REST endpoints, the `If-Match`/`version` optimistic-concurrency contract, the 409 body, and the Appendix-D view-model as the shared request/response schema. |
| **[SECURITY.md](./SECURITY.md)** | Capability-token model, secret/env inventory + boot-refuse policy, prompt-injection/grounding rules, SSRF/XSS hardening, CSP/CORS/noindex, rate limits, feedback redaction. |
| **[OPS_RUNBOOK.md](./OPS_RUNBOOK.md)** | Railway deploy (thriftly.com project, `/data` volume), `railway.toml`/`litestream.yml`, restore drill + RPO/RTO, migration safety, incident-response table. |
| **[CLAUDE.md](./CLAUDE.md)** | Repo constitution: top damage risks, hard rules, vocabulary, the regression registry, and the doc index — the agent's working memory. |
| **[AGENTS.md](./AGENTS.md)** | The build loop: per-milestone plan→TDD→subagent→review→qa→ship pipeline, subagent model-selection policy, and the M-1 validation precondition. |
| **[DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md)** | Tier-1 GATE and Tier-2 QUALITY bars, the mutation-safety quad, the failure-mode registry, and the exact verification commands that count as proof. |
| **[CONTRIBUTING.md](./CONTRIBUTING.md)** | How to set up, branch, test, and open a PR; the "Docs Are Code" rule (engine/API/schema changes update the matching doc in the same PR). |
| **[IDEA_FAB.md](./IDEA_FAB.md)** | The redacted feedback ("idea fab") + intent loop: bugs→GitHub with a random support ID and no projection link; intent→CRM. |

---

## Tech stack at a glance

| Layer | Choice | Notes |
|---|---|---|
| Frontend | **React 18 + TypeScript + Vite** | TanStack Query for the server-owned `computed_json` cache; thin local UI store (Zustand/useReducer) for transient state. Hand-rolled SVG charts. **No client-side math** (PRD §13). |
| Backend | **Python FastAPI** | Stateless, deterministic **pure compute core** decoupled from the `.xlsx`/`.docx` renderers; LLM/research as bounded async services off the compute hot path. |
| Math engine | **Python (rewrite of the skill engine)** | Single, version-locked math authority. Emits the Appendix-D view-model as native output. Golden + LibreOffice reconciliation gate (< $0.50 / 0.1pp, zero formula errors). |
| Database | **SQLite (WAL) + Litestream** | Durable Railway volume; `busy_timeout`, serialized writes. Data-access behind a `Store` interface with a documented **Postgres** path. |
| Access | **Capability tokens, no login** | Owner bearer token (≥256-bit) in `localStorage`; `view_slug` (≥128-bit) lookup key; edit/role secrets via URL fragment. No cookies ⇒ no CSRF. |
| AI | **Anthropic primary, OpenAI fallback** | Retrieval-grounded rent research (extract-only); post-generation numeric grounding for narrative. Fully optional — AI opt-out still computes + exports `.xlsx`. |
| External services | Google Places · US Census · Anthropic · OpenAI · GitHub · CRM | All secrets server-side only. |
| Deploy | **Railway (thriftly.com project)** | Docker; volume mounted at **`/data`**, `DB_PATH=/data/projections.db`; healthcheck `/api/health`; `numReplicas=1`. See [Deploy target](#deploy-target). |
| Compute budget | **< 50 ms** p95 server compute | Excludes research/LLM. Debounced server compute + optimistic-pending UI + reconcile to server-authoritative `computed_json`. |

---

## The `reference/` folder

The product's source-of-truth inputs live under `projections/reference/`. **Read these before forming conclusions** — they hold the exact numbers, formulas, and design tokens the build must honor.

| Path | What it is |
|---|---|
| `reference/PRD.md` | The adversarially-revised PRD (v3.1) — **authoritative requirements.** ICP §2, decision outputs §4/§12, monthly cash-flow §10, override DAG §14, trust/research §15–17, Excel contract §18, security §20, milestones §28, and **Appendix D** (committed brand tokens + the view-model contract). |
| `reference/DESIGN_PROMPT.md` | The design brief: finance-grade, table-first, dense, desktop-first 1440 with required 768/375 behavior, AA accessibility, and the named stress/sample datasets. |
| `reference/thrift-store-projections-skill/SKILL.md` | The original engine skill — how the bottom-up donor-market-share model connects, plus the mandatory recalc step. |
| `reference/thrift-store-projections-skill/reference/methodology.md` | Formula-by-formula method, default constants, and the Longview, TX calibration (~31,800 households, ~7% established share, ~$83 resale value/donation). |
| `reference/thrift-store-projections-skill/scripts/generate_projection.py` | The **as-built** Python engine (compute + `.xlsx` + `.docx` builders, `DEFAULTS`). The seed of truth — **not** the finished authority (see below). |
| `reference/thrift-store-projections-skill/scripts/recalc.py` | LibreOffice headless recalc + formula-error check. **Reused directly** as the Excel half of the golden gate. |
| `reference/thrift-store-projections-skill/examples/house_of_hope.json` | A worked config (House of Hope, Longview TX) — the calibration golden. |

### Engine reality check

`generate_projection.py` implements the **old** model. Roughly 70% of what v1 needs does not exist in it yet. The headline gaps (full table in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md)):

- **Year-2 = midpoint** of Y1/Y3 (`compute()` line 65, `=AVERAGE(...)` line 209). The PRD §7.1 **kills the midpoint** — Y1/Y2/Y3 are three explicit inputs.
- **Fixed-dollar supplies** ($3,700, `DEFAULTS` line 44). The PRD §7.3 reclassifies this as **Supplies & processing = 5.0% of revenue**, and adds a **Marketing & outreach = 3.75% of revenue** line that does not exist at all.
- **No annual rent escalator** (§7.3 default 3.0%, Y2–Y3), **no $25k reserve buffer**, **no monthly M0–M12 cash-flow** (§10), **no decision metrics** (break-even month, startup capital required, first-year cash gap, runway, sensitivity, recommendation — §12), **no override/DAG**, and it returns positional tuples instead of the Appendix-D view-model.
- `build_xlsx` emits unguarded `=net/totrev` and `=startup/Y1net` divisions that produce `#DIV/0!` — a guaranteed failure of the §12.4/§18 N/A contract until rewritten.

**Conclusion:** keep the bottom-up driver chain and the blue-input/live-formula Excel styling as the seed; **extract & extend the formulas, rebuild the renderers.** Treat the legacy annual script only as a calibration golden.

### Defaults to resolve before M1

Three open product decisions block the golden fixtures and must be closed in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) (see PRD §7.3, Appendix D):

- **Labor % of revenue** — `DEFAULTS`/methodology say **60%**; the prototype and Appendix-D sample say **40%**. This swings net margin and the recommendation enormously. The chosen default must reproduce the Appendix-D headline numbers in a golden fixture (Y1 rev ~$426,911, capital ~$277,990, break-even ~month 5 reconcile at **40%**), or those prototype numbers must be corrected.
- **Average basket value** — $17 (§7.3) vs **$17.08** (Appendix-D sample).
- **Rent escalator semantics** — compounding `rent_y1 × (1+e)^(y-1)` vs linear; and whether it also escalates NNN opex / the lease-deposit startup line. Pick one and fixture it.

Confirmed defaults to carry forward: marketing **3.75%**, supplies **5.0%**, escalator **3.0%**, reserve buffer **$25,000**, donations/household/yr **3**, salvage **0.8%**, card fees **2.0%**, payroll tax **7.5%**.

---

## Deploy target

Railway service inside the **thriftly.com** project. The deploy shape mirrors the sibling `timpager` repo (Docker builder, healthcheck, `numReplicas=1`, `restartPolicyType="always"`), with two deliberate corrections:

- **Durable DB on a volume.** Volume mounted at **`/data`**; **`DB_PATH=/data/projections.db`**. Do **not** put the DB on the ephemeral container FS.
- **Litestream replicates the durable path.** `litestream.yml` must replicate **`/data/projections.db`** to object storage. Note: timpager's `litestream.yml` points at `/app/timpager.db` (ephemeral) — **do not copy that bug.** Make replication verifiably live (boot-refuse or loud health-check), with a tested restore drill, documented RPO (near-zero) / RTO (~2 min), and bounded backup purge limits.

Boot **refuses to start in production** if required secrets are unset, with no fallback chains: `DB_PATH`, `GOOGLE_PLACES_API_KEY`, `CENSUS_API_KEY`, `ANTHROPIC_API_KEY` (plus at-least-one AI provider). Optional/graceful-degrade: `OPENAI_API_KEY`, `GITHUB_TOKEN`+`GITHUB_REPO`, `CRM_API_KEY`, `LITESTREAM_*`. Full table and the restore drill are in [SECURITY.md](./SECURITY.md) and [OPS_RUNBOOK.md](./OPS_RUNBOOK.md).

---

## The idea-fab feedback loop

Feedback is split so **no resolvable projection link or financial data ever reaches GitHub** (PRD §22):

- **Bugs → GitHub** as issues carrying only non-sensitive context (route, app version, `model_version`, a random **support ID**, timestamp). The user sees the support ID; only server-side staff tooling resolves it to a projection. Safe even if the repo is public. A CI test asserts no `view_slug` / edit token / financial field ever appears in a GitHub payload.
- **Intent → CRM** — optional email, role, reason, opening timeline, "request expert review," and follow-up consent. This is the discovery engine, not a support afterthought.

Details and the redaction test live in [IDEA_FAB.md](./IDEA_FAB.md).

---

## How to start building

1. **Read [CLAUDE.md](./CLAUDE.md)** — the repo constitution: top damage risks, hard rules (server owns all math §13; no client compute; no cookies/CSRF; capability-token auth; engine is the single version-locked authority), vocabulary, and the regression registry.
2. **Read [BUILD_PLAN.md](./BUILD_PLAN.md)** — the milestone sequence (M-1…M7), entry gates, and the credibility map. Note that **M2 is the credibility gate**: the smallest shippable loop must carry the **decision banner + monthly cash-flow + recommendation** (not just compute→save→`.xlsx`), because those *are* the product.
3. **Follow the build loop in [AGENTS.md](./AGENTS.md)** — per-milestone: plan-mode review → write the plan → isolated git worktree → subagent-driven TDD with per-task review → whole-branch review on the most capable model → `/qa` browser pass at 1440/768/375 → ship + deploy with a healthcheck that verifies the **new build SHA**. Honor the M-1 validation precondition.
4. **Build the golden-test harness first (M1), before feature breadth.** Three-way reconciliation — server compute == stored `computed_json` == LibreOffice recalc of the exported `.xlsx` — within < $0.50 / 0.1pp and zero formula errors, **with and without overrides**, CI-blocking. Seed it with the three named fixtures: **House of Hope conservative** (6/8/10%, ~$427k Y1, ~11% margin, ~$278k capital, break-even ~month 5–7), the **Aggressive flagged case** (15/20/25%, must trigger the §12.2 guardrail + required justification), and the **Grace Mission loss case** (Y1 net ($12,400), payback N/A, low-confidence $14/sqft rent, one overridden Payroll cell).
5. **Honor the verification bar in [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md).** No "done/passing/fixed" claim without fresh command output in the same message (`pytest`, `recalc.py` → `total_errors: 0`, the golden reconcile, the a11y check, the deploy healthcheck SHA).

### Goals / non-goals (v1)

**In:** a decision + funding tool for first-store nonprofits; city/county/manual trade area; monthly cash-flow + decision metrics + explainable recommendation; evidence/confidence on every researched number; server-authoritative compute; formula-driven `.xlsx` + Board Packet.

**Out (v1):** multi-store / for-profit; radius / drive-time / ZCTA trade areas (deferred with rules pre-specified, §8); actuals/benchmarks UI and data-compounding (ship the empty table schema, build no UI — §6.3); demand drivers that *scale* the estimate (they only adjust confidence in v1, §9); any client-side math (§13).

---

*Build/spec repository. The PRD in `reference/PRD.md` is authoritative; where this README and a sibling doc disagree, defer to the PRD and the named doc, and fix the drift in the same PR ("Docs Are Code").*

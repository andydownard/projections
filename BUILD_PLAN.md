# BUILD_PLAN.md — Thrift Store Projection Web App

**Repo:** `rallytasks/projections` · **Status:** built & deployed (engine 2.6.0, 5-year horizon, redesign v2) · **Source of truth:** [PRD.md](./reference/PRD.md) (v3.1) · **Tracks PRD §24 milestones M-1–M7**

> This is the execution plan an agent team builds from. It expands the PRD milestones into sequenced, agent-sized tasks with per-task acceptance criteria, dependencies, and the review gates that apply. It is deliberately self-consistent with its sibling docs — cross-link by filename: [ARCHITECTURE.md](./ARCHITECTURE.md), [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md), [DATA_MODEL.md](./DATA_MODEL.md), [API_SPEC.md](./API_SPEC.md), [SECURITY.md](./SECURITY.md), [OPS_RUNBOOK.md](./OPS_RUNBOOK.md), [CLAUDE.md](./CLAUDE.md), [AGENTS.md](./AGENTS.md), [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md), [CONTRIBUTING.md](./CONTRIBUTING.md), [IDEA_FAB.md](./IDEA_FAB.md).

---

## 0. How to read this document

- **Milestones M-1 → M7** mirror [PRD.md](./reference/PRD.md) §24/§28. Each milestone has: **Goal**, **Entry gate**, **Tasks** (checkbox list, each agent-sized with acceptance criteria), **Exit criteria**, and **Review gates** that must be green before merge.
- **The build loop** (per-milestone agentic cycle, model-selection policy, review-role map) lives in [AGENTS.md](./AGENTS.md). The **hard rules** (single math authority, no client compute, capability-token auth, regression registry) live in [CLAUDE.md](./CLAUDE.md). The **verification bar** lives in [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md). This plan references those gates; it does not restate them.
- **Three callouts gate the entire program** and appear before the milestones because they reframe the work: the **Engine Gap Table** (§3), the **Resolved Defaults** (§4), and the **Sample-Data Fixtures** (§5). Read all three before opening M0.

### Critical framing — the engine is a rewrite, not a reuse

[PRD.md](./reference/PRD.md) §13/§23/Appendix A repeatedly call the existing Python engine "the single math authority." **As built today, it is not.** `reference/thrift-store-projections-skill/scripts/generate_projection.py` implements the *old* annual model: it hard-codes Year-2 = midpoint of Y1/Y3, has no monthly cash-flow, no Marketing line, fixed-dollar supplies (not %), no rent escalator, no decision metrics, no override DAG, no view-model output, and its Excel builder emits unguarded `=net/totrev` and `=startup/Y1net` divisions that produce `#DIV/0!` the moment revenue or Y1 net is zero. **Roughly 70% of what M1 requires does not exist.** Treat M1 as a versioned **rewrite** that preserves the bottom-up driver chain and the blue-input/live-formula Excel styling, and retains the legacy annual script only as a calibration golden. See §3 for the line-by-line gap.

---

## 1. Goals & non-goals (v1 scope fence)

**In scope (v1) — a decision-and-funding tool for first-store nonprofits:**
- Server-authoritative compute as the only math surface; monthly launch cash-flow; 3-year P&L derived from the monthly roll-up ([PRD.md](./reference/PRD.md) §10, §13).
- Decision outputs: startup capital required, first-year cash gap, cash runway, break-even month, rules-based explainable recommendation ([PRD.md](./reference/PRD.md) §4, §12).
- Trade area locked to **City / County / Manual** ([PRD.md](./reference/PRD.md) §8).
- Evidence/confidence on every researched number; cell-level overrides on a DAG with an Inspector; grounded LLM narrative + Board Packet; formula-driven `.xlsx`; capability-token (no-login) access; redacted GitHub feedback + CRM intent.

**Out of scope (v1) — deferred, with rules pre-specified where noted:**
- Multi-store operators, for-profit resellers, established chains ([PRD.md](./reference/PRD.md) §2).
- Radius / drive-time / ZCTA trade areas ([PRD.md](./reference/PRD.md) §8 — deferred with ACS-vintage/FIPS/MOE/partial-tract rules pre-written).
- Actuals/benchmarks UI and data-compounding ([PRD.md](./reference/PRD.md) §6.3) — ship the empty `actuals` table schema in M0 so it is never a migration later, but **build no UI** until M7.
- Demand drivers that *scale* the point estimate (v1 drivers adjust *confidence* only, §9).

The scope fence is enforced in plan-review: M7 features may not be pulled into M2. See **§9 Open questions** for the items that must be closed before the gated milestones.

---

## 2. Milestone dependency graph & credibility map

```
M-1 (validation gate) ──► M0 (scaffold) ──► M1 (engine + golden gate)
                                                  │
                                                  ▼
                                          M2 (MVP loop) ◄── CREDIBILITY GATE
                                          │      │
                              ┌───────────┘      └───────────┐
                              ▼                              ▼
                        M3 (research)                  M4 (editing depth)
                              │                              │
                              └──────────────┬───────────────┘
                                             ▼
                                       M5 (packet + narrative)
                                             │
                                             ▼
                                       M6 (feedback + intent)
                                             │
                                             ▼
                                       M7 (hardening + actuals)
```

**Milestone credibility map** — which milestone first makes the product defensible to a board:

| Milestone | Is it shippable to a board? | Why |
|---|---|---|
| M1 | No (no UI) | Correct math + golden gate, but headless. |
| **M2** | **YES — minimum credible** | Decision banner + monthly cash-flow + rules-based recommendation ship here. **This is the product.** |
| M3–M4 | Yes, richer | Evidence/trust + override depth deepen defensibility. |
| M5 | Yes, complete | Board Packet is the headline trust artifact. |

> **M2 is the credibility gate, not M5.** The PRD §28 M2 wording ("minimal inputs → compute → save → reopen → .xlsx + basic packet") is silent on the decision outputs. **This plan resolves that:** capital-required, break-even month, first-year cash gap, and the rules-based recommendation (§12.3) **MUST** be in M2. A calculator without the decision is not shippable for this ICP. Research, overrides, narrative, and evidence attachments stay deferred to M3+.

---

## 3. Engine Gap Table (the M1 task list, line by line)

Comparing `generate_projection.py` **as built** against PRD v3.1 requirements. Each row is marked **EXISTS** (reuse near-verbatim), **REWRITE** (formula seed is right, behavior is wrong), or **NEW** (does not exist). Every REWRITE/NEW row is a TDD task in M1 with a failing golden test written first. Authoritative formulas live in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md); this table scopes the work.

| # | Capability | As-built (file:line) | Required (PRD) | Status |
|---|---|---|---|---|
| 1 | Bottom-up driver chain (donating_hh → donations → retail → customers → salvage → total_rev) | `compute()` L63–88 | unchanged (§7.1, methodology L8–16) | **EXISTS** |
| 2 | Year-2 donor share | `share = {…2:(y1+y3)/2…}` L65; Excel `=AVERAGE(...)` L209 | three explicit shares Y1/Y2/Y3, **no midpoint** (§7.1) | **REWRITE** |
| 3 | Labor (payroll) % of revenue | `labor_pct: 0.60` L36 | resolve default; keep slider (§7.3) — see §4 | **REWRITE** |
| 4 | Marketing & outreach % of revenue | — | `total_rev × 3.75%` (§7.3) | **NEW** |
| 5 | Supplies & processing % of revenue | fixed `Store/office supplies: 3700` L44 | `total_rev × 5.0%`, **replaces** the fixed line (§7.3) | **REWRITE** |
| 6 | Credit-card fees, payroll tax, salvage % | L35–37, L77–79 | unchanged 2.0% / 7.5% / 0.8% (§7.3) | **EXISTS** |
| 7 | Remaining fixed lines (insurance, internet, pest, repairs, security, utilities) | `fixed{}` L38–46 | unchanged fixed $ (§7.3) — supplies removed from this set | **EXISTS** |
| 8 | Annual rent escalator | rent is flat all years L67 | `rent_y1 × (1+e)^(y-1)`, e=3.0%, applies Y2–Y3 (§7.3) | **NEW** |
| 9 | Occupancy as annual $ or sqft×rate; Gross vs NNN | `sqft × rent_per_sqft` only L67 | annual-$ entry **or** derived; Gross/NNN toggle adds opex (§7.3) | **REWRITE** |
| 10 | Monthly launch cash-flow M0–M12 (donation S-curve ramp, timed startup outflows, hire-date payroll, cumulative cash) | — | core new model (§10) | **NEW** |
| 11 | Year-1 P&L = roll-up of the 12 operating months | annual-only L68–89 | Y1 totals derive from monthly; must foot to the penny (§10.2/§10.3) | **NEW** |
| 12 | Decision metrics: break-even month, startup capital required (= Σ startup + \|peak cash shortfall\| + reserve), first-year cash gap, cash runway, break-even revenue | none | §4, §12.1 | **NEW** |
| 13 | Cash reserve buffer | — | `$25,000` into capital-required (§12.1) | **NEW** |
| 14 | Forecast guardrails + flags (share ≤8% Y1, sales/sqft, labor, occupancy, net margin) requiring justification notes | none | §12.2 | **NEW** |
| 15 | Sensitivity (base/downside/upside ±25% on rent & donations) | none | §12.2 | **NEW** |
| 16 | Rules-based recommendation (proceed / revise / find cheaper rent / raise more cash / delay / do not proceed) with reasons | none | §12.3 | **NEW** |
| 17 | Override DAG: topological resolve, no back-solve, stale-upstream flag, non-pinnable derived nodes, key `"{node}#{year}"` | none | §14 | **NEW** |
| 18 | Edge-case math: cents internal, explicit `null` + `flags` map, N/A handling, never `#DIV/0!` | `margin/payback` guarded with `0` not null L89/L93; Excel `=net/totrev` L257 & `=startup/Y1net` L284 **unguarded** | §12.4 | **REWRITE** |
| 19 | View-model output (`reco/metrics/kpis/monthly/rows/overrides/evidence/settings`, `{raw,display}` dual values) | returns positional tuple L94 | native output schema (Appendix D) | **NEW** |
| 20 | `model_version` + `compute_schema_version` stamped into output | none | §13 | **NEW** |
| 21 | Pure compute core decoupled from openpyxl/python-docx | `compute()` mixed with `build_xlsx`/`build_docx` | math has **zero** Excel/Word imports; renderers consume compute output (ARCHITECTURE) | **REWRITE** |
| 22 | Excel cell contract (blue input / live formula / orange override + comment / totals always formulas / monthly tab / N/A blank+comment) | partial: blue inputs + live formulas only; no override class, no monthly tab, no N/A guard | §18 | **REWRITE** |
| 23 | LibreOffice recalc gate (with AND without overrides) | `recalc.py` exists; SKILL.md step 4 covers happy path only | three-way reconcile, both states (§13/§18) | **REWRITE** |
| 24 | `.docx` 1-page summary builder | `build_docx()` L301 | demoted; replaced by grounded packet/narrative in M5 (§17) | **EXISTS** (calibration ref only) |

**Reuse verbatim:** rows 1, 6, 7, the blue-input/live-formula styling, the LibreOffice error list in `recalc.py` (the right gate primitive). **Everything else is REWRITE or NEW.** Do not "wrap the existing script."

---

## 4. Resolved Defaults (closes PRD §7.3 open items — blocks every golden test)

These constants are **product decisions that must be locked before M1 starts**, because the golden fixtures (§5) and the Appendix-D prototype headline numbers depend on them. Each lives as a named constant in the engine and is documented with rationale in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md).

| Constant | Default (locked) | Rationale / source |
|---|---|---|
| `LABOR_PCT` | **0.40** | Resolves the 40%/60% conflict. **40% is required to reproduce the Appendix-D prototype headline numbers** (Y1 rev ~$426,911, capital ~$277,990, break-even ~month 5). The engine `DEFAULTS` (0.60) and `methodology.md` L27 (60%) are the *old* model; the design supersedes them. **Slider remains editable.** If product instead chooses 60%, the Appendix-D prototype numbers must be re-baselined and §5 fixtures regenerated — this is the single highest-leverage open decision (§9). |
| `BASKET_VALUE` | **$17.08** | Resolves $17 (§7.3 / example JSON) vs $17.08 (Appendix-D). $17.08 reproduces the prototype's ~$426,911 Y1 / break-even month 5. |
| `MARKETING_PCT` | 0.0375 | New line (§7.3). |
| `SUPPLIES_PCT` | 0.05 | New % line, replaces the fixed `Store/office supplies $3,700` (§7.3). |
| `CARD_PCT` | 0.02 | §7.3 (unchanged). |
| `PAYROLL_TAX_PCT` | 0.075 | §7.3 (unchanged). |
| `SALVAGE_PCT` | 0.008 | §7.3 (unchanged). |
| `RENT_ESCALATOR` | 0.03 | New (§7.3). **Compounds:** `rent_y` = `rent_y1 × (1+0.03)^(y-1)`, applies Y2–Y3. Escalator applies to occupancy/NNN-opex; it does **not** re-escalate the Year-0 lease-deposit startup line. (Escalator compounding is an open item to confirm — §9.) |
| `RESERVE_BUFFER` | $25,000 | Feeds capital-required (§12.1). |
| `DONATIONS_PER_HH` | 3 | §7.3 / methodology L11. |
| Fixed lines | insurance 2000, internet 3000, pest 300, repairs 1600, security 900, utilities 22300 | Per engine `DEFAULTS` (§7.3). |

**Hard rule:** whichever values are chosen, a golden fixture (§5) MUST reproduce the Appendix-D prototype headline numbers, **or** those prototype numbers must be corrected in the same change. QA must never chase a phantom mismatch between two "correct" answers.

---

## 5. Sample-Data Fixtures (golden from day one — drive design, edge-math, and the §13/§18 gate)

Ship these three named projections as golden fixtures in `engine/tests/golden/` from the start of M1. They drive UI design, the §12.4 edge-case math, and the three-way reconciliation gate. Each is pinned to a `model_version`.

| Fixture | Inputs | Expected outputs (golden targets) | What it tests |
|---|---|---|---|
| **House of Hope (conservative)** | city basis ~31,800 hh; shares **6/8/10%**; NNN; donation value $74; 10k sqft, 70% sales floor; labor 40% | Y1 rev **~$426,911**; net margin **~11%**; capital required **~$277,990**; break-even **~month 5–7**; recommendation **Proceed** | Happy path; the Appendix-D calibration anchor; Y1=Σmonthly to the penny. |
| **Aggressive (flagged)** | shares **15/20/25%** | net margin **~39%** → MUST trigger the §12.2 net-margin guardrail flag (>30%) **and** require a justification note that travels into the packet | Guardrail flag is a *flag*, not a math error; recommendation = **Revise assumptions**. |
| **Grace Mission (loss case)** | long org name; high rent / low share; rent **$14/sqft, low confidence**; one **overridden Payroll cell** (Y2 $250,000, calc was ~$190,000) | Y1 net **($12,400)** (parentheses + error color); payback **N/A — no Year 1 profit**; CAGR/margin/per-unit KPIs render explicit `null`; **zero** `#DIV/0!` in Excel | N/A contract (§12.4); override + formula collision (§18); negative rendering; low-confidence badge. |

These three become the design stress dataset and the CI fixtures. The golden gate (§ M1) runs all three **with and without overrides** and asserts < $0.50 / 0.1pp deltas and zero formula errors. Additional edge fixtures required by the gate: **revenue=0** (0% share → margins/per-unit KPIs null), **0 sqft blocked at input**, **sensitivity downside** (−25% rent & donations, no sign/compounding error).

---

## 6. View-Model Contract (the engine's native output — shared by frontend and `.xlsx` builder)

The compute core emits the Appendix-D view-model **as its native output**, serialized into `computed_json`. The React frontend and the `.xlsx`/packet builders consume **one** structure, preventing a second math/format surface (the §13 anti-goal). Field-by-field detail is in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) and [API_SPEC.md](./API_SPEC.md); the convention is summarized here because every milestone references it.

- `reco` `{ tag, headline, sub, color, bg, icon }` — **server emits a semantic `tag` enum** (`proceed | revise | find_cheaper_rent | raise_cash | delay | do_not_proceed`); the **client** maps enum → design token. The API never hard-codes hex (keeps brand-vs-semantic token separation per DESIGN_PROMPT).
- `metrics` `{ capital, cashGap, breakeven }` + reasons `{ reasonCapital, reasonGap, reasonBreakeven }`.
- `kpis[]`, `monthly[]` (+ `breakevenMonth`), `rows[]` (`class: input|computed|overridden|estimated`, `editable`), `overrides[]` (`{ node, year, calculated, value, note, pinnedDate, affected[] }`), `evidence[]`, `settings{…}`.
- **Dual-value convention:** every money/percent field emits `{ raw, display }`. The **server is the single formatting authority** (whole dollars / 0.1% per §12.4); the client never re-derives money/percent formatting. This keeps UI, `.xlsx` (§18), and packet (§17) from disagreeing on rounding.
- `model_version` + `compute_schema_version` are stamped on every `computed_json`.

---

## 7. Cross-cutting review gates (apply to every milestone)

These come from [CONTRIBUTING.md](./CONTRIBUTING.md), [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md), [AGENTS.md](./AGENTS.md), and [CLAUDE.md](./CLAUDE.md). Each milestone's **Review gates** subsection names which of these apply most acutely; all Tier-1 gates apply to every commit.

- **G1 · Tier-1 GATE (every commit):** `pytest -q` green, zero failures; on a feature branch (never `main`); no secret in code/logs/responses ([DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md)).
- **G2 · Mutation Safety quad (every PATCH/POST):** bearer-token auth required · owner-scope isolation (never global list, never cross-owner read/write) · `If-Match` optimistic-concurrency 409-on-stale · negative/abuse path (rate-limit per IP+token). All four or no merge ([SECURITY.md](./SECURITY.md), [API_SPEC.md](./API_SPEC.md)).
- **G3 · Engine golden + LibreOffice recalc gate (CI-blocking, from M1 onward):** server compute == `computed_json` == LibreOffice recalc of the exported `.xlsx`, < $0.50 / 0.1pp, zero formula errors, **with and without overrides**. Assert `status=='success'` AND `total_errors==0` explicitly; **fail closed** if `recalc.py` returns an error dict.
- **G4 · TDD Iron Law:** failing test committed and watched-fail before production code; bugfixes get a reproducing regression test. Throwaway research/LLM spikes are the only exception and must be deleted before the real TDD pass.
- **G5 · Plan-mode review:** `/plan-ceo-review` (+ eng/design/DX as named in [AGENTS.md](./AGENTS.md)) on each milestone spec slice **before** task code; plan saved to `docs/plans/YYYY-MM-DD-<milestone>.md` with a verbatim Global Constraints block.
- **G6 · Milestone-end whole-branch review** on the most-capable model + **`/qa`** browser pass at 1440/768/375 against the Appendix-D / §5 states.
- **G7 · verification-before-completion:** no "done/passing/fixed" claim without fresh command output in the same message (pytest output, `recalc.py` JSON showing `total_errors:0`, a11y check, deploy healthcheck showing the **new build SHA** — a bare HTTP 200 is not enough).
- **G8 · Docs-are-code:** any PR touching the engine, the API contract, or the schema MUST update the matching sibling doc in the same PR.
- **G9 · `/security-review` + `/release-review`** before promotion (full sweep mandatory at M7; per-endpoint threat model on each new mutation throughout).

---

## M-1 · Pre-build validation (HARD GATE — not a coding milestone)

**Goal:** confirm someone will pay before building advanced overrides, narrative generation, or full research automation. The whole paid business model ([PRD.md](./reference/PRD.md) §3 price/gate) is currently unconfirmed; this is the highest-leverage and most-skippable step.

**Entry gate:** none (this is the program precondition).

### Tasks
- [ ] **M-1.1** Run **20 ICP interviews** with first-store nonprofit operators/boards (§2 ICP). *Acceptance:* 20 documented interviews with notes captured to the CRM/intent store.
- [ ] **M-1.2** Hand-produce **10 manual projections** for real prospects using the existing skill/engine as a manual tool. *Acceptance:* 10 delivered `.xlsx`/summary artifacts.
- [ ] **M-1.3** Get **5 users to share** a projection with a board/funder. *Acceptance:* 5 confirmed board/funder shares.
- [ ] **M-1.4** Secure **3 paid or sales-qualified conversions** (paid reviewed packet, or SQL into the Thriftly pipeline). *Acceptance:* 3 logged conversions.
- [ ] **M-1.5** **Close the three program-blocking open questions** (§9): business-model price/gate, labor-% product default, ramp/seasonality calibration source.

**Exit criteria:** All five tasks complete. A named **human go/no-go** is recorded. M0 does not start until this is recorded. (M0 scaffold *may* proceed in parallel at the team's risk, but **M3+ heavy build must not start** until M-1 is met — encoded as a literal checklist at the top of [AGENTS.md](./AGENTS.md) so an eager agent cannot skip it.)

**Review gates:** G5 (validation review with CEO lens). No code gates (no code).

---

## M0 · Scaffold

**Goal:** a deployable empty shell with the project's invariants wired from the first commit — repo, FastAPI, SQLite(WAL)+Litestream on the durable Railway volume, boot-refuse config validation, security headers, terms gate, and the agent-constitution docs.

**Entry gate:** M-1 go/no-go recorded (or explicit parallel-risk acceptance for scaffold-only).

### Tasks
- [ ] **M0.1** Create repo layout per [ARCHITECTURE.md](./ARCHITECTURE.md): `app/` (FastAPI: `main.py`, `deps.py`, `routers/`, `store/`, `schemas/`), `engine/` (`compute.py`, `model.py`, `monthly.py`, `dag.py`, `decision.py`, `xlsx.py`, `packet.py`, `narrative_facts.py`, `tests/golden/`), `frontend/` (Vite React+TS), `docs/plans/`. *Acceptance:* `pytest -q` runs (zero tests OK); `vite build` succeeds.
- [ ] **M0.2** Author **[CLAUDE.md](./CLAUDE.md)** (Top-5 Damage Risks, Hard Rules, seeded Regression Registry, Vocabulary, Doc Index), **[AGENTS.md](./AGENTS.md)** (the build loop, review-role map, subagent model-selection policy, M-1 precondition checklist), and **[DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md)** (Tier-1/Tier-2, Mutation Safety quad, Failure Mode Registry) **before any feature code**. *Acceptance:* all three present; Regression Registry seeded from §12.4/§14/§16/§17/§22 traps.
- [ ] **M0.3** FastAPI boot with **boot-refuse config validation** (single-source-of-truth `env-requirements`, **no fallback chains**): refuse to boot in production if `DB_PATH=/data/projections.db`, `GOOGLE_PLACES_API_KEY`, `CENSUS_API_KEY`, or an at-least-one AI provider (`ANTHROPIC_API_KEY` OR `OPENAI_API_KEY`) is unset. Optional/graceful-degrade: `OPENAI_API_KEY`, `GITHUB_TOKEN`+`GITHUB_REPO`, `CRM_API_KEY`, `LITESTREAM_*`. *Acceptance:* prod boot fails on a missing required var (test); dev/test permissive. Mirrors [SECURITY.md](./SECURITY.md).
- [ ] **M0.4** SQLite **WAL + busy_timeout + serialized writes**; `Store` Protocol (`app/store/base.py`) with `SqliteStore` and a `PostgresStore` stub; **app-generated string PKs (UUID/ULID)**; no SQLite-only SQL (`INSERT OR REPLACE`, `last_insert_rowid`) above the interface. Versioned, **additive-only** migrations. *Acceptance:* migrations create all [DATA_MODEL.md](./DATA_MODEL.md) tables incl. the empty `actuals` table; conformance note that the suite can target both backends.
- [ ] **M0.5** `GET /api/health` returning build SHA; **enforcing CSP** (`default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; connect-src 'self' api.anthropic.com api.openai.com`), CORS locked to origin, `X-Robots-Tag: noindex` + robots disallow on all responses, HSTS. *Acceptance:* header tests pass; CSP is enforcing (not Report-Only) from day one (greenfield SPA, no inline-script debt).
- [ ] **M0.6** **Terms-acceptance gate** scaffold (acceptance required before export/share, §21) and AI-disclosure surface stub. *Acceptance:* terms-acceptance state persisted; export/share endpoints check it.
- [ ] **M0.7** `railway.toml` (dockerfile builder, `healthcheckPath = "/api/health"`, `numReplicas = 1`, `restartPolicyType = "always"`, `sleepApplication = false`, `watchPatterns = ["**"]`) and `litestream.yml` replicating **`/data/projections.db`** — **NOT `/app`** (explicitly avoid the timpager `litestream.yml` bug that replicates `/app/timpager.db`). **Pin the LibreOffice/soffice version** in the Docker image for the recalc gate; ensure `timeout`/`gtimeout` present. *Acceptance:* deploys to the Railway service in the thriftly.com project; volume at `/data`; healthcheck green showing the new build SHA. See [OPS_RUNBOOK.md](./OPS_RUNBOOK.md).

**Exit criteria:** App deploys and serves `/api/health` with the new build SHA; boot-refuses on a missing required secret; CSP/CORS/noindex enforced; all tables migrated (incl. empty `actuals`); the three constitution docs are merged; Litestream replicates `/data/projections.db`.

**Review gates:** G1, G5, G7, G9 (`/security-review` on headers + config + token-storage plan), G8.

---

## M1 · Compute + cash flow + golden gate (the engine rewrite)

**Goal:** a **pure, deterministic, server-authoritative compute core** that emits the §6 view-model, includes the monthly cash-flow and all decision metrics, and passes the three-way golden gate **before any UI depth**. This is the spine of the entire trust story.

**Entry gate:** M0 exit criteria green. §3 Engine Gap Table, §4 Resolved Defaults, and §5 Fixtures all locked.

### Tasks
- [ ] **M1.0** Freeze the **legacy annual** `generate_projection.py` output for the House of Hope config as a regression golden ("calibration reference only"). *Acceptance:* legacy golden committed; documented as non-authoritative.
- [ ] **M1.1 (TDD, most-capable model)** Build `engine/compute.py` as a pure function `compute(inputs, assumptions, demand_drivers, trade_area, overrides) -> ComputeResult` with **zero openpyxl/docx imports**. Preserve the driver chain (Gap rows 1/6/7); add the three explicit shares (Gap row 2 — **kill the midpoint**), Marketing % (row 4), Supplies as % (row 5), rent escalator (row 8), occupancy-$/Gross-NNN (row 9). Compute in **cents/Decimal, round at display.** Stamp `model_version` + `compute_schema_version` (rows 20). *Acceptance:* annual P&L matches the calibration golden for the legacy inputs; new defaults reproduce §5 House of Hope headline numbers.
- [ ] **M1.2 (TDD, most-capable model)** Build `engine/monthly.py`: M0–M12 cash-flow with timed startup outflows, donation **S-curve ramp** (default ~3–6 mo, seasonality-adjustable), revenue lag, hire-date payroll, fixed-at-lease-start, variable-scales-with-revenue; cumulative cash, minimum-cash trough, break-even month. **Year-1 annual totals = roll-up of the 12 months** (Gap row 11). *Acceptance:* golden test asserts `annual_y1 == sum(monthly)` to the penny.
- [ ] **M1.3 (TDD, most-capable model)** Build `engine/decision.py`: break-even revenue (net=0) monthly & annual; **startup capital required = Σ startup + |peak cumulative cash shortfall| + reserve buffer**; first-year cash gap (most-negative cumulative cash M0–M12); cash runway; payback (`startup_total / Y1 net` with N/A guard); guardrails + flags (§12.2); sensitivity ±25% rent & donations; **rules-based recommendation** with reasons (§12.3, emits semantic `tag` enum). *Acceptance:* each metric asserted by golden tests against §5 expected outputs; Aggressive fixture triggers the >30% margin flag and yields `revise`; House of Hope yields `proceed`.
- [ ] **M1.4 (TDD, standard model)** Build `engine/dag.py`: topological `resolve(node) = pin.value if pinned else f(resolve(parents))`; **no back-solve**; stale-upstream flag; **derived/total/margin/KPI nodes non-pinnable** (reject server-side, not just hidden); override key `"{node}#{year}"`. The monthly model and the 3-year roll-up both flow through this single evaluator. *Acceptance:* property tests — statement always foots; pinned node uses its value; pin→reset returns to computed; pin a derived node → rejected; pin orphaned upstream → stale flag set.
- [ ] **M1.5 (TDD)** Centralize **all N/A guards** in one place + a `flags` map: revenue=0 → margin/sales-per-sqft/per-donation/per-customer = null; Y1 net≤0 → payback null; Y1 rev=0 → CAGR null; negatives flagged for parentheses+error rendering (Gap row 18). *Acceptance:* Grace Mission + revenue=0 fixtures emit explicit `null` + correct flags; no `0`-masquerading-as-N/A.
- [ ] **M1.6 (TDD)** Build `engine/xlsx.py` to the §18 cell contract: blue inputs, live formulas, **orange overridden component** with comment `"Manual override — calc was =<formula> → $X; set to $Y on <date>"`, **totals always formulas** over the (possibly hard-coded) component cells, **separate monthly tab** with the Year-1 P&L tab referencing the monthly roll-up cells, and **`IF(denom=0,"",num/denom)` guards** on every divided cell (fixes Gap rows 18/22 — the current `=net/totrev` L257 and `=startup/Y1net` L284 `#DIV/0!` defects). Server owns the output path; generate to a per-request temp dir and stream (no path traversal via org_name). *Acceptance:* exported workbook opens with the override fixture and recalcs clean.
- [ ] **M1.7 (CI-blocking)** Wire the **golden gate (G3)**: a `pytest` harness that runs `engine.compute`, reads back `computed_json`, and runs `recalc.py` (pinned LibreOffice) on the exported `.xlsx`; asserts the three artifacts agree < $0.50 / 0.1pp and `total_errors==0`, **with and without overrides**, across all §5 fixtures + edge fixtures (revenue=0, Y1 net≤0, sensitivity downside). Extends SKILL.md step 4 (which covered only the happy path). **Fail closed** on a `recalc.py` error dict. *Acceptance:* gate is green and blocks the build on any cell delta, formula error, or `computed_json` mismatch.
- [ ] **M1.8** Implement the **version/upgrade lifecycle** read path: if stored `model_version` ≠ current, return the stored snapshot verbatim + an `upgrade_available` flag; **never silently recompute** (§13). `upgrade-model` writes a **new revision**, preserving the prior. *Acceptance:* test that a newer engine does not mutate a stored projection on read.
- [ ] **M1.9** Perf test: assert **p95 server compute < 50 ms** (excluding research/LLM) for the monthly model + override resolution on the §5 fixtures. *Acceptance:* documented p95; if over budget, profiled and noted in [ARCHITECTURE.md](./ARCHITECTURE.md).

**Exit criteria:** All §5 fixtures + edge fixtures pass the three-way golden gate with and without overrides (G3 green in CI). Compute core has zero Excel/Word imports. Decision metrics, monthly cash-flow, override DAG, and the view-model output all exist and are golden-tested. Version-lock read path verified. p95 < 50 ms recorded.

**Review gates:** G1, G3 (the keystone), G4 (TDD strictly enforced — every Gap row is a red-test-first task), G5, G6 (whole-branch review on most-capable model), G7, G8 (update [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) in the same PRs).

---

## M2 · MVP loop (smallest shippable — the credibility gate)

**Goal:** the smallest end-to-end loop that is **credible to a board**: minimal inputs → server compute → **decision banner + monthly cash-flow + recommendation** → save → reopen → `.xlsx` + basic packet. No automated research, no overrides, no narrative generation. **This milestone IS the product.**

**Entry gate:** M1 golden gate green.

### Tasks
- [ ] **M2.1 (G2)** `POST /api/projections` (create, owner-scoped) and `GET/PATCH /api/projections/{slug}` (fetch / update+recompute). Every mutation requires `Authorization: Bearer` + `If-Match: <version>`; UPDATE is `… SET version=version+1 … WHERE id=? AND version=?`; **0-row result → HTTP 409** with current server state in the body; new version returned in body + `ETag`. *Acceptance:* Mutation Safety quad tests pass (auth, owner-scope isolation, 409-on-stale, negative/rate-limit path).
- [ ] **M2.2** Capability-token auth in `app/deps.py`: owner token (≥256-bit, `secrets.token_urlsafe(32)`) + `view_slug` (≥128-bit, `token_urlsafe(16)`); tokens stored **hashed (SHA-256)**, compared with **`hmac.compare_digest`**; `view_slug` plaintext lookup key; secrets only via `Authorization: Bearer` / URL fragment, **never in path/query, never logged**. *Acceptance:* one-time recovery code shown once at create; cross-owner read/write rejected (test). See [SECURITY.md](./SECURITY.md).
- [ ] **M2.3 (frontend)** React 18 + TS + Vite scaffold; **TanStack Query** for the server-owned `computed_json` cache (keyed by `view_slug`, holds `computed_json`+`version`); thin local UI store (Zustand/useReducer) for transient UI. **DELETE all client math** — the prototype's `calcYears/calcMonthly/scenario/startupTotal/paybackYears` must NOT survive (violates §13). Frontend renders the server's view-model only. *Acceptance:* no `calc*` math functions on the client; a lint/test guard enforces it.
- [ ] **M2.4 (frontend)** **Decision banner** (reco chip + headline + sub + three tappable metric cells: Capital required "Why?→", Break-even, First-year cash gap in error color) + **6-tile KPI strip** + **monthly cash-flow** (hand-rolled SVG bars+line + break-even marker, dual-scale) + monthly table. Negatives in parentheses + error color; N/A rendered explicitly (never `#DIV/0!`/NaN). Reco `tag` enum → token mapping owned by the client. *Acceptance:* renders all three §5 fixtures correctly at 1440.
- [ ] **M2.5 (frontend)** **Two-tab detail page** (Projection | Settings & assumptions) with persistent top bar (logo, name + version chip, autosave state dot, docked feedback lightbulb stub) and **autosave loop**: edit → debounce (~300–400ms) → optimistic "pending" render → PATCH (`If-Match`) → reconcile to server `computed_json` → `saveLabel` state machine ("All changes saved"/"Saving…"/"Save failed — retry"). Stale responses dropped by version. Each settle writes one **revision snapshot**. *Acceptance:* edit a Settings slider → server recompute → UI reconciles; revision row written.
- [ ] **M2.6 (frontend)** **Save-conflict (409) modal** (Reload latest / Overwrite / Save as copy); frontend tracks the server `version` from every response and never silently overwrites. *Acceptance:* simulated stale PATCH shows the modal.
- [ ] **M2.7 (frontend)** **Minimal wizard** (5 steps; **three explicit per-year share fields**, no auto-midpoint; even-ramp helper + benchmark presets; live share helper text) with **local draft recovery** (save local draft after step 1; **no server record until Generate**). Manual households (city/county/manual) and **manual rent** only — no automated research in M2. *Acceptance:* wizard → Generate creates a projection; draft resume works.
- [ ] **M2.8 (frontend)** **Projections list** (`/`, owner-scoped, never global): name, location+basis, updated, Y1 revenue, net profit, capital required, **recommendation chip**; open/duplicate/trash + restore; utilitarian empty state. *Acceptance:* list is owner-scoped (test); recommendation chips render.
- [ ] **M2.9** `GET …/xlsx` and `GET …/packet` (basic, structured-facts packet — no generated prose) behind the terms gate. *Acceptance:* `.xlsx` passes the recalc gate from the live server path; basic packet renders the decision + tables.
- [ ] **M2.10** Two-layer **design tokens** as CSS custom properties: `brand-*` (`--brand-primary #35644f`, `--brand-deep #1d4733`) and `semantic-*` (`--success #257648`, `--warning #b45309`, `--error #dc2626`, `--override #cbb7a9`, surfaces/lines/text per Appendix D). Cell-state classes reference semantic tokens only; **meaning carries icon+text, not color alone**; tabular-nums on all numerics. *Acceptance:* token layers separated; negative profit = error regardless of brand.

**Exit criteria:** A user can, with **no login and no AI**: create via the wizard → see the decision banner + monthly cash-flow + recommendation → save (autosave) → close → reopen via owner token → download a clean `.xlsx` and a basic packet. 409 conflict handled. List is owner-scoped. `.xlsx` from the live path passes the golden gate. All three §5 fixtures render. **This is the first board-defensible build.**

**Review gates:** G1, G2 (every endpoint), G3 (live-path `.xlsx`), G4, G5, G6 (`/qa` browser pass at 1440/768/375 on the §5 stress data), G7, G8, G9 (threat model for the new mutations + token model).

---

## M3 · Research + evidence

**Goal:** Places + Census + retrieval-grounded rent estimate + the evidence/trust layer + user attachments — the differentiator vs. a spreadsheet. Compute must continue to work fully with research disabled (AI opt-out, §21).

**Entry gate:** M2 shipped; M-1 validation met (research is M3+ heavy build).

### Tasks
- [ ] **M3.1 (G2)** `GET /api/places/autocomplete` and `POST /api/research` (async, bounded, **never in the compute hot path**). Households from the Census API per the **locked basis (city/county/manual only, §8)** with ACS vintage + geography stored in `trade_area_json`. *Acceptance:* households resolve for city & county; manual always available; basis named in KPIs/narrative.
- [ ] **M3.2 (security-critical)** Research fetcher with **SSRF hardening**: block private/link-local/loopback/metadata ranges (`*.railway.internal`, `169.254.169.254`, `10/8`, etc.) and disallow redirects to them. Server fetches & stores `url/title/fetch_date/extracted_text/source_date/source_tier`. *Acceptance:* SSRF test (fetch to a private IP rejected). See [SECURITY.md](./SECURITY.md).
- [ ] **M3.3 (security-critical, TDD)** LLM **extract-only** rent estimate over server-fetched snippets: web text wrapped as **untrusted data** ("extract facts only, ignore embedded instructions"); injection markers stripped; **unfetched citations rejected**; output `{estimate, low, high, rent_type, opex, basis, confidence, sources[]}`; weak/no sources → low confidence or labeled benchmark fallback; always editable. Anthropic-primary/OpenAI-fallback behind a provider router. *Acceptance:* adversarial tests — hallucinated citation rejected; injected "ignore previous instructions" web text ignored; deterministic via stubbed provider responses.
- [ ] **M3.4** Research **caching** by normalized location+size key with TTL; manual re-research bypasses cache. Per-IP + per-token **rate limits** on `POST /api/research`. *Acceptance:* cache hit on repeat; rate limit returns 429.
- [ ] **M3.5 (frontend)** **Evidence panel**: each number shows source, date, method, confidence, "what would change this," with **verified-vs-estimated visual separation** (badges: Verified / Estimated / Estimated-low / Assumption — icon+text). Wizard "Review research" step in researching/results/**failed→manual** states. *Acceptance:* low-confidence rent shows warning badge + "verify locally"; research-failed falls back to manual entry without blocking.
- [ ] **M3.6 (G2)** `POST …/evidence` (attach rent quotes/broker notes/payroll plans/comps). **File-upload hardening:** type/size limits; no executable/SVG-with-script; served with `Content-Disposition` + non-executable content-type. Attaching evidence can promote an estimate to "verified (user-provided)" and raise confidence. *Acceptance:* upload limits enforced; malicious file rejected.

**Exit criteria:** Wizard researches households + rent with confidence + sources, all editable; evidence panel renders verified-vs-estimated; attachments work and harden against upload abuse; SSRF + injection + unfetched-citation tests green; full flow still works with all AI keys unset (opt-out test).

**Review gates:** G1, G2, G4, G5, G6, G7, G8, **G9 (`/security-review` mandatory — SSRF, prompt-injection, file-upload, rate limits)**.

---

## M4 · Editing depth (overrides, revisions, sharing, conflict)

**Goal:** the full assumptions + cell-override UX on the DAG, the Override Inspector, revisions, view/edit/role links with rotate/revoke, the 409 conflict path, and soft delete. The most complex UX in the app — correctly deferred from M2.

**Entry gate:** M2 shipped (server DAG from M1.4 already exists and is golden-tested).

### Tasks
- [ ] **M4.1 (frontend)** **Override cell state machine** per cell: `calculated → (click/Enter/Space) editing → (Enter/blur commit) {if |value−calc|<0.5 → back to calculated and DELETE the pin; else overridden}`; `overridden → (click) popover {Edit override | Reset to calculated}`. Three visual states (input bg + dashed underline / white computed / override-tan + left-border+dot). Derived rows + KPIs non-editable (no tabIndex). *Acceptance:* matches the prototype `commit()` semantics; auto-clear-on-equal-to-calc works.
- [ ] **M4.2 (frontend)** **Override Inspector drawer**: lists every pin (node·year, calculated strikethrough, override value, note, pinnedDate, **affected downstream rows**, per-pin Reset, Reset-all) + the amber "prefer driver-level edits" banner. `affected[]` and orphaned-upstream flags are **server-computed** (not faked client-side). Reduced-motion disables the drawer slide. *Acceptance:* drawer reflects server `overrides[]`; stale-upstream hint renders when an upstream row no longer drives a pin.
- [ ] **M4.3 (G2)** `GET …/revisions` + `POST …/revisions/{id}/restore`; `POST …/duplicate`; `POST …/trash|restore` + `DELETE`. Revision log records `actor_token_hash` + access events. Bound revision growth (retention/compaction policy). *Acceptance:* restore reproduces a prior snapshot exactly; revision growth capped.
- [ ] **M4.4 (G2, security-critical)** `POST …/rotate-tokens`: rotate owner, edit, view, and all role-link tokens **atomically in one transaction**, write a rotation event to the audit/revision log, **immediately invalidate previously-shared links**. Edit token delivered via **URL fragment**, scrubbed from the URL after read (`searchParams.delete()` + `replaceState()`). Role views (board/funder/advisor) as read-only capability links with a role flag controlling emphasis/CTAs. *Acceptance:* rotation invalidates old links (test); fragment never reaches the server/logs.
- [ ] **M4.5 (frontend)** Full **Settings & assumptions** tab: sliders (labor/marketing/supplies/software/returns %), occupancy $ + Gross/NNN toggle + escalator, sales-floor sqft, three per-year shares, funding + reserve, pre-opening costs — each edit flows to compute and writes a revision. **Guardrail justification notes** captured when an input is out-of-band (travel into the packet). *Acceptance:* out-of-band input requires a note; note persists.
- [ ] **M4.6 (frontend)** Degraded/error states as first-class UI: read-only edit attempt (needs edit link), offline/save-failure (retry + local draft), location-not-found (manual households). *Acceptance:* each state renders per Appendix-D / DESIGN_PROMPT.

**Exit criteria:** Cell overrides work end-to-end with the Inspector; overridden `.xlsx` cells render orange + comment and the workbook still passes the golden gate (G3 with-overrides); revisions restore exactly; rotate/revoke invalidates links atomically; role views render read-only with correct CTAs; guardrail notes captured.

**Review gates:** G1, G2, G3 (with-overrides path), G4, G5, G6, G7, G8, G9 (token rotation + role-view access threat model).

---

## M5 · Board Packet + narrative + sensitivity

**Goal:** the Board/Funder Packet (the headline trust artifact) with grounded prose generated from structured facts, stale handling, and the on-screen sensitivity surface. Narrative is correctly the latest content milestone because its numeric-grounding validator is the riskiest trust feature.

**Entry gate:** M4 shipped (overrides + evidence feed the packet).

### Tasks
- [ ] **M5.1** `GET …/packet`: full Board Packet (decision recommendation; assumptions verified-vs-estimated; citations/evidence with dates+confidence; **sensitivity table**; risks lease/staffing/ramp; cash need + break-even; monthly summary; 3-year P&L; KPIs). Role-tailored emphasis (board/funder/advisor). PDF/`.docx`. *Acceptance:* packet leads with evidence; renders all §5 fixtures incl. the Grace Mission loss case cleanly.
- [ ] **M5.2 (security-critical, TDD)** `GET/PUT/POST …/narrative(:regenerate)`: prose generated **from `computed_json` facts**; **post-generation numeric grounding — every figure in the prose must exist in `computed_json`/approved facts or the response is rejected** (a hard server-side validator + CI test invariant, not a prompt nicety). Low temperature; Anthropic→OpenAI fallback. *Acceptance:* adversarial test — a hallucinated figure in generated prose is rejected; prose states rent as estimate/range, not fact.
- [ ] **M5.3 (security-critical)** **Sanitize `body_md`** server-side with an allowlist sanitizer (e.g. `bleach`) before storage and render — closes the stored-XSS→token-theft path inherent to localStorage bearer tokens. *Acceptance:* injected `<script>`/inline-handler stripped (test).
- [ ] **M5.4** **Stale handling:** store `computed_hash` at generation; if figures change, show "Out of date" + a diff + Regenerate; **never auto-overwrite user-edited prose** (`edited` flag). *Acceptance:* changing an input flags the narrative stale; user edits preserved across recompute.
- [ ] **M5.5** Per-token + per-IP rate limits + **regeneration cap** on `narrative:regenerate` (cost control, §27). AI opt-out path verified: compute/save/export `.xlsx` with narrative disabled. *Acceptance:* regen cap enforced; opt-out end-to-end test green.

**Exit criteria:** Board Packet exports (board/funder/advisor) with evidence-first layout and sensitivity; grounded prose passes the numeric-grounding invariant; `body_md` sanitized; stale diff + Regenerate works without clobbering edits; AI opt-out fully functional.

**Review gates:** G1, G2, G4, G5, G6, G7, G8, **G9 (`/security-review` — grounding invariant, XSS sanitization, regen cost caps)**.

---

## M6 · Feedback → GitHub (Idea Fab) + intent → CRM

**Goal:** the redacted GitHub-issue feedback loop and the CRM intent loop — the discovery engine, with the product's top data-leak risk neutralized by construction.

**Entry gate:** M2 shipped (can land any time after; sequenced here per PRD §24).

### Tasks
- [ ] **M6.1 (G2, security-critical)** `POST /api/feedback`: bugs → GitHub with a random **support ID** shown to the user; auto-context non-sensitive only (route, app version, `model_version`, support ID, timestamp). **No `view_slug`, no resolvable projection link, no financial fields ever in the payload.** Server-only staff tooling resolves support_id → projection. Per-IP+token rate limit (GitHub-spam). *Acceptance:* **CI test asserts the GitHub payload contains no `view_slug`/edit token/projection link/financial field** — only the support_id. See [IDEA_FAB.md](./IDEA_FAB.md).
- [ ] **M6.2 (frontend)** Feedback modal (Idea/Bug/Other, title, description, optional email; "Don't include sensitive financial details" notice; success shows support ID, no projection link). *Acceptance:* support ID shown; no projection link in UI or payload.
- [ ] **M6.3 (G2)** `POST /api/intent`: email, role, reason, opening timeline, "request expert review," follow-up consent → CRM. Distinct from bug reports. Per-IP+token rate limit. Graceful-degrade if `CRM_API_KEY` unset. *Acceptance:* intent routed to CRM; degrades cleanly when CRM disabled.

**Exit criteria:** Feedback creates a redacted GitHub issue with a support ID and **provably** no projection link/financial data (CI test); intent routes to CRM; both rate-limited; the redaction test is in the Regression Registry so it can never silently regress.

**Review gates:** G1, G2, G4, G5, G7, G8, **G9 (redaction is the top data-leak risk — `/security-review` required)**.

---

## M7 · Hardening + actuals + launch readiness

**Goal:** production hardening, the full a11y/error-state sweep, design QA against the stress dataset, the documented restore drill, the net-new mobile per-year editor, and the post-launch actuals (opt-in) on the already-migrated table.

**Entry gate:** M5 + M6 shipped.

### Tasks
- [ ] **M7.1 (frontend, net-new)** **Mobile 375 per-year stacked editor** (one year at a time, tap popovers, **no hover tooltips**, **touch-safe reachable override reset**); KPI strip + cash-flow scroll horizontally; 3-year table sticky-first-column at 768. *Acceptance:* override reset reachable on touch; no clipped currency at 375.
- [ ] **M7.2 (a11y, G6)** Full **AA accessibility sweep**: keyboard-operable wizard/cell-editing/override controls/inspector/popovers/modals; visible focus rings; icon+text (no color-only meaning); reduced-motion disables drawer slide + chart transitions. Verified against the §5 stress dataset at **1440/768/375 with screenshots** as the design-QA gate (DESIGN_PROMPT acceptance criteria). *Acceptance:* screenshots delivered; AA contrast verified; no overlapping/clipped text.
- [ ] **M7.3 (ops, G9)** **Litestream restore drill**: write `restore-db.sh` and **actually run** a restore-from-R2 into a throwaway volume; assert `PRAGMA integrity_check` and that `computed_json` round-trips. Document **RPO (~near-zero), RTO (~2 min)**, and **backup purge limits / R2 lifecycle** (stated to users per §21). Make `LITESTREAM_*` required-in-prod OR loudly health-check that replication is live. *Acceptance:* drill output captured in [OPS_RUNBOOK.md](./OPS_RUNBOOK.md); replication verified live.
- [ ] **M7.4 (ops)** Migration safety: additive-only `ALTER TABLE` discipline (never DROP/recreate); **pre-migration Litestream snapshot checkpoint**; run migrations **before** schema-dependent statements at boot; promote script that **verifies the new build SHA** before flipping environments. *Acceptance:* migration runbook + promote script documented and exercised.
- [ ] **M7.5 (security, G9)** Full **`/security-review`** sweep: audit-log contents (mutations, rotations, exports, share-link access); CSP/CORS/noindex re-verified; provider data-retention (prefer zero-retention) + app retention + backup purge documented; AI-disclosure UI; HTTPS/HSTS. Confirm **key-loss = data-loss** expectation is surfaced forcefully at create time (staff cannot recover access, only resolve support IDs). *Acceptance:* security review signed off; recovery-code UX prominent.
- [ ] **M7.6 (post-launch, opt-in)** Actuals: `POST/GET …/actuals` on the **already-migrated** `actuals` table; forecast-vs-actual view; **opt-in anonymized** pooling stub for benchmark calibration (no benchmark UI in v1 — schema + entry only). *Acceptance:* actuals entry persists; pooling is opt-in and anonymized; no benchmark UI shipped.
- [ ] **M7.7** Observability: per-provider latency/error metrics; cost-control verification (research/narrative caching, regen caps). *Acceptance:* metrics emitted; cost caps confirmed.

**Exit criteria:** Mobile per-year editor works with touch-safe override reset; AA sweep passes with 1440/768/375 stress screenshots; restore drill executed with documented RPO/RTO + purge limits; migrations additive-only with pre-snapshot; full security review signed off; actuals schema live (opt-in, no benchmark UI); observability + cost caps in place. **Launch-ready.**

**Review gates:** G1, G2, G3, G4, G6 (`/qa` + design-QA screenshots), G7, G8, **G9 (full `/security-review` + `/release-review` before promotion)**.

---

## 8. Failure Mode Registry (seed — maintained in [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md))

Document every mode **before** coding; `Rescued? = N AND Tested? = N` is CRITICAL — never merge.

| Mode | Rescued? | User sees | Tested? | Milestone |
|---|---|---|---|---|
| Provider 429 / timeout (Anthropic/OpenAI) | Y | "AI busy — compute & .xlsx still work" | Y | M3/M5 |
| Recalc cell-mismatch / formula error | Y | (build fails; never reaches user) | Y | M1 |
| Stale-version 409 | Y | Reload / Overwrite / Save-as-copy | Y | M2 |
| Offline save / network failure | Y | Retry + local draft | Y | M2/M4 |
| Unfetched citation returned by LLM | Y | (rejected; estimate stays labeled) | Y | M3 |
| Hallucinated narrative figure | Y | (regeneration rejected) | Y | M5 |
| Location not found | Y | Manual households entry | Y | M3 |
| Low-confidence rent | Y | Warning badge + "verify locally" | Y | M3 |
| AI opt-out (all keys unset) | Y | Full compute + .xlsx, no narrative | Y | M3/M5 |
| SSRF to private range | Y | (fetch rejected) | Y | M3 |
| Feedback payload leak | Y | (no projection link ever sent) | Y | M6 |
| Litestream replication off | Y | (boot-refuse / loud healthcheck) | Y | M0/M7 |

---

## 9. Open questions to close (elevated from PRD §29 — block the gated milestones)

| # | Question | Blocks | Owner / when |
|---|---|---|---|
| 1 | **Business-model price/gate** ($199–$499 per reviewed packet, or bundled) — what is free vs paid? | M-1 exit; the §3 config toggle | Andy + Thriftly sales · M-1 |
| 2 | **Labor-% product default** (40% vs 60%) — swings the go/no-go recommendation; §4 locks **40%** to match Appendix-D, **must be confirmed** or the prototype numbers re-baselined | M1 golden fixtures | Andy · before M1 |
| 3 | **Ramp/seasonality calibration source** (S-curve length, peak-shortfall shape, seasonality) — a confidently-wrong break-even month is worse than none | M1 decision-metric calibration; feeds §6.3 actuals | Andy + a real opening · before M1, refined post-launch |
| 4 | **Rent escalator compounding** — §4 assumes `(1+e)^(y-1)` compounding on occupancy/NNN, not the lease-deposit startup line; confirm | M1 (Y3 rent + break-even) | Engine lead · before M1 |
| 5 | **Frontend framework** — held to React+TS (engine-as-service holds regardless) | none (decided) | — |

> **Discipline reminder:** the recommendation, the monthly cash-flow, and the trust/evidence layer must ship *together* for v1 to be credible. M2 carries the first two; M3 carries the third. Without all three, the product is "just another calculator." Keep the scope fence (§1) closed in every plan-review.

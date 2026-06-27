# AGENTS.md — Build Process & Review Roles

**Repo:** `rallytasks/projections` (Thrift Store Projection web app)
**Status:** Scaffolded, ready to build. Not yet built.
**Audience:** The human + AI agent team that builds this product.
**Companion to:** [CLAUDE.md](./CLAUDE.md) (hard rules, regression registry, vocabulary). This file is the *loop* — how work gets planned, built, reviewed, and shipped. CLAUDE.md is the *law* — what is always true. When they appear to conflict, CLAUDE.md wins on rules; AGENTS.md wins on process.

> **One-sentence mandate.** Build a *decision-and-funding tool* for first-store nonprofits — server-authoritative compute, capability-token access, grounded narrative, a board-defensible trust layer — plan-first, TDD-enforced, subagent-driven, milestone by milestone, with the engine as the verification oracle.

---

## 0. Read order

1. This file (the build loop).
2. [CLAUDE.md](./CLAUDE.md) — hard rules + regression registry. **Read before writing any code.**
3. [`reference/PRD.md`](./projections/reference/PRD.md) — authoritative product requirements (cited throughout as §N).
4. The doc for the layer you are touching:

| Topic | Doc |
|---|---|
| System shape, modules, endpoint→module map | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Milestone scope, sequencing, entry gates | [BUILD_PLAN.md](./BUILD_PLAN.md) |
| Compute-core contract, view-model, versions | [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) |
| Tables, columns, override keys | [DATA_MODEL.md](./DATA_MODEL.md) |
| Endpoints, request/response, If-Match/409 | [API_SPEC.md](./API_SPEC.md) |
| Tokens, CSP/CORS, grounding, SSRF, rate limits | [SECURITY.md](./SECURITY.md) |
| Railway, volume, Litestream, restore drill | [OPS_RUNBOOK.md](./OPS_RUNBOOK.md) |
| The verification bar (gates) | [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md) |
| Branching, PRs, "Docs Are Code" | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Feedback→GitHub redaction loop | [IDEA_FAB.md](./IDEA_FAB.md) |

---

## 1. The two methodologies we run

This repo distills two systems. Use both, in this division of labor:

- **gstack** (Garry Tan's specialist slash-command roles) supplies the **review gates** — `/office-hours`, `/autoplan` (CEO → design → eng → DX), `/review`, `/design-review`, `/qa`, `/cso`, `/ship`, `/land-and-deploy`. These are *who looks at the work and when*.
- **Superpowers** (obra's skills) supplies the **inner loop** — `brainstorming`, `writing-plans`, `using-git-worktrees`, `subagent-driven-development`, `test-driven-development`, `requesting-code-review` / `receiving-code-review`, `systematic-debugging`, `verification-before-completion`. These are *how a unit of work is actually produced*.

| Need | Superpowers skill | gstack role |
|---|---|---|
| Shape an unclear idea | `brainstorming` | `/office-hours` |
| Turn a spec slice into a plan | `writing-plans` | `/autoplan` (`/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/plan-devex-review`) |
| Isolate the workspace | `using-git-worktrees` | — |
| Execute plan tasks | `subagent-driven-development` | — |
| Write code | `test-driven-development` | — |
| Get a review | `requesting-code-review` / `receiving-code-review` | `/review`, `/codex` |
| Audit the UI in a real browser | — | `/design-review`, `/qa` |
| Audit security | — | `/cso` (OWASP + STRIDE) |
| Debug a failure | `systematic-debugging` | `/investigate` |
| Claim "done" | `verification-before-completion` | — |
| Ship | `finishing-a-development-branch` | `/ship`, `/land-and-deploy`, `/canary` |

**Note on `brainstorming`:** the PRD has *already* done the adversarial brainstorming (Appendix C changelog, Appendix D view-model contract are locked). For in-scope milestone work, skip open-ended ideation and go straight to plan-first. Reserve `brainstorming` / `/office-hours` for genuinely new product surface (e.g., resolving an open question in §29, or net-new UI flagged "still to design" in Appendix D).

---

## 2. The review roles (who runs, and when)

Six review lenses gate this project. Each maps to a gstack command and to specific PRD requirements. A milestone does not close until its required lenses are green.

| Role | Runs as | What it asks | Primary PRD anchor | When it runs |
|---|---|---|---|---|
| **Product / CEO** | `/office-hours`, `/plan-ceo-review` | Is this the decision-and-funding tool, or did it slip back to a calculator? Is the milestone the smallest credible cut? Is M-1 demand actually validated? | §1–§5, §12.3, §28 | Plan-mode, **every** milestone; hard gate at **M-1** and **M2** |
| **Eng / Architecture** | `/plan-eng-review`, `/review` | Server is the only math authority? Override DAG topological + non-pinnable derived rows? `If-Match`/409 on every mutation? `Store` interface keeps the Postgres path open? | §13, §14, §22, §24–§26 | Plan-mode + pre-land, every milestone |
| **Design** | `/plan-design-review`, `/design-review`, `/qa` | Table-first finance-grade density? Brand vs semantic tokens separate? Cell-state machine + inspector correct? Negatives in parentheses, N/A explicit? | §11, §14, §19, Appendix D, DESIGN_PROMPT | Any milestone with UI (M2, M4, M5, M7) |
| **QA** | `/qa` (real browser @ 1440/768/375) | Stress dataset renders clean? Keyboard cell editing? Degraded states real? 409 conflict modal works? | §12.4, §19.4, §27 | Every milestone with UI; full sweep at **M7** |
| **Security** | `/cso`, `security-review` | No client compute. No cross-owner read. No secret in path/query/log. Narrative sanitized. Grounding + SSRF enforced as tests, not hopes. Boot-refuses on missing secrets. | §13, §16, §17, §20, §21, §22 | **Every** mutating endpoint; full audit at **M3** (research), **M5** (narrative), **M7** |
| **Release** | `/ship`, `/land-and-deploy`, `/canary` | Golden gate green? Healthcheck shows the **new build SHA**? Restore drill documented + run? Migrations additive-only? | §13, §18, §26 | Every merge; ops sign-off at **M0** and **M7** |

These are *lenses*, not headcount. One agent (or one human) can run several. The rule is that the lens's questions are answered with **evidence in the PR**, not asserted.

---

## 3. The per-feature / per-milestone build loop

Each milestone (M0–M7, see [BUILD_PLAN.md](./BUILD_PLAN.md)) is one trip through this pipeline. Smaller features inside a milestone repeat steps 3–7.

```
idea / milestone spec slice
      │
  (1) office-hours / brainstorm   ── only for new surface; in-scope work skips to (2)
      │
  (2) plan reviews  ── /autoplan: CEO → design → eng → DX
      │              writing-plans → docs/plans/YYYY-MM-DD-<milestone>.md
      │              (TDD tasks only, no placeholders, Global Constraints block verbatim from PRD)
      │
  (3) isolate       ── using-git-worktrees: one worktree per milestone branch
      │
  (4) TDD build via subagents ── subagent-driven-development
      │              RED test first → implement → per-task review (spec + quality)
      │              model policy in §5; .superpowers progress ledger maintained
      │
  (5) verify        ── verification-before-completion: paste real command output
      │              pytest -q · golden-reconcile · recalc → total_errors:0
      │
  (6) review        ── whole-branch /review on most-capable model
      │              + role lenses required for this milestone (§2)
      │              + /qa (real browser @ 1440/768/375) for UI milestones
      │              + /cso for endpoints/secrets
      │
  (7) ship          ── /ship → PR → /land-and-deploy
                     healthcheck MUST report the NEW build SHA before flip → /canary
```

**No milestone merges to `main` without every required gate green.** "Green" means fresh command output, not a claim. See [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md).

### 3.1 The plan artifact (step 2)

`writing-plans` produces `docs/plans/YYYY-MM-DD-<milestone>.md` with:

- A **Global Constraints** block copied verbatim from the PRD (the relevant § rules + the items from CLAUDE.md "Hard Rules"). This survives context compaction.
- Bite-sized **TDD tasks** — each names the RED test, the file(s), and acceptance criteria. **No placeholders, no "TBD".** If a task can't be written concretely, the spec is not understood — return to step 1/2.
- The **role lenses** required to close this milestone (from §2).
- The **golden / property tests** that must exist when the milestone is done.
- The **ops deliverable** (if any) for the milestone.

### 3.2 Verification (step 5) — what counts as proof

A "done / passing / fixed" claim is invalid without fresh output **in the same message**. The canonical proof commands:

```
pytest -q                                  # zero failures
pytest engine/tests/golden -q              # 3-way reconcile green (compute == computed_json == LibreOffice recalc)
python recalc.py "<exported>.xlsx"         # asserts status=='success' AND total_errors:0
# UI milestones:  /qa screenshots @ 1440 / 768 / 375 against the stress dataset
# deploy:         healthcheck JSON showing the NEW build SHA (a bare HTTP 200 is NOT proof)
```

---

## 4. The engine is the verification oracle — and it is a REWRITE, not a reuse

> **#1 process correction.** The PRD repeatedly calls the Python engine "the single math authority" (§13, §23, Appendix A). That is the *goal*, not the *current state*. A line-by-line read of [`generate_projection.py`](./projections/reference/thrift-store-projections-skill/scripts/generate_projection.py) shows it satisfies ~30% of v1. Treating M1 as "wire up the existing script" will build the wrong model and badly under-estimate the work.

The existing script is the **bottom-up driver chain seed** and a **calibration golden** (the known-good Longview numbers). It is forked into a pure compute core. The legacy annual script stays in `reference/` and is *only* a calibration reference.

### 4.1 Engine gap table (the M1 task list)

Each row is a TDD task: write the failing golden test first, then implement.

| Concern | As-built in `generate_projection.py` | v1 requirement | Status |
|---|---|---|---|
| Bottom-up chain (donating_hh → donations → retail → customers → salvage → total_rev) | `compute()` L63–94 | Same chain, kept | **EXISTS — extract** |
| Blue-input / live-formula Excel styling | `style_input`, `line()` | Kept + extended (§18) | **EXISTS — extract** |
| Year-2 donor share | `share[2]=(y1+y3)/2` (L65); Excel `=AVERAGE()` (L209) | **Three explicit shares** Y1/Y2/Y3, no midpoint (§7.1) | **REWRITE** |
| Supplies | fixed `$3,700` (L44) | **% of revenue, 5.0%** (§7.3) | **REWRITE** |
| Marketing & outreach | none | **% of revenue, 3.75%** (§7.3) | **NEW** |
| Rent escalator | none | **3.0% compounding Y2–Y3** (§7.3) | **NEW** |
| Monthly cash-flow M0–M12 | none | S-curve ramp, timed startup outflows, hire-date payroll, cumulative cash (§10) | **NEW** |
| Decision metrics | none | break-even month, startup capital required, first-year cash gap, runway, sensitivity (§12) | **NEW** |
| Recommendation | none | rules-based, explainable (§12.3) | **NEW** |
| Reserve buffer | none | **$25,000** into capital-required (§12.1) | **NEW** |
| Override DAG | none | topological resolve, pins, no back-solve, non-pinnable derived rows (§14) | **NEW** |
| N/A guards / `flags` | `=net/totrev`, `=startup/Y1net` with **no zero-guard** → `#DIV/0!` | explicit `null` + `flags` map; `IF(denom=0,"",…)` in Excel (§12.4/§18) | **REWRITE (known defect)** |
| Output shape | positional tuple | **Appendix-D view-model** as native output (one structure for frontend + .xlsx) | **REWRITE** |
| Year-1 totals | annual-only | **roll-up of M0–M12** (annual == sum(monthly) to the penny) (§10.2) | **NEW** |

**Build M1 = write `engine/tests/golden/` FIRST, then make it pass.** Feature breadth (M2+) does not start until the golden gate is green.

### 4.2 Resolved defaults (close §7.3 open items before M1)

These block every golden fixture. The chosen values must reproduce the Appendix-D prototype headline numbers, or those numbers are corrected — pick once, document in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md):

| Constant | Decision | Why |
|---|---|---|
| Labor (payroll) % of revenue | **40%** (design-aligned default; slider stays editable) | Only 40% reconciles the prototype headline (Y1 ~$426,911, capital ~$277,990, break-even ~month 5). Document Longview rationale; CLAUDE.md owns the final call. |
| Average basket value | **$17.08** | Required to reproduce ~$426,911 / break-even month 5 (Appendix D). §7.3 says $17; the fixture authority is Appendix D. |
| Marketing & outreach | **3.75%** of revenue | §7.3 |
| Supplies & processing | **5.0%** of revenue (replaces fixed $3,700) | §7.3 |
| Rent escalator | **3.0%, compounding**, `rent_y1 × (1+e)^(y-1)`, Y2–Y3 | §7.3; compounding chosen — document whether it also escalates NNN opex and the deposit line |
| Cash reserve buffer | **$25,000** | §7.3 / §12.1 |
| Donations / household / yr | **3** | §7.3 |
| Salvage % of retail | **0.8%** | §7.3 |

### 4.3 Golden fixtures (ship from day one)

Three named projections drive design, edge-case math, and the §13/§18 reconciliation gate:

1. **House of Hope (conservative)** — shares 6/8/10%, ~$427k Y1 revenue, ~11% margin, ~$278k capital required, break-even ~month 5. The happy-path oracle.
2. **Aggressive (flagged)** — shares 15/20/25%, ~39% margin → MUST trigger the §12.2 guardrail and require a justification note that travels into the packet.
3. **Grace Mission (loss case)** — Y1 net (\$12,400), payback **N/A**, low-confidence \$14/sqft rent, one overridden Payroll cell. MUST render cleanly: parentheses for negatives, explicit N/A, **no `#DIV/0!`** in Excel.

Each fixture runs through the golden gate **with and without overrides**.

---

## 5. Subagent model-selection policy

`subagent-driven-development` must **name the model in every dispatch** — never inherit the session default. Keep a `.superpowers` progress ledger so a compaction never re-dispatches a finished task.

| Task class | Model tier | Examples |
|---|---|---|
| Transcription (plan contains complete code) | cheapest | M2/M6 CRUD, .xlsx cell wiring, schema migrations |
| Integration (judgment, glue) | standard | research retrieval, places/census, autosave loop, 409 handling |
| Hard math + judgment | most-capable | the M1 engine rewrite, monthly cash-flow, override DAG, decision-metric solver |
| Whole-branch review (milestone end) | most-capable | always |

Property tests for the hard-math tasks are mandatory (goldens check totals; properties check shape): the statement always foots; a pinned node uses its value; a derived/total/KPI node can never be pinned; `annual == sum(monthly)`.

---

## 6. Hard process rules (the ones agents get wrong)

These are non-negotiable. Full rule list lives in [CLAUDE.md](./CLAUDE.md); these are the process-critical few.

1. **TDD is the Iron Law** for all engine, decision-metric, override-DAG, and API-mutation code. Commit the RED test and watch it fail first. No production code without a prior failing test. Bugfixes get a reproducing regression test (`systematic-debugging`). The *only* exception is a throwaway research/LLM-prompt spike, which is deleted before the real TDD pass.
2. **No client-side math, ever (§13).** The design prototype (`support.js` `calcYears`/`calcMonthly`/`scenario`) is a **layout + view-model-field-name reference only**. Porting its math is a P0 violation and breaks the golden reconciliation. The frontend sends inputs/overrides via `PATCH (If-Match: <version>)` and renders the server's `computed_json`.
3. **Mutation Safety quad** on every `PATCH`/`POST` (§25): (a) bearer-token auth required, (b) owner-scope isolation (never a global list, never cross-owner read/write — §20), (c) `If-Match` optimistic-concurrency 409-on-stale, (d) a negative/abuse path with per-IP + per-token rate limit (§20). No mutation merges without all four tests.
4. **Grounding & safety are tests, not prompts.** Adversarial, in CI, with recorded/stubbed provider responses: a hallucinated figure in narrative prose → **rejected** (§17); an unfetched citation → **rejected** (§16); injected "ignore previous instructions" web text → **stripped/ignored** (§16). Happy-path-only grounding tests are forbidden.
5. **Feedback redaction is a CI test (§22).** Assert no `view_slug`, no edit token, no resolvable projection link, and no financial field ever reaches a GitHub-issue payload — only the random `support_id`. See [IDEA_FAB.md](./IDEA_FAB.md).
6. **Capability tokens, never sessions.** Do not introduce a cookie (it re-adds the CSRF the PRD designs out). Owner token in `localStorage` + `Authorization: Bearer`; edit secret only in the URL fragment, scrubbed after read (`searchParams.delete()` + `replaceState()`); never in path/query/logs. Pin this with a test.
7. **Boot-refuses on missing secrets** in production, single source of truth, **no fallback chains** — required: `DB_PATH=/data/projections.db`, `GOOGLE_PLACES_API_KEY`, `CENSUS_API_KEY`, plus at-least-one AI provider (`ANTHROPIC_API_KEY` primary, `OPENAI_API_KEY` fallback); optional/graceful-degrade: `GITHUB_TOKEN`+`GITHUB_REPO`, `CRM_API_KEY`, `LITESTREAM_*`. See [SECURITY.md](./SECURITY.md), [OPS_RUNBOOK.md](./OPS_RUNBOOK.md).
8. **AI opt-out must actually work end-to-end (§21):** a test runs the full create → compute → save → `.xlsx` flow with **all AI keys unset**.
9. **Docs Are Code.** Any PR touching the engine, the API contract, the data model, or the view-model **updates the matching doc in the same PR**.
10. **Version everything; never silently recompute (§13).** `model_version` (math) and `compute_schema_version` (view-model shape) are stamped on every `computed_json`. On read, if the stored `model_version` differs from current, return the stored snapshot verbatim and surface "new model available" — `upgrade-model` writes a NEW revision, preserving the prior.

---

## 7. Milestone gate map

The detailed scope lives in [BUILD_PLAN.md](./BUILD_PLAN.md). This is the process view: entry gate, required review lenses, the tests that must exist, and the ops deliverable.

| Milestone | Entry gate | Required lenses | Tests that must exist | Ops / deliverable |
|---|---|---|---|---|
| **M-1 Pre-build validation** | — | **Product/CEO (hard go/no-go)** | n/a (discovery) | 20 ICP interviews · 10 manual projections · 5 board/funder shares · 3 paid-or-SQL conversions. **No M3+ heavy build until met.** Human go/no-go. |
| **M0 Scaffold** | M-1 passed | Eng, Security, Release | boot-refuse env test; feedback-redaction test stub; CSP/noindex header test | Repo, FastAPI, SQLite(WAL)+Litestream on `/data`, terms gate, `railway.toml`, restore-drill script |
| **M1 Compute + cash flow** | M0 green | **Eng (most-capable)** | **golden 3-way reconcile (with/without overrides); annual==sum(monthly); decision-metric goldens; property tests** | engine `model_version` + `compute_schema_version` stamped; CI-blocking golden gate (LibreOffice pinned) |
| **M2 MVP loop (credibility gate)** | M1 golden green | **Product/CEO (hard), Eng, Design, QA, Release** | mutation quad on create/PATCH; 409 test; `.xlsx` recalc clean | inputs → compute → save → reopen → `.xlsx` + basic packet **including decision banner + monthly cash-flow + recommendation** (these ARE the product) |
| **M3 Research + evidence** | M2 shipped | Eng, **Security (full)**, Design | SSRF block test; unfetched-citation reject; injection-strip; cache TTL | Places + Census + retrieval-grounded rent + evidence panel + attachments (file-upload hardening) |
| **M4 Editing depth** | M3 shipped | Eng, **Design**, QA, Security | override-DAG props (non-pinnable derived; reset; stale-flag); revisions; role links | cell overrides + Override Inspector + revisions + view/edit/role links + 409 + soft delete |
| **M5 Board Packet + narrative** | M4 shipped | **Security (full)**, Design, Product/CEO | numeric-grounding reject; stale-narrative diff; sensitivity goldens | packet export + grounded prose + stale handling + sensitivity |
| **M6 Feedback + intent** | M5 shipped | Security, Eng | **feedback-redaction CI test (P0)**; CRM intent path | redacted GitHub + support IDs ([IDEA_FAB.md](./IDEA_FAB.md)); CRM intent loop |
| **M7 Hardening + actuals** | M6 shipped | **All six lenses; full QA sweep** | a11y AA on wizard/table/overrides/modals; full degraded-state set; restore drill run | security/ops/runbooks, error states, design QA; actuals table + opt-in benchmarks (schema only, no compounding UI) |

---

## 8. Scope fences (YAGNI — enforced in plan review)

The rich PRD tempts over-building. Plan-mode review (Product/CEO + Eng) rejects any task that pulls these into v1:

**In v1:** decision-and-funding tool for first-store nonprofits; city/county/manual trade area (§8); monthly cash-flow + decision metrics + recommendation; evidence/trust layer; grounded packet; capability-token sharing.

**Out of v1 (deferred, rules pre-specified where noted):** multi-store / for-profit (§2); radius / drive-time / ZCTA trade area (§8 — deferred *with* ACS-vintage/FIPS/MOE/partial-tract rules); actuals **benchmarking** and data-compounding beyond the empty table (§6.3 — ship the schema, build no UI); demand-drivers that *scale* the point estimate (§9 — v1 drivers adjust *confidence* only); any client-side compute (§13).

The M2 "smallest shippable loop" stays genuinely small — but it MUST carry the decision banner, monthly cash-flow, and recommendation, because a calculator without the decision is not shippable for this ICP.

---

## 9. Open questions to close (elevated from §29)

These block the build and need a human decision logged in the relevant doc before the dependent milestone starts:

| Question | Blocks | Owner doc |
|---|---|---|
| Business-model price/gate ($199–$499? bundled?) — what is free vs. paid/reviewed (§3) | M-1 exit criteria framing | PRD §3 / Product |
| Labor % product default — confirm **40%** (resolved §4.2) | every golden fixture (M1) | [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) |
| Ramp/seasonality calibration source for the S-curve + break-even (§10.2) | decision-metric confidence (M1) | [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md); calibration backlog = §6.3 actuals |
| Escalator scope — does 3.0% also escalate NNN opex + the deposit startup line? | engine determinism (M1) | [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) |

A confidently-wrong break-even month is worse than none: label confidence, show sensitivity, and treat §6.3 actuals as the calibration backlog.

---

## 10. Definition of "shipped"

A milestone is shipped when: all required lenses (§2) are green with evidence in the PR; [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md) Tier-1 (every commit) and Tier-2 (every PR) gates pass; the golden gate is green (with and without overrides); `/land-and-deploy` confirms the healthcheck reports the **new build SHA**; and every behavior-changing doc was updated in the same PR. Anything less is "in progress," regardless of how it feels.

# projections — Thrift Store Projection Web App

A decision-and-funding tool (not a calculator) that helps a first-time nonprofit thrift-store operator decide **whether and how** to launch, and produces a board/funder-ready case for it. From a few inputs the app researches the local trade area + market rent, builds a **monthly launch cash-flow** plus a **3-year projection** with KPIs and **decision outputs** (break-even month, startup capital required, first-year cash gap, rules-based go/no-go), and exports a cited **Board Packet** and a formula-driven `.xlsx`. Every number shows its evidence and confidence.

**Read first:** [reference/PRD.md](./reference/PRD.md) (authoritative requirements) → this file → [ARCHITECTURE.md](./ARCHITECTURE.md) → [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) → [BUILD_PLAN.md](./BUILD_PLAN.md). Before any work: [AGENTS.md](./AGENTS.md) (the build loop) and [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md) (the bar).

**Status:** scaffolded, **not yet built**. The Python script in `reference/` is a *calibration seed*, not the v1 engine. See "The engine is a rewrite" below.

---

## Project facts

| Fact | Value |
|---|---|
| Backend | Python **FastAPI**; server-authoritative compute (PRD §13). |
| Frontend | **React 18 + TypeScript + Vite**; TanStack Query for server cache; hand-rolled SVG charts. **No client-side math** (PRD §13, §22 item 22). |
| Storage | **SQLite (WAL)** + `busy_timeout`, serialized writes; **Litestream** continuous replication to object storage (PRD §26). |
| Deploy target | **Railway** service in the **thriftly.com** project; durable volume at **`/data`**; **`DB_PATH=/data/projections.db`** (NOT `/app` — see [OPS_RUNBOOK.md](./OPS_RUNBOOK.md)). |
| Access model | **No login. Capability tokens.** Owner bearer token (≥256-bit) in `localStorage`; `view_slug` (≥128-bit) is the lookup key; edit/role secrets via URL fragment only. No cookies ⇒ no CSRF (PRD §20). |
| AI | Anthropic primary, OpenAI fallback; **extract-only** research with citation validation; **numeric-grounded** narrative. Compute works fully with AI disabled (PRD §16, §17, §21). |
| Health | `GET /api/health`. |
| Reference docs | `reference/PRD.md`, `reference/DESIGN_PROMPT.md`, `reference/thrift-store-projections-skill/` (SKILL.md, `reference/methodology.md`, `scripts/generate_projection.py`, `scripts/recalc.py`, `examples/house_of_hope.json`). |
| Key files (once built) | `engine/compute.py` (pure math), `engine/monthly.py`, `engine/dag.py`, `engine/decision.py`, `engine/xlsx.py`, `engine/packet.py`, `engine/model.py` (constants + versions), `engine/tests/golden/`; `app/main.py`, `app/deps.py`, `app/routers/`, `app/store/` (`base.py` Protocol, `sqlite.py`, `postgres.py` stub). |

**Beachhead ICP (judge everything against it):** one small nonprofit/church-backed operator planning their **first** store in 3–12 months; the **user** is an ED/ops lead/volunteer who is **not** a finance expert; the **buyer** is a board/treasurer. Multi-store, for-profit, and chains are **out of scope for v1** (PRD §2).

---

## The operating contract (how you work here)

This repo follows a disciplined agent build loop: **brainstorm → spec → plan → sign-off → red-green TDD → subagent execution → verify with evidence → review gates → land.** Full mechanics live in [AGENTS.md](./AGENTS.md) and [CONTRIBUTING.md](./CONTRIBUTING.md). The non-negotiable rules:

### 1. Plan before you build (default)
**Plan mode is the default.** Opt out only for a one-file typo, a mechanical one-line fix, a test-assertion tweak, or a docs-only edit. For anything else:
1. **Brainstorm/spec first** (`superpowers:brainstorming` / gstack `/office-hours`). Tease out intent and requirements before code.
2. **Write a plan** to `docs/plans/YYYY-MM-DD-<topic>.md` (`superpowers:writing-plans`): 3–10 bite-sized **TDD** tasks, files touched, RED tests, acceptance criteria, and a **Global Constraints** block copied verbatim from the PRD. **No placeholders.**
3. **Get sign-off.** Run plan-mode review (gstack `/autoplan` → CEO/eng/design/DX) and get an explicit go/no-go before writing production code. If you cannot write the plan, you do not understand the task — ask, don't guess.

### 2. Red-green TDD, YAGNI, DRY (the Iron Law)
Write the **failing test first**, watch it fail, then write the minimum code to pass, then refactor (`superpowers:test-driven-development`). **No production code without a prior red test.** This applies to all engine math, decision metrics, the override DAG, and every API mutation. Bugfixes get a reproducing regression test first (`superpowers:systematic-debugging`). The only allowed exception is a throwaway research/prompt spike, which must be deleted before the real TDD pass. **YAGNI:** build the milestone in front of you, not the rich PRD's future features. **DRY:** the engine is the *one* math authority; the server emits display strings as the *one* formatting authority.

### 3. Subagent-driven execution, per task
Execute plans with `superpowers:subagent-driven-development`: one fresh implementer per task, a per-task two-stage review (spec compliance + code quality), and a whole-branch review at milestone end. Keep a `.superpowers` progress ledger so a compaction never re-dispatches finished work. **Model-selection policy (always name the model in the dispatch):** cheapest tier for transcription tasks where the plan contains complete code (most M2/M6 CRUD + `.xlsx` cell wiring); standard tier for override-DAG / monthly-cash-flow / research integration; **most-capable for the engine math rewrite (M1) and every milestone-end whole-branch review.** Use isolated git worktrees, one per milestone (`superpowers:using-git-worktrees`).

### 4. Verification before completion (evidence, not assertions)
**Never claim "done / fixed / passing" without fresh command output in the same message** (`superpowers:verification-before-completion`). A bare HTTP 200 is not proof. The verification bar:
- `pytest -q` → zero failures.
- The golden-reconcile test green (engine == `computed_json` == LibreOffice recalc).
- `python scripts/recalc.py <xlsx>` → `"total_errors": 0` **and** `"status": "success"` (fail closed: an error dict is a failure, not a pass).
- a11y check + browser QA at **1440 / 768 / 375** against the Appendix-D stress dataset, with screenshots.
- deploy healthcheck showing the **NEW build SHA** (not just any 200).

### 5. Review gates before landing
No milestone merges to `main` without all gates green: gstack `/review` (staff-eng bug hunt) → `/design-review` (a11y + AI-slop, for UI) → `/cso` (OWASP + STRIDE, for any new endpoint/auth/secret surface) → `/qa` (real browser, 1440/768/375) → `/ship` → `/land-and-deploy` (healthcheck verifies the new build). See [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md) for the tiered gate.

### 6. The engine golden-test is CI-blocking
The golden + LibreOffice reconciliation gate (PRD §13/§18) is the spine of correctness and **must be built in M1 before feature breadth**. CI must assert, **with and without overrides**: server compute == stored `computed_json` == LibreOffice recalc of the exported `.xlsx`, within **< $0.50** on dollar cells and **< 0.1pp** on percent cells, with **zero** formula errors (`recalc.py`'s error list: `#VALUE! #DIV/0! #REF! #NAME? #NULL! #NUM! #N/A`). Pin the LibreOffice/`soffice` version in the build image. This gate is what makes the "single math authority" claim true; if it is red, nothing lands.

### 7. Never put secrets or math in the client
All secrets are server-side env vars (`GOOGLE_PLACES_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO`, `CENSUS_API_KEY`, `CRM_API_KEY`). Never log, never commit, never send to the client, never put in a URL path/query. The server **refuses to boot in production** if a required secret is unset (no fallback chains). The browser never talks to Places/Census/GitHub/CRM directly. **The client computes nothing** — it sends inputs/overrides via `PATCH` and renders `computed_json`. See [SECURITY.md](./SECURITY.md).

---

## The engine is a rewrite, not a reuse (read this before touching M1)

The PRD calls the Python engine "the single math authority." **As-built it is not.** `reference/.../generate_projection.py` implements the OLD model and satisfies ~30% of v1: it is **annual-only**, hard-codes **Year-2 = midpoint** of Y1/Y3 (`compute()` line 65; Excel `=AVERAGE(...)` line 209), has **no monthly cash-flow**, **no decision metrics**, **no override/DAG**, treats supplies as a **fixed $3,700 line** (line 44), has **no Marketing line and no rent escalator**, and its Excel builder emits **unguarded divisions** (`=net/totrev` line 257, `=startup/Y1net` line 284) that produce `#DIV/0!` — an automatic recalc-gate failure.

**M1 is a versioned rewrite into a pure compute core**, keeping the bottom-up driver chain and blue-input/live-formula Excel styling as the *calibration seed*, extending everything else. The legacy script is retained **only as a calibration golden**. Each delta below is an M1 TDD task with a failing golden test first. Full spec in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md).

| Concern | As-built (`generate_projection.py`) | v1 requirement | Status |
|---|---|---|---|
| Driver chain (hh × share → donations → retail → customers → salvage → total) | EXISTS (`compute()` 63–94) | keep verbatim | **KEEP** |
| Blue input / live-formula Excel styling | EXISTS | keep | **KEEP** |
| Year-2 share | midpoint of Y1/Y3 (line 65) | **three explicit shares** (PRD §7.1) — kill `AVERAGE`; Y2 references its own blue input | **REWRITE** |
| Supplies & processing | fixed $3,700 (line 44) | **% of revenue, default 5.0%** (PRD §7.3) | **REWRITE** |
| Marketing & outreach | none | **% of revenue, default 3.75%** (new line) | **NEW** |
| Rent escalator | none | **`rent_y1 × (1+escalator)^(y-1)`, escalator 3.0%, Y2–Y3** | **NEW** |
| Monthly M0–M12 cash-flow | none | S-curve donation ramp, hire-date payroll, timed startup outflows; **Year-1 annual = roll-up of the 12 months** (PRD §10) | **NEW** |
| Decision metrics | none | break-even month; **capital required = Σ startup + \|peak cash shortfall\| + reserve buffer**; first-year cash gap; runway; sensitivity (PRD §12) | **NEW** |
| Override DAG | none | topological resolve; **no upstream back-solve**; derived rows/KPIs **non-pinnable** (server-enforced); key `"{node}#{year}"` (PRD §14) | **NEW** |
| Edge-case N/A | unguarded → `#DIV/0!` | explicit `null` + `flags` map; Excel `IF(denom=0,"",num/denom)` (PRD §12.4) | **NEW** |
| Output shape | positional tuples | the **Appendix-D view-model** as native output (below) | **NEW** |

### Resolved defaults (close PRD §7.3 open items; the golden fixtures use these)
| Driver | v1 default | Source |
|---|---|---|
| **Labor (payroll) % of revenue** | **60%** (slider editable) | **Owner decision ([DECISIONS.md](./DECISIONS.md))**; matches the original verified engine. Canonical golden runs at 60%; a 40% **design-parity** fixture reproduces the Appendix-D headline for design-QA. See [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) §1. |
| Average basket value | **$17.08** | reproduces prototype Y1 revenue ~$426,911 / break-even ~month 5 |
| Marketing & outreach % | 3.75% | PRD §7.3 |
| Supplies & processing % | 5.0% (replaces fixed supplies) | PRD §7.3 |
| Annual rent escalator | 3.0%, compounds Y2–Y3 (`(1+e)^(y-1)`) | PRD §7.3 |
| Cash reserve buffer | $25,000 | PRD §7.3/§12.1 |
| Donations / household / yr | 3 | PRD §7.3 |
| Salvage % of retail | 0.8% · Card fees 2.0% · Payroll tax 7.5% | methodology + PRD §7.3 |

### Numeric discipline
Compute in **cents/Decimal**; round only at display (whole dollars / 0.1%). The < $0.50 tolerance absorbs Python-Decimal vs LibreOffice-double divergence — document which side rounds. Totals/net/margin/KPIs are **always Excel formulas** over their component cells, even when a component is an overridden orange hard-coded value, so the sheet foots and the in-sheet `SUM` equals the server's resolved total.

### View-model contract (engine's native output — frontend and `.xlsx` share it)
`computed_json` serializes, by these exact names (PRD Appendix D), with `model_version` + `compute_schema_version` stamped on it: `reco{tag,headline,sub,...}` (server emits a **semantic `tag` enum** — `proceed|revise|find_cheaper_rent|raise_cash|delay|do_not_proceed` — the **client** maps enum→color token; the API never hard-codes hex), `metrics{capital,cashGap,breakeven}` + reasons, `kpis[]`, `monthly[]{revenue,expenses,net,cumulativeCash}`+`breakevenMonth`, `rows[]{label,group,y1,y2,y3,class,editable}`, `overrides[]{node,year,calculated,value,note,pinnedDate,affected[]}`, `evidence[]`, `settings{...}`, `flags`, `version`. Emit money/percent as `{raw, display}` so the client never re-derives formatting. See [DATA_MODEL.md](./DATA_MODEL.md) and [API_SPEC.md](./API_SPEC.md).

---

## Hard rules

- **Backend owns ALL logic.** The server is the single source of truth for math, validation, formatting, role checks, and flags. **No client-side computation** (PRD §13). The interactive prototype's `support.js` (`calcYears`/`calcMonthly`/`scenario`/`startupTotal`/`paybackYears`) is **forbidden in production** — the prototype is a *layout + view-model field-name reference only*.
- **Engine is the one version-locked math authority.** `model_version` is stamped on every `computed_json`. **Projections never silently recompute** on a newer engine — read returns the stored snapshot verbatim and surfaces "New model available"; `upgrade-model` writes a **new revision** preserving the prior (PRD §13).
- **Capability-token auth, no cookies.** Owner ≥256-bit, `view_slug` ≥128-bit, generated with a CSPRNG (`secrets.token_urlsafe`), stored **hashed** (SHA-256), compared **constant-time** (`hmac.compare_digest`). Secrets only in `localStorage` + URL fragment; **never in path/query/logs**; scrub the fragment after read. **Do NOT introduce a cookie/session** (re-adds CSRF the PRD designs out). Lists are **owner-scoped**, never global; never allow cross-owner read/write (PRD §20).
- **Every mutation needs `Authorization: Bearer` + `If-Match: <version>`.** Optimistic concurrency: `UPDATE ... SET version=version+1 WHERE id=? AND version=?`; 0 rows → **HTTP 409** with current server state in the body (reload/overwrite/save-as-copy). One revision snapshot per autosave settle (PRD §24/§25).
- **No raw HTML.** `narrative.body_md` and any user rich text are **server-side allowlist-sanitized** before storage and render (stored XSS = localStorage token theft = full projection takeover).
- **Feedback never leaks a projection.** GitHub issues carry only a random **`support_id`** + non-sensitive context (route, app version, `model_version`, timestamp). **No `view_slug`, no edit token, no resolvable link, no financial fields ever** (PRD §22).
- **LLM safety is an enforced invariant, not a prompt nicety.** Web text is **untrusted data** (strip injection markers); the model **extracts only from server-fetched snippets**; **unfetched citations are rejected**; **every numeric figure in narrative prose must exist in `computed_json` or generation is rejected** (PRD §16/§17). These are CI tests with stubbed providers.
- **AI opt-out must work end-to-end.** The app computes, saves, and exports `.xlsx` with **zero AI calls** (manual rent, no narrative) — verified by a test run with all AI keys unset (PRD §21).
- **Terms acceptance before export/share** (planning estimates — not advice) (PRD §21).
- **DB discipline.** Additive-only migrations (`ALTER TABLE ADD COLUMN`); never DROP/recreate tables; never string-concatenate SQL; app-generated string PKs (UUID/ULID); no SQLite-only SQL above the `Store` interface so the Postgres path stays drop-in. Pre-migration Litestream snapshot.
- **SSRF guard on the research fetcher.** Block private/link-local/loopback/metadata ranges and redirects to them.

---

## Top damage risks

1. **Treating M1 as "wire up the existing engine."** It is a rewrite (~70% net-new: monthly cash-flow, decision metrics, % cost lines, escalator, three shares, override DAG). Scope it from the gap table above.
2. **Shipping a second math authority** by porting the prototype's client `calc*` functions — violates PRD §13 and breaks the golden gate. All math is server-side.
3. **Leaking a resolvable projection link into GitHub feedback** (PRD §22). Only `support_id`.
4. **Cross-owner data access / global list** — every query is owner-scoped (PRD §20).
5. **A mutation without `If-Match`/409, or a secret in a URL path** (PRD §20/§25).
6. **A confidently-wrong decision metric** (break-even / capital / ramp). Label confidence, show sensitivity, calibrate against real openings (PRD §6.3 backlog).

## Regression registry (check before coding; seeded from PRD traps)

| # | Trap | Rule | Ref |
|---|---|---|---|
| 1 | Year-2 = midpoint | Three explicit shares; kill `AVERAGE`; Y2 has its own input | §7.1 |
| 2 | `#DIV/0!` in Excel | Guard every division `IF(denom=0,"",num/denom)`; emit explicit `null`+`flags` | §12.4/§18 |
| 3 | Override back-solves upstream | No back-solve; flag orphaned upstream; recompute is topological | §14 |
| 4 | Pinning a derived/total/KPI cell | Non-pinnable; **reject server-side**, not just hidden in UI | §14 |
| 5 | Narrative figure not in `computed_json` | Reject generation | §17 |
| 6 | LLM citation not server-fetched | Reject the citation | §16 |
| 7 | Feedback carries a projection link | Only random `support_id`; no financial fields | §22 |
| 8 | Client computes math | Backend owns logic; render `computed_json` only | §13/§22(22) |
| 9 | Mutation without `If-Match` | Require it; real 409 + current state | §25 |
| 10 | Secret in URL path/query/log | Fragment only; scrub after read | §20 |
| 11 | Cookie/session reintroduced | Bearer-token only — no CSRF surface | §20 |
| 12 | Silent recompute on new engine | Return stored snapshot; upgrade = new revision | §13 |
| 13 | Litestream replicating `/app` (timpager bug) | Replicate **`/data/projections.db`** | §26 |
| 14 | Boot with missing secret / fallback chain | Refuse to boot in prod; single-source env requirements | §20 |
| 15 | Annual P&L drifts from monthly | Year-1 annual = roll-up of M0–M12; golden asserts equality | §10.2 |

## Vocabulary

| Term | Meaning |
|---|---|
| projection | The saved model (one per `id`/`view_slug`). |
| revision | Snapshot per autosave settle / restore. |
| override / pin | A user-fixed value on a DAG node, key `"{node}#{year}"`. Components only — never derived rows/KPIs. |
| `view_slug` | Read-only lookup key (plaintext, ≥128-bit). |
| owner / edit token | Capability secrets (hashed at rest); edit token via URL fragment. |
| `support_id` | Random feedback id; the only thing in a GitHub issue. |
| `model_version` / `compute_schema_version` | Math version / view-model shape version, both stamped on `computed_json`. |

---

## Doc map

| Topic | File |
|---|---|
| Authoritative requirements (the product) | [reference/PRD.md](./reference/PRD.md) |
| Design brief (table-first, dense, finance-grade, a11y) | [reference/DESIGN_PROMPT.md](./reference/DESIGN_PROMPT.md) |
| System architecture, project layout, endpoint→module map | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Milestones (M-1…M7), entry gates, deliverables | [BUILD_PLAN.md](./BUILD_PLAN.md) |
| Engine formulas, defaults, override resolution, Excel cell contract, golden gate | [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) |
| SQLite schema, `computed_json`/view-model fields, versioning | [DATA_MODEL.md](./DATA_MODEL.md) |
| REST endpoints, `If-Match`/409, request/response shapes | [API_SPEC.md](./API_SPEC.md) |
| Capability tokens, secrets/env, CSP/CORS, sanitization, SSRF, rate limits, LLM grounding | [SECURITY.md](./SECURITY.md) |
| Railway/Litestream, restore drill, RPO/RTO, migrations, incidents | [OPS_RUNBOOK.md](./OPS_RUNBOOK.md) |
| The build loop, review gates, model-selection policy | [AGENTS.md](./AGENTS.md) |
| Tiered gate, Mutation Safety quad, Failure Mode Registry, Verification Bar | [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md) |
| Branching, TDD, Docs-Are-Code, PR checklist | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Redacted feedback → GitHub + intent → CRM (idea fab) | [IDEA_FAB.md](./IDEA_FAB.md) |
| Calibration seed engine + LibreOffice recalc gate | `reference/thrift-store-projections-skill/scripts/{generate_projection.py,recalc.py}` |
| Worked config + method | `reference/.../examples/house_of_hope.json`, `reference/.../reference/methodology.md` |

## Sample fixtures (golden tests, from day one)

Ship these three named projections as golden fixtures pinned to `model_version`; they drive design, edge-case math, and the recalc gate (PRD §12.4/§13/§18):
1. **House of Hope** — shares 6/8/10%, basket $17.08. **Canonical fixture runs at labor 60%** (owner default): Y1 revenue ~$426,911 (labor-independent), with margin/capital/reco pinned at 60% at fixture-gen. A **40% design-parity twin** reproduces the prototype headline (~11% margin, capital ~$277,990, break-even ~month 5, reco=proceed) for design-QA only. See [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) §1/§10 and [DECISIONS.md](./DECISIONS.md).
2. **Aggressive (flagged)** — shares 15/20/25% (the legacy `house_of_hope.json` values), ~39% margin; **must** trigger the §12.2 net-margin guardrail and require a justification note that travels into the packet.
3. **Grace Mission (loss case)** — negative Y1 net, payback **N/A — no Year 1 profit**, low-confidence $14/sqft rent, one **overridden Payroll cell**; must render cleanly (parentheses for negatives, explicit `null`, never `#DIV/0!`) and recalc clean **with the override present**.

## Docs Are Code

Any PR touching the engine, the API contract (`computed_json`/view-model), or the schema **must** update the matching doc (ENGINE_CONTRACT / API_SPEC / DATA_MODEL) in the same PR. Keep plans in `docs/plans/`; do not create new tracking files.

## M-1 is a hard gate (do not skip)

Before heavy build of M3+ (research/narrative/overrides), the program is gated on **M-1 pre-build validation**: 20 ICP interviews · 10 manually produced projections · 5 users who share with a board/funder · 3 paid or sales-qualified conversions, plus a human go/no-go (PRD §28). An eager agent must not barrel past this. The free-vs-paid gate (PRD §3) is a config decision, not a rebuild.

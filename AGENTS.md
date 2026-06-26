<!-- AGENT INSTRUCTIONS — read and obey before writing any code. -->
# projections — Thrift Store Projection Web App

> **Global engineering contract:** https://github.com/rallytasks/agents/blob/main/AGENTS.md
> Every rule there applies to this repo. This file adds only project specifics and any `Override <ID>:`.
@../../agents/AGENTS.md   <!-- local-checkout convenience; no-op in a standalone clone -->

A **decision-and-funding tool (not a calculator)** that helps a first-time nonprofit thrift-store operator decide *whether and how* to launch and produces a board/funder-ready case. From a few inputs it researches the local trade area + market rent, builds a monthly launch cash-flow + a 3-year projection with KPIs and **decision outputs** (break-even month, startup capital required, first-year cash gap, rules-based go/no-go), and exports a cited Board Packet + a formula-driven `.xlsx`. Every number shows its evidence and confidence.

> **Mandate.** Server-authoritative compute, capability-token access, grounded narrative, a board-defensible trust layer — plan-first, TDD-enforced, subagent-driven, milestone by milestone, with the engine as the verification oracle.

**Status:** scaffolded, **not yet built**. The Python script in `reference/` is a *calibration seed*, not the v1 engine (see "Engine is a rewrite").

**Read first:** [reference/PRD.md](./reference/PRD.md) (authoritative) → this file → [ARCHITECTURE.md](./ARCHITECTURE.md) → [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) → [BUILD_PLAN.md](./BUILD_PLAN.md) → [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md).

## Project facts
| Fact | Value |
|---|---|
| Backend | Python **FastAPI**; server-authoritative compute (PRD §13). |
| Frontend | **React 18 + TS + Vite**; TanStack Query; hand-rolled SVG charts. **No client-side math.** |
| Storage | **SQLite (WAL)** + `busy_timeout`, serialized writes; **Litestream** replication (PRD §26). |
| Deploy | **Railway** in the thriftly.com project; volume at `/data`; `DB_PATH=/data/projections.db` (NOT `/app`). |
| Access | **No login. Capability tokens.** Owner bearer (≥256-bit) in `localStorage`; `view_slug` (≥128-bit) lookup key; edit/role secrets in URL fragment only. No cookies ⇒ no CSRF. |
| AI | Anthropic primary, OpenAI fallback; extract-only research + citation validation; numeric-grounded narrative; works fully with AI disabled. |
| Scope key | owner token (owner-scoped lists, never global). |

**ICP (judge everything against it):** one small nonprofit/church-backed operator planning their *first* store in 3–12 months; user = ED/ops lead/volunteer, not a finance expert; buyer = board/treasurer. Multi-store, for-profit, chains are **out of v1**.

## Method: two systems
- **gstack** supplies the **review gates** — `/office-hours`, `/autoplan` (CEO→design→eng→DX), `/review`, `/design-review`, `/qa`, `/cso`, `/ship`, `/land-and-deploy`. (Who looks, and when.)
- **Superpowers** supplies the **inner loop** — `brainstorming`, `writing-plans`, `using-git-worktrees`, `subagent-driven-development`, `test-driven-development`, `requesting/receiving-code-review`, `systematic-debugging`, `verification-before-completion`. (How a unit of work is produced.)

Per-feature loop: `(brainstorm only for new surface) → plan reviews (/autoplan, writing-plans → docs/plans/YYYY-MM-DD-*.md, TDD tasks + Global Constraints verbatim from PRD) → isolate (worktree) → TDD via subagents → verify (evidence) → review (whole-branch + required lenses + /qa + /cso) → ship (/ship → /land-and-deploy; healthcheck shows the NEW build SHA)`. No milestone merges without every required gate green.

## Project rules & overrides (project law; full text in the linked docs)
- **No client-side math, ever (PRD §13).** The prototype's `support.js` (`calcYears`/`calcMonthly`/`scenario`/`startupTotal`/`paybackYears`) is a **layout + field-name reference only** — porting its math is a P0 violation and breaks the golden gate. The client sends inputs/overrides via `PATCH` and renders `computed_json`.
- **Engine is the one version-locked math authority.** `model_version` + `compute_schema_version` stamped on every `computed_json`. **Never silently recompute** — read returns the stored snapshot and surfaces "new model available"; `upgrade-model` writes a NEW revision preserving the prior.
- **Capability-token auth, no cookies.** Owner ≥256-bit, `view_slug` ≥128-bit, CSPRNG-generated, stored **hashed** (SHA-256), compared constant-time. Secrets only in `localStorage` + URL fragment; never in path/query/logs; scrub the fragment after read. Do NOT add a cookie/session (re-adds CSRF). (Specializes `SESSION`/`SECRETS`.)
- **Every mutation needs `Authorization: Bearer` + `If-Match: <version>`.** Optimistic concurrency `UPDATE ... SET version=version+1 WHERE id=? AND version=?`; 0 rows → **HTTP 409** with current server state. One revision snapshot per autosave settle. (Specializes `API`/`MUTATION`.)
- **No raw HTML.** `narrative.body_md` and any user rich text are server-side allowlist-sanitized before storage and render (stored XSS = token theft).
- **Feedback never leaks a projection (PRD §22).** GitHub issues carry only a random `support_id` + non-sensitive context. No `view_slug`, edit token, resolvable link, or financial field — ever. CI test.
- **LLM safety is enforced by tests, not prompts.** Web text is untrusted (strip injection markers); the model extracts only from server-fetched snippets; unfetched citations are rejected; every numeric figure in narrative prose must exist in `computed_json` or generation is rejected. CI with stubbed providers; no happy-path-only grounding tests. (Specializes `AI`/`INJECTION`.)
- **AI opt-out works end-to-end.** A test runs create → compute → save → `.xlsx` with all AI keys unset.
- **Terms acceptance before export/share** (planning estimates, not advice).
- **DB discipline.** Additive-only migrations; never DROP/recreate; app-generated string PKs (UUID/ULID); no SQLite-only SQL above the `Store` interface so the Postgres path stays drop-in; pre-migration Litestream snapshot. (Specializes `DB`.)
- **Boot-refuses on missing secrets** in prod; single source, no fallback chains. Required: `DB_PATH`, `GOOGLE_PLACES_API_KEY`, `CENSUS_API_KEY`, ≥1 AI provider (`ANTHROPIC_API_KEY` primary / `OPENAI_API_KEY` fallback). **SSRF guard** on the research fetcher (block private/link-local/loopback/metadata + redirects to them).
- **Subagent model policy (name the model in every dispatch):** cheapest = transcription (M2/M6 CRUD, `.xlsx` wiring); standard = override-DAG / monthly cash-flow / research integration; **most-capable = the M1 engine rewrite + every milestone-end whole-branch review.** Keep a `.superpowers` progress ledger.
- **Golden gate is CI-blocking (the spine).** With and without overrides, assert server compute == stored `computed_json` == LibreOffice recalc of the exported `.xlsx`, within <$0.50 on dollar cells / <0.1pp on percent cells, zero formula errors. Pin the `soffice` version. Must be built in M1 before feature breadth.

## Verification bar (proof, not assertions)
`pytest -q` (0 failures) · golden 3-way reconcile green · `python scripts/recalc.py <xlsx>` → `status:"success"` AND `total_errors:0` (an error dict is a failure) · UI: `/qa` screenshots @ 1440/768/375 on the stress dataset · deploy: healthcheck JSON showing the NEW build SHA (a bare 200 is not proof).

## Engine is a REWRITE, not a reuse (read before M1)
`reference/.../generate_projection.py` is the OLD model (~30% of v1): annual-only, Year-2 = midpoint, no monthly cash-flow, no decision metrics, no override DAG, supplies as a fixed $3,700, no Marketing line, no rent escalator, unguarded `#DIV/0!` divisions. M1 is a versioned rewrite into a pure compute core, keeping the bottom-up driver chain + blue-input Excel styling as the calibration seed. Full deltas + view-model contract: [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md). Key deltas: three explicit Y1/Y2/Y3 shares (kill `AVERAGE`); supplies 5.0% of revenue; Marketing 3.75% (new); rent escalator 3.0% compounding Y2–Y3 (new); monthly M0–M12 cash-flow with Year-1 = roll-up of the 12 months (new); decision metrics (new); override DAG — topological, no back-solve, derived rows/KPIs non-pinnable, server-enforced (new); explicit `null` + `flags` with `IF(denom=0,"",…)` guards; Appendix-D view-model as native output. **Resolved defaults:** labor 60% canonical (slider editable; a 40% design-parity twin reproduces the prototype headline), basket $17.08, reserve $25,000, donations/hh/yr 3, salvage 0.8%, card fees 2.0%, payroll tax 7.5%. Compute in cents/Decimal; round only at display.

## Top damage risks
1. Treating M1 as "wire up the existing engine" — it's a ~70% net-new rewrite. 2. Shipping a second math authority by porting the prototype `calc*`. 3. Leaking a resolvable projection link into GitHub feedback. 4. Cross-owner data access / global list. 5. A mutation without `If-Match`/409, or a secret in a URL path. 6. A confidently-wrong decision metric — label confidence, show sensitivity, calibrate.

## Regression registry (check before coding; seeded from PRD traps)
| # | Trap | Rule | Ref |
|---|---|---|---|
| 1 | Year-2 = midpoint | Three explicit shares; kill `AVERAGE`; Y2 has its own input | §7.1 |
| 2 | `#DIV/0!` in Excel | Guard every division `IF(denom=0,"",num/denom)`; emit `null`+`flags` | §12.4/§18 |
| 3 | Override back-solves upstream | No back-solve; flag orphaned upstream; topological recompute | §14 |
| 4 | Pinning a derived/total/KPI cell | Non-pinnable; reject server-side, not just hidden | §14 |
| 5 | Narrative figure not in `computed_json` | Reject generation | §17 |
| 6 | LLM citation not server-fetched | Reject the citation | §16 |
| 7 | Feedback carries a projection link | Only random `support_id`; no financial fields | §22 |
| 8 | Client computes math | Backend owns logic; render `computed_json` only | §13 |
| 9 | Mutation without `If-Match` | Require it; real 409 + current state | §25 |
| 10 | Secret in URL path/query/log | Fragment only; scrub after read | §20 |
| 11 | Cookie/session reintroduced | Bearer-token only — no CSRF surface | §20 |
| 12 | Silent recompute on new engine | Return stored snapshot; upgrade = new revision | §13 |
| 13 | Litestream replicating `/app` | Replicate `/data/projections.db` | §26 |
| 14 | Boot with missing secret / fallback chain | Refuse to boot in prod; single-source env | §20 |
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
| `model_version` / `compute_schema_version` | Math version / view-model shape version, stamped on `computed_json`. |

## M-1 is a hard gate (do not skip)
Before heavy build of M3+ (research/narrative/overrides): 20 ICP interviews · 10 manual projections · 5 board/funder shares · 3 paid-or-SQL conversions + a human go/no-go (PRD §28). Don't barrel past it. The free-vs-paid gate (PRD §3) is a config decision, not a rebuild. Milestone scope/sequencing: [BUILD_PLAN.md](./BUILD_PLAN.md).

## Doc map
| Topic | File |
|---|---|
| Authoritative requirements | [reference/PRD.md](./reference/PRD.md) |
| Design brief | [reference/DESIGN_PROMPT.md](./reference/DESIGN_PROMPT.md) |
| Architecture, endpoint→module map | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Milestones, entry gates | [BUILD_PLAN.md](./BUILD_PLAN.md) |
| Engine formulas, defaults, Excel cell contract, golden gate | [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) |
| Schema, `computed_json`/view-model, versioning | [DATA_MODEL.md](./DATA_MODEL.md) |
| Endpoints, `If-Match`/409 | [API_SPEC.md](./API_SPEC.md) |
| Tokens, secrets, CSP/CORS, sanitization, SSRF, grounding | [SECURITY.md](./SECURITY.md) |
| Railway/Litestream, restore drill, migrations | [OPS_RUNBOOK.md](./OPS_RUNBOOK.md) |
| Tiered gate, Mutation Safety quad, Verification Bar | [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md) |
| Branching, TDD, Docs-Are-Code, PR checklist | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Redacted feedback → GitHub + intent → CRM | [IDEA_FAB.md](./IDEA_FAB.md) |
| Decisions log (labor % etc.) | [DECISIONS.md](./DECISIONS.md) |

<!-- AGENT INSTRUCTIONS — read and obey before writing any code. -->
# projections — Thrift Store Projection web app (a decision-and-funding tool, not a calculator)

A server-authoritative tool that helps a first-time nonprofit thrift-store operator decide **whether and how** to launch, and produces a board/funder-ready case for it. From a few inputs it researches the local trade area + market rent, builds a **monthly launch cash-flow** plus a **5-year projection** with KPIs and **decision outputs** (break-even month, startup capital required, first-year cash gap, rules-based go/no-go), and exports a cited **Board Packet** and a formula-driven `.xlsx`. Every number shows its evidence and confidence. Monthly cash-flow is anchored to Year 1; Year 2–5 are annual.

> **Global engineering contract:** https://github.com/rallytasks/agents/blob/main/AGENTS.md
> Every rule there applies to this repo. Cite rules by ID — `SECRETS`, `TENANT`, `DB`, `MUTATION`, `SERVER`, `OUTBOUND`, `MONEY`, `DESTRUCTIVE`, `INJECTION`, `PLAN`, `TDD`, `VERIFY`, `GIT`, `DOCS`, `HYGIENE`, `PATTERNS`, `REGRESSIONS`, `TRACKING`, `STYLE`, `STANDARD`, `API`, `SESSION`, `PII`, `AI`, `UI`, plus the portfolio conventions (Feedback FAB, Maximum parallelization). This file adds **only** project specifics and any `Override <ID>:` line. Shared rules live in the global file **once** — they are never copied here. A `grep "Override "` of this file lists exactly where projections diverges.
@../../agents/AGENTS.md   <!-- local-checkout convenience; projections is nested one level deeper, so two `..`. No-op in a standalone clone — the URL above is canonical. -->

**`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`; never edit `CLAUDE.md`.**

**Read first:** [reference/PRD.md](./reference/PRD.md) (authoritative requirements) → this file → [ARCHITECTURE.md](./ARCHITECTURE.md) → [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) → [BUILD_PLAN.md](./BUILD_PLAN.md) → [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md) (the bar).

**Status:** built & deployed (engine 2.7.0, 5-year horizon, redesign v2). The Python script in `reference/` is a *calibration seed*, not the v1 engine — see [The engine is a rewrite](#the-engine-is-a-rewrite-not-a-reuse-read-before-touching-m1).

---

## Stack

| Fact | Value |
|---|---|
| Backend | Python **FastAPI**; server-authoritative compute (PRD §13). |
| Frontend | **React 18 + TypeScript + Vite**; TanStack Query for server cache; hand-rolled SVG charts. No client-side math (PRD §13, §22 item 22). |
| Storage | **SQLite (WAL)** + `busy_timeout`, serialized writes; **Litestream** continuous replication to object storage (PRD §26). |
| Deploy | **Railway** service in the **thriftly.com** project; durable volume at **`/data`**; **`DB_PATH=/data/projections.db`** (NOT `/app` — see [OPS_RUNBOOK.md](./OPS_RUNBOOK.md)). |
| Access | **Capability tokens** for viewers (no login) ⊕ an **optional Clerk satellite login** for the owner/editor, ship-dark behind `CLERK_ENABLED` (see `Override SESSION` below). |
| AI | Anthropic primary, OpenAI fallback; **extract-only** research with citation validation; **numeric-grounded** narrative. Compute works fully with AI disabled (PRD §16/§17/§21). |
| Health | `GET /api/health`. |
| Key files (once built) | `engine/compute.py` (pure math), `engine/monthly.py`, `dag.py`, `decision.py`, `xlsx.py`, `packet.py`, `model.py` (constants + versions), `engine/tests/golden/`; `app/main.py`, `app/deps.py`, `app/routers/`, `app/store/` (`base.py` Protocol, `sqlite.py`, `postgres.py` stub). |
| Reference | `reference/PRD.md`, `reference/DESIGN_PROMPT.md`, `reference/thrift-store-projections-skill/` (SKILL.md, `methodology.md`, `scripts/generate_projection.py`, `scripts/recalc.py`, `examples/house_of_hope.json`). |

## Commands

test: `pytest -q` · golden: `pytest engine/tests/test_golden_gate.py -q` (3-way reconcile) · recalc: `python reference/thrift-store-projections-skill/scripts/recalc.py <xlsx>` (assert `status=="success"` **and** `total_errors==0`; fail closed on an `{"error":…}` dict) · ratio: `python scripts/ratio.py` · front: `npm test -- --run` / `npm run typecheck` (no web lint gate — eslint was never configured; #374) · health: `GET /api/health` shows the **new build SHA**.
This is the project's concrete `VERIFY` proof set; the full Verification Bar table is the single home in [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md).

## Beachhead ICP (judge everything against it)

One small nonprofit/church-backed operator planning their **first** store in 3–12 months; the **user** is an ED/ops lead/volunteer who is **not** a finance expert; the **buyer** is a board/treasurer. Multi-store, for-profit, and chains are **out of scope for v1** (PRD §2).

## Vocabulary (satisfies `UI`)

| User sees | Code uses | Never say in UI |
|---|---|---|
| Projection | `projection` (one per `id`/`view_slug`) | — |
| Saved version | `revision` (snapshot per autosave settle / restore) | — |
| Override / pin | a user-fixed value on a DAG node, key `"{node}#{year}"` — components only, never derived rows/KPIs | "DAG node" |
| Share link | `view_slug` (read-only lookup key, plaintext, ≥128-bit) | "slug" |
| Edit / recovery link | owner / edit token (capability secret, hashed at rest; edit token via URL fragment) | "bearer token" |
| Feedback id | `support_id` (random; the only thing in a GitHub issue) | — |
| Model version | `model_version` / `compute_schema_version` (math version / view-model shape, both stamped on `computed_json`) | — |

## Top damage risks (the single home — DoD references this)

1. **Treating M1 as "wire up the existing engine."** It is a rewrite (~70% net-new: monthly cash-flow, decision metrics, % cost lines, escalator, three shares, override DAG). Scope it from the gap table below.
2. **Shipping a second math authority** by porting the prototype's client `calc*` functions — violates `SERVER`/PRD §13 and breaks the golden gate.
3. **Leaking a resolvable projection link / financial field into GitHub feedback** (PRD §22). Only `support_id`.
4. **Cross-owner data access / global list** — every query is owner-scoped (`TENANT`, PRD §20).
5. **A mutation without `If-Match`/409, or a secret in a URL path/log** (`MUTATION`/`SESSION`, PRD §20/§25).
6. **A confidently-wrong decision metric** (break-even / capital / ramp). Label confidence, show sensitivity, calibrate against real openings (PRD §6.3 backlog).

---

## Project rules & overrides

Every bullet is project-specific or overrides a global default. Generic rules (plan-first, red-green TDD, evidence-before-done, secrets-in-env, branch/CI/deploy, additive migrations, parameterized SQL, untrusted-input-is-data, WCAG-AA, YAGNI) are **not** restated — they live in the global file under the cited ID.

- **ENGINE — the one version-locked math authority** (extends `SERVER` + `MONEY`). `model_version` + `compute_schema_version` are stamped on every `computed_json`. Projections **never silently recompute** on a newer engine — read returns the stored snapshot verbatim and surfaces "New model available"; `upgrade-model` writes a **new revision** preserving the prior (PRD §13). The engine is the *one* math authority; the server emits display strings as the *one* formatting authority (`{raw, display}`) — DRY. It is a **rewrite, not a reuse** ([below](#the-engine-is-a-rewrite-not-a-reuse-read-before-touching-m1)).
- **NO-CLIENT-MATH** (`SERVER`, load-bearing here). The interactive prototype's `support.js` (`calcYears`/`calcMonthly`/`scenario`/`startupTotal`/`paybackYears`) is **forbidden in production** — the prototype is a *layout + view-model field-name reference only*. The client sends inputs/overrides via `PATCH` and renders `computed_json` (PRD §13).
- **GOLDEN — the three-way reconcile is CI-blocking** (extends `VERIFY` + `TDD`). server compute == stored `computed_json` == LibreOffice recalc of the exported `.xlsx`, **with AND without overrides**, within **< $0.50** on dollar cells / **< 0.1pp** on percent cells, with **zero** formula errors (`#VALUE! #DIV/0! #REF! #NAME? #NULL! #NUM! #N/A`). Pin the `soffice` version in the build image. **Built in M1 before feature breadth;** if it is red, nothing lands (PRD §13/§18). Full gate in [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md).
- **Override SESSION + Override TENANT — capability tokens for viewers ⊕ optional Clerk owner login, cookie-blind API.** Owner ≥256-bit bearer in `localStorage`; `view_slug` ≥128-bit plaintext **lookup key**; edit/role secrets in the **URL fragment only** (scrubbed after read with `searchParams.delete()` + `replaceState()`; **never** in path/query/logs). Generated with a CSPRNG (`secrets.token_urlsafe`), stored **hashed** (SHA-256), compared **constant-time** (`hmac.compare_digest`). The global `SESSION` HttpOnly-cookie model does not apply. **Clerk satellite amendment (ship dark behind `CLERK_ENABLED`; supersedes the "no login / no cookies" clause for the OWNER/editor only — approved override, `docs/plans/2026-06-27-clerk-satellite-auth.md` §0 + [SECURITY.md](./SECURITY.md) §2.8):** projections.thriftly.com is a cross-apex Clerk **satellite** of the rallytasks.com primary. When enabled, the owner/editor may sign in via Clerk and owner-scope keys on the Clerk `userId`/`orgId` (`owner_clerk_user_id`/`owner_org_id`, additive, nullable — a row is token-owned OR clerk-owned; *claim* is a follow-up); **viewers (board/funder/advisor) NEVER log in — capability share-links are preserved verbatim.** Our FastAPI verifies a short-lived Clerk session JWT in `Authorization: Bearer` **networklessly against the primary's JWKS** (`app/clerk/verify.py`; RS256-only, `iss`/`exp`/`nbf`/`azp` enforced, fail-closed) and holds **NO Clerk secret** (finding C1 — boot refuses if `CLERK_SECRET_KEY`/`CLERK_WEBHOOK_SIGNING_SECRET` is set). The API is **cookie-blind by invariant** — it never reads `request.cookies`, not even the Clerk `__session` cookie — so there is **still no CSRF** (Regression #11 preserved). With `CLERK_ENABLED` off (the default), the app is byte-for-byte the capability-token app it is today. **Do NOT introduce a cookie our API trusts.** `TENANT` still applies in full across BOTH key types: lists are owner-scoped, never global; no cross-owner read/write (PRD §20).
- **Mutation Safety Quad** (instantiates `MUTATION` + `TENANT` in the capability-token model). Every `PATCH`/`POST` has all four, **each with a test**: (a) `Authorization: Bearer` required → 401 otherwise; (b) owner-scope isolation (owner A cannot touch owner B); (c) `If-Match: <version>` optimistic concurrency — `UPDATE … SET version=version+1 WHERE id=? AND version=?`; 0 rows → **HTTP 409** with current server state (reload / overwrite / save-as-copy); (d) negative/abuse path with **per-IP + per-token** rate limit. One revision snapshot per autosave settle (PRD §24/§25).
- **Override DAG is server-enforced.** Topological resolve; **no upstream back-solve**; derived rows / totals / KPIs are **non-pinnable** — pin writes to them are **rejected at the API boundary**, not just hidden in the UI; stale-upstream rows are flagged; override key `"{node}#{year}"` (PRD §14).
- **LLM-GROUNDING** (extends `AI` + `INJECTION`). Web text is **untrusted data** (strip injection markers); the model **extracts only from server-fetched snippets**; **unfetched citations are rejected**; **every numeric figure in narrative prose must exist in `computed_json` or generation is rejected**; SSRF guard on the research fetcher (block private/link-local/loopback/metadata ranges + redirects to them). **AI opt-out works end-to-end** — full create → compute → save → `.xlsx` with all AI keys unset. These are **adversarial CI tests with stubbed providers**, not prompt niceties (PRD §16/§17/§21).
- **FEEDBACK — leaks nothing but `support_id`** (extends portfolio Feedback FAB + `PII`). GitHub issues carry only a random `support_id` + non-sensitive context (route, app version, `model_version`, timestamp). **No `view_slug`, no edit token, no resolvable link, no financial fields ever** (PRD §22). CI redaction test.
- **No raw HTML** (`INJECTION`). `narrative.body_md` and any user rich text are server-side **allowlist-sanitized** before storage and render — stored XSS = `localStorage` bearer-token theft = full projection takeover (also `SESSION`).
- **Terms acceptance before export/share** (planning estimates, not advice) (PRD §21).
- **Override DB** (project deltas only; the rest — additive-only migrations, no DROP/recreate, parameterized SQL, app-generated string PKs — per global `DB`). No SQLite-only SQL above the `Store` interface so the Postgres path stays drop-in; take a **pre-migration Litestream snapshot**; DB at `DB_PATH=/data/projections.db` (never `/app`).
- **DOCS-CODE** (instantiates `DOCS`). Any PR touching the engine, the API contract (`computed_json`/view-model), or the schema **updates the matching doc — `ENGINE_CONTRACT.md` / `API_SPEC.md` / `DATA_MODEL.md` — in the same PR**. Keep plans in `docs/plans/` (no new tracking files, per `TRACKING`).
- **M-1 is a hard gate** (do not skip). Before heavy build of M3+ (research/narrative/overrides): **20 ICP interviews · 10 manual projections · 5 board/funder shares · 3 paid-or-SQL conversions**, plus a human go/no-go (PRD §28). An eager agent must not barrel past this. The free-vs-paid gate (PRD §3) is a config decision, not a rebuild.
- **MODEL-SELECTION** (instantiates portfolio "Maximum parallelization"). **Name the model in every subagent dispatch** — never inherit the session default. *cheapest* = transcription where the plan contains complete code (most M2/M6 CRUD, `.xlsx` cell wiring); *standard* = integration/glue (override-DAG, monthly cash-flow, research retrieval, 409 handling); *most-capable* = the **M1 engine rewrite + decision-metric solver + every milestone-end whole-branch review**. Keep a `.superpowers` progress ledger so a compaction never re-dispatches finished work.

---

## The engine is a rewrite, not a reuse (read before touching M1)

The PRD calls the Python engine "the single math authority." **As-built it is not.** `reference/.../generate_projection.py` implements the OLD model and satisfies ~30% of v1: it is **annual-only**, hard-codes **Year-2 = midpoint** of Y1/Y3 (`compute()` L65; Excel `=AVERAGE(...)` L209), has **no monthly cash-flow**, **no decision metrics**, **no override/DAG**, treats supplies as a **fixed $3,700 line** (L44), has **no Marketing line and no rent escalator**, and emits **unguarded divisions** (`=net/totrev` L257, `=startup/Y1net` L284) that produce `#DIV/0!` — an automatic recalc-gate failure.

**M1 is a versioned rewrite into a pure compute core**, keeping the bottom-up driver chain and blue-input/live-formula Excel styling as the *calibration seed* and extending everything else. The legacy script is retained **only as a calibration golden**. Each row below is an M1 TDD task: write the failing golden test first. **The full gap table, formula spec, and resolved defaults are authoritative in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md);** this is the single working summary.

| Concern | As-built (`generate_projection.py`) | v1 requirement | Status |
|---|---|---|---|
| Driver chain (hh × share → donations → retail → customers → salvage → total) | `compute()` L63–94 | keep verbatim | **KEEP** |
| Blue input / live-formula Excel styling | exists | keep + extend | **KEEP** |
| Year-2 share | midpoint of Y1/Y3 (L65) | **three explicit shares** (PRD §7.1) — kill `AVERAGE`; Y2 has its own blue input | **REWRITE** |
| Supplies & processing | fixed $3,700 (L44) | **% of revenue, default 5.0%** (PRD §7.3) | **REWRITE** |
| Marketing & outreach | none | **% of revenue, default 3.75%** (new line) | **NEW** |
| Rent escalator | none | **`rent_y1 × (1+escalator)^(y-1)`, 3.0%, Y2–Y3** | **NEW** |
| Monthly M0–M12 cash-flow | none | S-curve donation ramp, hire-date payroll, timed startup outflows; **Year-1 annual = roll-up of the 12 months** (PRD §10) | **NEW** |
| Decision metrics | none | break-even month; **capital required = \|peak cash shortfall\| + reserve buffer** (the monthly trough already embeds startup; never add it twice); first-year cash gap; runway; sensitivity (PRD §12) | **NEW** |
| Override DAG | none | topological resolve; **no upstream back-solve**; derived rows/KPIs **non-pinnable** (server-enforced); key `"{node}#{year}"` (PRD §14) | **NEW** |
| Edge-case N/A | unguarded → `#DIV/0!` | explicit `null` + `flags` map; Excel `IF(denom=0,"",num/denom)` (PRD §12.4) | **NEW** |
| Output shape | positional tuples | the **Appendix-D view-model** as native output (below) | **NEW** |

**Resolved defaults** (close PRD §7.3 open items; the golden fixtures use these — full table in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) §1):

| Driver | v1 default | Source |
|---|---|---|
| **Labor (payroll) % of revenue** | **60%** (slider editable) | **Owner decision** ([DECISIONS.md](./DECISIONS.md)); matches the original verified engine. Canonical golden runs at 60%; a **40% design-parity** twin reproduces the Appendix-D headline for design-QA only. *(See note in [Sample golden fixtures](#sample-golden-fixtures-ship-as-goldens-from-day-one) — DECISIONS.md still carries a 40% "CLOSED" entry; the owner override at 60% governs.)* |
| Average basket value | **$17.08** | reproduces prototype Y1 revenue ~$426,911 / break-even ~month 5 |
| Marketing & outreach % | 3.75% | PRD §7.3 |
| Supplies & processing % | 5.0% (replaces fixed supplies) | PRD §7.3 |
| Annual rent escalator | 3.0%, compounds Y2–Y3 (`(1+e)^(y-1)`) | PRD §7.3 |
| Cash reserve buffer | $25,000 | PRD §7.3/§12.1 |
| Donations / household / yr | 3 | PRD §7.3 |
| Salvage % of retail | 0.8% · Card fees 2.0% · Payroll tax 7.5% | methodology + PRD §7.3 |

**Numeric discipline.** Compute in **cents/Decimal**; round only at display (whole dollars / 0.1%). The < $0.50 tolerance absorbs Python-Decimal vs LibreOffice-double divergence — document which side rounds. Totals/net/margin/KPIs are **always Excel formulas** over their component cells (even when a component is an overridden orange hard-coded value), so the sheet foots and the in-sheet `SUM` equals the server's resolved total.

**View-model contract** (engine's native output — frontend and `.xlsx` share it; full field list in [DATA_MODEL.md](./DATA_MODEL.md) / [API_SPEC.md](./API_SPEC.md)). `computed_json` serializes by the exact Appendix-D names with `model_version` + `compute_schema_version` stamped: `reco{tag,headline,sub,…}` (server emits a **semantic `tag` enum** — `proceed|revise|find_cheaper_rent|raise_cash|delay|do_not_proceed`; the **client** maps enum→color token, the API never hard-codes hex), `metrics{capital,cashGap,breakeven}`+reasons, `kpis[]`, `monthly[]{revenue,expenses,net,cumulativeCash}`+`breakevenMonth`, `rows[]{label,group,y1,y2,y3,class,editable}`, `overrides[]{node,year,calculated,value,note,pinnedDate,affected[]}`, `evidence[]`, `settings{…}`, `flags`, `version`. Emit money/percent as `{raw, display}` so the client never re-derives formatting.

## Sample golden fixtures (ship as goldens from day one)

Three named projections pinned to `model_version` drive design, edge-case math, and the recalc gate (PRD §12.4/§13/§18); each runs through the golden gate **with and without overrides**:

1. **House of Hope** — shares 6/8/10%, basket $17.08, source_of_funds $300k. **Canonical fixture runs at labor 60%** (owner default): Y1 revenue ~$426,911 (labor-independent), margin/capital/reco pinned at 60% at fixture-gen (a Y1-loss case — a valid correctness fixture; the gate tests the math, not the recommendation). At **`model_version` 2.7.0** (990-grounded payroll tax 8% + Insurance $10k on the 6.2 monthly split): capital ≈ **$347,854**, Y1 net **($53,714)**, break-even **month 8**, **reco = raise_cash** — the downside breaks even at month 12, so the binding constraint is capital > the $300k funds (pre-6.2: capital ≈ $321,940, break-even month 9, reco = do_not_proceed; the 6.2 flip to raise_cash is rules-as-written, feeds owner decision #345, and **HELD through 6.4**). The **40% design-parity twin** now yields margin **9.0%**, capital ≈ **$302,238**, break-even **month 6**, **reco = raise_cash** — an OWNER-VISIBLE 6.4 flip (capital crossed the $300k funds by $2,238; Year-1 net still +$38,505; the prototype "~11% / ~$278k / month-5 / Proceed" headline was calibrated to the pre-990 cost basis). See [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) §1/§10 and [DECISIONS.md](./DECISIONS.md).
2. **Aggressive (flagged)** — shares 15/20/25% (the legacy `house_of_hope.json` values) at **labor 40%** (load-bearing: at the 60% default the %-of-revenue cost stack caps net margin at ~24.75%, so the >30% guardrail is mathematically unreachable). Net margin ≈ **31.2%**; **must** trigger the §12.2 net-margin (>30%) and share (>8%) guardrails and require a justification note that travels into the packet; reco = revise.
3. **Grace Mission (loss case)** — negative Y1 net, payback **N/A — no Year 1 profit**, low-confidence $14/sqft rent, one **overridden Payroll cell**; must render cleanly (parentheses for negatives, explicit `null`, never `#DIV/0!`) and recalc clean **with the override present**.

## Regressions (check before coding; satisfies `REGRESSIONS`)

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
| 11 | Cookie/session our API trusts (CSRF surface) | **Cookie-blind API**: auth resolves from `Authorization: Bearer` only — the API never reads `request.cookies` (not even Clerk `__session`). A cookie-only request is `anonymous` (standing CI invariant). Override SESSION §2.8 | §20 |
| 12 | Silent recompute on new engine | Return stored snapshot; upgrade = new revision | §13 |
| 13 | Litestream replicating `/app` (timpager bug) | Replicate **`/data/projections.db`** | §26 |
| 14 | Boot with missing secret / fallback chain | Refuse to boot in prod; single-source env requirements | §20 |
| 15 | Annual P&L drifts from monthly | Year-1 annual = roll-up of M0–M12; golden asserts equality | §10.2 |

---

## Build process (project) — gstack × Superpowers

This is the project's process layer (extends `PLAN` → `TDD` → `VERIFY` → `GIT`). It is **not** in the global file. Two systems, one division of labor:

- **gstack** (specialist slash-command roles) supplies the **review gates** — `/office-hours`, `/autoplan` (CEO → design → eng → DX), `/review`, `/design-review`, `/qa`, `/cso`, `/ship`, `/land-and-deploy`, `/canary`. *Who looks at the work and when.*
- **Superpowers** (skills) supplies the **inner loop** — `brainstorming`, `writing-plans`, `using-git-worktrees`, `subagent-driven-development`, `test-driven-development`, `requesting/receiving-code-review`, `systematic-debugging`, `verification-before-completion`, `finishing-a-development-branch`. *How a unit of work is produced.*

> The PRD has *already* done the adversarial brainstorming (Appendix C/D are locked). For in-scope milestone work, skip open-ended ideation and go straight to plan-first; reserve `brainstorming` / `/office-hours` for genuinely new surface (an open §29 question, or net-new UI flagged "still to design").

### Per-milestone loop

Each milestone (M0–M7, see [BUILD_PLAN.md](./BUILD_PLAN.md)) is one trip; smaller features repeat steps 3–7:

```
(1) office-hours / brainstorm   ── only for new surface; in-scope work skips to (2)
(2) plan reviews   ── /autoplan: CEO → design → eng → DX
                     writing-plans → docs/plans/YYYY-MM-DD-<milestone>.md
                     (TDD tasks only, no placeholders; a Global Constraints block copied verbatim from the PRD survives compaction)
(3) isolate        ── using-git-worktrees: one worktree per milestone branch
(4) TDD build      ── subagent-driven-development: RED test first → implement → per-task review (spec + quality)
                     model policy = MODEL-SELECTION above; .superpowers progress ledger maintained
(5) verify         ── verification-before-completion: paste the Commands proof set (VERIFY)
(6) review         ── whole-branch /review (most-capable) + the milestone's required lenses + /qa (UI) + /cso (endpoints/secrets)
(7) ship           ── /ship → PR → /land-and-deploy → /canary; healthcheck MUST report the NEW build SHA before flip
```

**No milestone merges to `main` without every required gate green** ("green" = fresh command output, not a claim — `VERIFY`). "Shipped" = all required lenses green with evidence in the PR + [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md) Tier-1/Tier-2 pass + golden gate green (with/without overrides) + healthcheck shows the new build SHA + every behavior-changing doc updated in the same PR.

### Review lenses (who runs, and when)

Six lenses gate this project; they are *lenses*, not headcount (one agent can run several). Each lens's questions are answered with **evidence in the PR**, not asserted.

| Lens | Runs as | Asks | PRD anchor | When |
|---|---|---|---|---|
| **Product / CEO** | `/office-hours`, `/plan-ceo-review` | Decision-and-funding tool, not a calculator? Smallest credible cut? Is M-1 demand validated? | §1–§5, §12.3, §28 | Plan-mode, every milestone; hard gate at **M-1** and **M2** |
| **Eng / Architecture** | `/plan-eng-review`, `/review` | Server-only math? Override DAG topological + non-pinnable derived? `If-Match`/409 on every mutation? `Store` keeps Postgres open? | §13, §14, §22, §24–§26 | Plan-mode + pre-land, every milestone |
| **Design** | `/plan-design-review`, `/design-review`, `/qa` | Table-first finance density? Brand vs semantic tokens separate? Cell-state machine + inspector? Negatives in parens, N/A explicit? | §11, §14, §19, App. D | Any UI milestone (M2, M4, M5, M7) |
| **QA** | `/qa` (real browser @ 1440/768/375) | Stress dataset renders clean? Keyboard cell editing? Degraded states real? 409 modal works? | §12.4, §19.4, §27 | Every UI milestone; full sweep at **M7** |
| **Security** | `/cso`, `security-review` | No client compute. No cross-owner read. No secret in path/query/log. Narrative sanitized. Grounding + SSRF as tests. Boot-refuses on missing secrets. | §13, §16, §17, §20, §21, §22 | Every mutating endpoint; full audit at **M3**, **M5**, **M7** |
| **Release** | `/ship`, `/land-and-deploy`, `/canary` | Golden gate green? Healthcheck shows the new build SHA? Restore drill run? Migrations additive-only? | §13, §18, §26 | Every merge; ops sign-off at **M0** and **M7** |

### Milestone gate map (the single home — DoD/CONTRIBUTING point here)

Detailed scope in [BUILD_PLAN.md](./BUILD_PLAN.md). Process view: entry gate, required lenses, tests that must exist, ops deliverable.

| Milestone | Entry gate | Required lenses | Tests that must exist | Ops / deliverable |
|---|---|---|---|---|
| **M-1 Pre-build validation** | — | **Product/CEO (hard go/no-go)** | n/a (discovery) | 20 ICP interviews · 10 manual projections · 5 board/funder shares · 3 paid-or-SQL conversions. **No M3+ heavy build until met.** |
| **M0 Scaffold** | M-1 passed | Eng, Security, Release | boot-refuse env test; feedback-redaction test stub; CSP/noindex header test; **`scripts/ratio.py` meter exists** | Repo, FastAPI, SQLite(WAL)+Litestream on `/data`, terms gate, `railway.toml`, restore-drill script |
| **M1 Compute + cash flow** | M0 green | **Eng (most-capable)** | **golden 3-way reconcile (with/without overrides); annual==sum(monthly); decision-metric goldens; property tests** | engine `model_version` + `compute_schema_version` stamped; CI-blocking golden gate (LibreOffice pinned) |
| **M2 MVP loop (credibility gate)** | M1 golden green | **Product/CEO (hard), Eng, Design, QA, Release** | mutation quad on create/PATCH; 409 test; `.xlsx` recalc clean | inputs → compute → save → reopen → `.xlsx` + basic packet **including decision banner + monthly cash-flow + recommendation** |
| **M3 Research + evidence** | M2 shipped | Eng, **Security (full)**, Design | SSRF block; unfetched-citation reject; injection-strip; cache TTL | Places + Census + retrieval-grounded rent + evidence panel + attachments (upload hardening) |
| **M4 Editing depth** | M3 shipped | Eng, **Design**, QA, Security | override-DAG props (non-pinnable derived; reset; stale-flag); revisions; role links | cell overrides + Override Inspector + revisions + view/edit/role links + 409 + soft delete |
| **M5 Board Packet + narrative** | M4 shipped | **Security (full)**, Design, Product/CEO | numeric-grounding reject; stale-narrative diff; sensitivity goldens | packet export + grounded prose + stale handling + sensitivity |
| **M6 Feedback + intent** | M5 shipped | Security, Eng | **feedback-redaction CI test (P0)**; CRM intent path | redacted GitHub + support IDs ([IDEA_FAB.md](./IDEA_FAB.md)); CRM intent loop |
| **M7 Hardening + actuals** | M6 shipped | **All six lenses; full QA sweep** | a11y AA on wizard/table/overrides/modals; full degraded-state set; restore drill run | security/ops/runbooks, error states, design QA; actuals **schema** only (no UI) |

### Scope fences (YAGNI — enforced in plan review, per `STANDARD`)

**In v1:** decision-and-funding tool for first-store nonprofits; city/county/manual trade area (§8); monthly cash-flow + decision metrics + recommendation; evidence/trust layer; grounded packet; capability-token sharing.
**Out of v1** (deferred, rules pre-specified where noted): multi-store / for-profit (§2); radius / drive-time / ZCTA trade area (§8); actuals **benchmarking** beyond the empty table (§6.3 — ship schema, no UI); demand-drivers that *scale* the point estimate (§9 — v1 drivers adjust *confidence* only); any client-side compute (§13). The M2 "smallest shippable loop" stays small but MUST carry the decision banner, monthly cash-flow, and recommendation — a calculator without the decision is not shippable for this ICP.

### Open questions to close (elevated from §29)

| Question | Blocks | Owner doc |
|---|---|---|
| Business-model price/gate — free vs paid/reviewed (§3) | M-1 exit framing | PRD §3 / Product |
| Labor % product default — **owner override = 60%** (DECISIONS.md still lists a stale 40% "CLOSED"; reconcile) | every golden fixture (M1) | [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) / [DECISIONS.md](./DECISIONS.md) |
| Ramp/seasonality calibration source for the S-curve + break-even (§10.2) | decision-metric confidence (M1) | [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) |
| Escalator scope — does 3.0% also escalate NNN opex + the deposit startup line? | engine determinism (M1) | [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) |

A confidently-wrong break-even month is worse than none: label confidence, show sensitivity, treat §6.3 actuals as the calibration backlog.

---

## Doc index

| Topic | File |
|---|---|
| Authoritative requirements (the product) | [reference/PRD.md](./reference/PRD.md) |
| Design brief (table-first, dense, finance-grade, a11y) | [reference/DESIGN_PROMPT.md](./reference/DESIGN_PROMPT.md) |
| System architecture, layout, endpoint→module map | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Milestones (M-1…M7), entry gates, deliverables | [BUILD_PLAN.md](./BUILD_PLAN.md) |
| Engine formulas, defaults, override resolution, Excel cell contract, golden gate | [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) |
| SQLite schema, `computed_json`/view-model fields, versioning | [DATA_MODEL.md](./DATA_MODEL.md) |
| REST endpoints, `If-Match`/409, request/response shapes | [API_SPEC.md](./API_SPEC.md) |
| Capability tokens, secrets/env, CSP/CORS, sanitization, SSRF, rate limits, LLM grounding | [SECURITY.md](./SECURITY.md) |
| Railway/Litestream, restore drill, RPO/RTO, migrations, incidents | [OPS_RUNBOOK.md](./OPS_RUNBOOK.md) |
| Tiered gate, Mutation Safety Quad, Failure Mode Registry, Verification Bar | [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md) |
| Branch naming + PR/commit footers (thin stub; process lives here) | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Redacted feedback → GitHub + intent → CRM (idea fab) | [IDEA_FAB.md](./IDEA_FAB.md) |
| Final product/engineering calls (labor %, stack, fixtures, ratio meter) | [DECISIONS.md](./DECISIONS.md) |
| Calibration seed engine + LibreOffice recalc gate | `reference/thrift-store-projections-skill/scripts/{generate_projection.py,recalc.py}` |

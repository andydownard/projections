# Contributing — rallytasks/projections

How work flows in this repo. Short and practical. Read this before you open a branch.

This is the **Thrift Store Projection** web app: a server-authoritative decision-and-funding tool for first-store nonprofits (FastAPI + React/TS, SQLite/WAL + Litestream on Railway, capability-token access, no login). The product requirements are in [`PRD.md`](./PRD.md); the build sequence is in [`BUILD_PLAN.md`](./BUILD_PLAN.md). This doc is about **process**, not product.

> **Two rules that override everything else.** (1) The **server is the only math authority** — there is no client-side compute in v1 ([PRD §13](./PRD.md)). (2) Every change ships through the **agentic build loop** with its review gates green. The doc index lives in [`CLAUDE.md`](./CLAUDE.md).

---

## 0. Before you write any code

1. **Read the rules.** [`CLAUDE.md`](./CLAUDE.md) (hard rules + regression registry + vocabulary), [`AGENTS.md`](./AGENTS.md) (the build loop + reviewer roles), [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md) (the verification bar).
2. **Read the contract for what you're touching.** Engine work → [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md); schema/storage → [`DATA_MODEL.md`](./DATA_MODEL.md); endpoints → [`API_SPEC.md`](./API_SPEC.md); access/secrets → [`SECURITY.md`](./SECURITY.md); deploy/restore → [`OPS_RUNBOOK.md`](./OPS_RUNBOOK.md); system shape → [`ARCHITECTURE.md`](./ARCHITECTURE.md).
3. **Know where you are in the plan.** Work is organized by milestone (M-1 … M7, [PRD §28](./PRD.md) / [`BUILD_PLAN.md`](./BUILD_PLAN.md)). Don't pull a later milestone's feature into an earlier one — the "smallest shippable loop" (M2) must stay genuinely small.

> **Engine reality check.** The skill's `generate_projection.py` is a **calibration seed, not the v1 engine.** It is annual-only, hard-codes Year-2 = midpoint of Y1/Y3 (`compute()` line 65), has fixed-dollar supplies (no Marketing line, no % cost lines), no rent escalator, no monthly cash-flow, no decision metrics, and no override DAG. M1 is an **engine rewrite**, not a "wire it up." See [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md) for the gap list. Do not assume "reuse the engine" means "it's mostly done."

---

## 1. Branches & PRs

- **`main` is protected.** Never commit app code to `main`. Branch first.
- **Branch naming:** `<milestone>/<short-slug>`, e.g. `m1/monthly-cashflow`, `m4/override-dag`, `m2/xlsx-export`. Bugfix branches: `fix/<slug>`. Docs-only: `docs/<slug>`.
- **One milestone per worktree.** Each milestone runs in an isolated git worktree ([`superpowers:using-git-worktrees`](./AGENTS.md)) so parallel sprints don't share state.
- **PRs target `main`.** Keep them scoped to one milestone slice. A PR that touches the engine, the API contract, or the schema **must update the matching doc in the same PR** (Docs Are Code — see [`CLAUDE.md`](./CLAUDE.md)).
- **Docs-only `.md` changes** may go directly to `main`.
- **No PR merges with a red gate.** See §4 and §5.

### Commit & PR hygiene
- Commit messages: imperative subject, body explains *why*. End commit messages with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- PR body: what changed, which milestone, which PRD sections, the review gates run, and the **verification evidence** (paste the command output — see §3). End PR bodies with:
  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```
- Never paste secrets, tokens, `view_slug`s, or real financial data into commits, PRs, or logs.

---

## 2. The agentic build loop (how a change gets made)

Every milestone slice runs the same pipeline. Roles are gstack slash-command specialists; the inner loop is Superpowers. Full detail in [`AGENTS.md`](./AGENTS.md); this is the short version.

| Step | Tool / role | Output |
|---|---|---|
| **1. Plan-review the spec slice** | `/autoplan` (CEO → design → eng → DX review) on the milestone scope | Decisions surfaced for go/no-go |
| **2. Write the plan** | [`superpowers:writing-plans`](./AGENTS.md) → `docs/plans/YYYY-MM-DD-<milestone>.md` | TDD tasks, no placeholders, a verbatim **Global Constraints** block copied from the PRD |
| **3. Isolate** | [`superpowers:using-git-worktrees`](./AGENTS.md) | One worktree per milestone |
| **4. Build task-by-task** | [`superpowers:subagent-driven-development`](./AGENTS.md) | Per-task **spec-compliance + code-quality** review; a `.superpowers` progress ledger so finished tasks aren't re-dispatched |
| **5. Branch review** | `/review` (whole branch, most-capable model) | Production-bug findings fixed |
| **6. Browser QA** | `/qa` at **1440 / 768 / 375** against the Appendix-D states | Bugs fixed + regression tests added |
| **7. Ship** | `/ship` → `/land-and-deploy` | PR opened, merged, prod healthcheck verified (new build SHA, not a bare 200) |

**Model-selection policy (always name the model in the dispatch — never inherit the session default):**
- **Cheapest tier** — transcription tasks where the plan already contains complete code (most M2/M6 CRUD, `.xlsx` cell wiring).
- **Standard tier** — integration: override-DAG glue, monthly cash-flow wiring, research/LLM plumbing.
- **Most-capable tier** — the engine math rewrite (M1), the decision-metric solver, and **every milestone-end whole-branch review**.

**TDD is the Iron Law** for all engine, decision-metric, override-DAG, and API-mutation code: write the failing test, watch it fail, then write the code ([`superpowers:test-driven-development`](./AGENTS.md)). Bugfixes get a reproducing regression test first ([`superpowers:systematic-debugging`](./AGENTS.md)). The only exception is a throwaway research/prompt spike, which is deleted before the real TDD pass.

**M-1 is a hard gate, not a coding milestone.** Do not start heavy M3+ build (research, narrative, overrides) until the pre-build validation bar is met (20 ICP interviews · 10 manual projections · 5 board-shares · 3 paid/SQL conversions — [PRD §28](./PRD.md)). This is a human go/no-go.

---

## 3. Running tests locally

```bash
# Backend (FastAPI / engine)
pytest -q                      # unit + integration, zero failures required

# Engine golden + Excel reconciliation gate (see §4)
pytest engine/tests/golden -q

# LibreOffice formula-error check on a generated workbook
python recalc.py path/to/projection.xlsx     # expect total_errors: 0

# Frontend (React + TS)
npm test                       # component + view-model tests
npm run typecheck && npm run lint
```

The golden/recalc gate requires **LibreOffice (`soffice`) pinned to the version in the build image**, plus `timeout`/`gtimeout` on PATH (`recalc.py` shells out to a headless `soffice` macro). If `soffice` is missing, `recalc.py` returns an `{"error": ...}` dict — that is **not a pass**; the harness must assert `status == "success"` AND `total_errors == 0` and fail closed.

> **Verification before completion.** Never claim "done / passing / fixed" without fresh command output in the same message ([`superpowers:verification-before-completion`](./AGENTS.md)). A bare HTTP 200 is not proof; the deploy healthcheck must show the **new build SHA**.

---

## 4. The golden / CI gates

These are **CI-blocking** and built in **M1, before any UI depth** ([PRD §13 / §18](./PRD.md)). They are what makes the "single math authority" claim true; if they slip, the whole trust story is hollow.

**Three-way reconciliation** — for each fixture, all three must agree:
1. **Server Python compute** (`engine/compute.py` view-model output) ==
2. the values embedded in stored **`computed_json`** ==
3. **LibreOffice recalc** of the exported `.xlsx` (via `recalc.py`).

**Tolerances:** `< $0.50` absolute on dollar cells, `< 0.1pp` on percent cells, **zero** Excel formula errors (`#VALUE! #DIV/0! #REF! #NAME? #NULL! #NUM! #N/A`). Run **with overrides AND without** — overrides break the formula graph and are the case most likely to fail the gate.

**Mandatory fixtures** (ship as golden from day one — these also drive design):
- **House of Hope** conservative (6/8/10% shares; ~$427k Y1 revenue, ~11% margin, ~$278k capital required, break-even ~month 5).
- **Aggressive flagged** (15/20/25%): must trigger the [PRD §12.2](./PRD.md) guardrail and require a justification note.
- **Grace Mission loss case**: negative Y1 net, payback **N/A**, low-confidence `$14/sqft` rent, one overridden Payroll cell — must render cleanly (parentheses for negatives, never `#DIV/0!`).
- Edge cases: `revenue = 0`, `Y1 net ≤ 0`, `0 sqft` blocked at input, NNN vs gross, a sensitivity downside.

**Other CI gates that block merge** (from [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md)):
- **Mutation Safety quad** on every `PATCH`/`POST`: bearer-token auth, owner-scope isolation (never a global list, never cross-owner read/write), `If-Match`/version optimistic-concurrency **409-on-stale**, and a negative/abuse path (rate limit per IP + token).
- **Feedback-redaction test:** no `view_slug`, edit token, resolvable projection link, or financial field ever reaches a GitHub-issue payload — only the random `support_id` ([PRD §22](./PRD.md)).
- **LLM grounding tests (adversarial, with recorded/stubbed provider responses):** a hallucinated figure not in `computed_json` is **rejected** ([PRD §17](./PRD.md)); an unfetched citation is **rejected** ([PRD §16](./PRD.md)); injected "ignore previous instructions" web text is treated as data and stripped.
- **AI opt-out works end-to-end:** the full flow computes, saves, and exports `.xlsx` with **all AI keys unset** ([PRD §21](./PRD.md)).
- **Boot-refuse config validation:** production refuses to boot if a required secret is unset, with no fallback chains (see [`SECURITY.md`](./SECURITY.md)).

---

## 5. Definition of Done

A change is done when both tiers pass — full text in [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md).

**Tier 1 — GATE (every commit):** `pytest` green; on a feature branch (not `main`); no secrets in code/logs/responses; every mutation has the auth + owner-scope + `If-Match`-409 + negative-path tests; the engine golden + LibreOffice recalc gates pass.

**Tier 2 — QUALITY (every PR):** threat model for any new endpoint; a11y AA on new UI (keyboard wizard/table/override-drawer, visible focus, no color-only meaning, reduced-motion — verified at 1440/768/375 against the stress dataset); per-provider grounding test; a **Failure Mode Registry** row (provider 429, recalc mismatch, stale 409, offline save, unfetched citation, hallucinated figure, location-not-found, AI opt-out) with **Rescued? and Tested? both Y**. `Rescued = N AND Tested = N` is CRITICAL — never merge.

**The Verification Bar — the exact proof:** `pytest -q` output · `python recalc.py <xlsx>` showing `total_errors: 0` · the golden-reconcile test · the a11y check · the deploy healthcheck showing the **new build SHA**.

---

## 6. Hard rules you will trip over

- **No client-side math.** The design prototype computes in JS (`calcYears`/`calcMonthly`/`scenario`); that code is a **layout + view-model field-name reference only** and is forbidden in production ([PRD §13](./PRD.md)). The client edits → debounced `PATCH` (with `If-Match`) → renders the server's `computed_json`.
- **No cookies, no CSRF surface.** Capability tokens only: owner bearer token in `localStorage`, edit/recovery secrets in the **URL fragment** — never in a path, query, or log ([PRD §20](./PRD.md), [`SECURITY.md`](./SECURITY.md)).
- **The engine never silently recomputes.** `computed_json` is stamped with `model_version`; a newer engine surfaces "upgrade available" and writes a **new revision** ([PRD §13](./PRD.md)).
- **Override DAG rules are server-enforced:** derived rows / totals / KPIs are **never pinnable** (reject at the API boundary, not just the UI); no upstream back-solve; stale-upstream rows are flagged ([PRD §14](./PRD.md)).
- **Database is additive-only.** `ALTER TABLE ADD COLUMN`, never `DROP`/recreate; take a pre-migration Litestream snapshot. DB lives at `DB_PATH=/data/projections.db` on the durable volume (see [`OPS_RUNBOOK.md`](./OPS_RUNBOOK.md)).
- **Idea Fab = bugs to GitHub (redacted), intent to CRM.** Never let a projection link or financial field reach GitHub ([PRD §22](./PRD.md), [`IDEA_FAB.md`](./IDEA_FAB.md)).

Check the **Regression Registry** in [`CLAUDE.md`](./CLAUDE.md) before coding anything that touches these patterns. If your change matches a registered trap, read the existing code first and fix **all** instances, not just the one you found.

---

## 7. Where things live

| You're working on… | Read | Code lives in |
|---|---|---|
| Math, formulas, defaults, Excel cells | [`ENGINE_CONTRACT.md`](./ENGINE_CONTRACT.md) | `engine/` (`compute.py` pure, `monthly.py`, `dag.py`, `decision.py`, `xlsx.py`, `packet.py`) |
| Endpoints, request/response shapes | [`API_SPEC.md`](./API_SPEC.md) | `app/routers/`, `app/schemas/` |
| Schema, storage, revisions, tokens | [`DATA_MODEL.md`](./DATA_MODEL.md) | `app/store/` |
| UI, components, view-model, a11y | [`ARCHITECTURE.md`](./ARCHITECTURE.md) + the design brief | `web/` |
| Auth, secrets, CSP, sanitization | [`SECURITY.md`](./SECURITY.md) | `app/deps.py`, `app/main.py` |
| Deploy, Litestream, restore drill | [`OPS_RUNBOOK.md`](./OPS_RUNBOOK.md) | `railway.toml`, `litestream.yml` |
| The build process itself | [`AGENTS.md`](./AGENTS.md), [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md) | `docs/plans/` |

When in doubt, the [`PRD.md`](./PRD.md) is the authoritative requirement and the golden tests are the authoritative behavior. If a doc and the PRD disagree, fix the doc in your PR.

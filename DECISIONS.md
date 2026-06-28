# Decisions log

> Final calls from the convening (product lead deciding, informed by the product team + 6 unicorn founders). Supersedes the open blockers in the Engineering Handoff §2.

## ⚑ Sq-ft-scaled utilities + fixtures, location-researched rent (feature #245, `model_version` 2.5.0)

Owner request: ask for sq ft, research representative rent by location, and scale utilities + fixtures with sq ft from the example basis. Calls made for the build:

- **Per-sq-ft constants are anchored to the example store (10,000 sq ft)** so 10k reproduces today's literals byte-for-byte: `UTILITIES_PER_SQFT = $2.23` (22,300/10k), `FIXTURES_PER_SQFT = $4.50` (45,000/10k), `BUILDOUT_PER_SQFT = $5.00` (50,000/10k). Every 10k golden is numerically unchanged; only a non-10k fixture (Grace Mission @8k → utilities $17,840) moves.
- **Utilities stays the SAME pinnable line + `EXPENSE_ORDER` slot** — only its derivation changes (flat fixed-$ → `building_sqft × UTILITIES_PER_SQFT`). No new DAG node / `.xlsx` row / pinnable surface. It is flat across years (sq ft drives it, not the rent escalator). This is a `MODEL_VERSION` 2.4.0 → 2.5.0 bump + golden regen in the same change.
- **Fixtures/build-out are a SEED change, not engine-resolution:** `default_cost_schedule(building_sqft=10000)` scales those two lines; a no-arg (legacy/migration) call stays at the example basis, so the frozen m0005 backfill literal is unchanged.
- **AI-off rent default pinned to `$12/sq ft`** (`DEFAULT_RENT_PER_SQFT`) = today's $120k at 10k, so a new manual projection does not silently jump; the value is always visible + editable.
- **M-1 gate lift (scoped):** the owner asking for location rent research **lifts the M-1 hard gate for the rent-research slice only** (#60/#62/#64/#65). It is still built to the LLM-GROUNDING contract exactly (extract-only over SSRF-fetched snippets, unfetched citations rejected, AI-disabled-safe labeled benchmark, rate-limited, off the compute hot path). The rest of M3 (attachments #66, full evidence automation) stays deferred.

---

## ⚑ Owner override: labor default = 60%

The convening recommended **40%**. The owner (Andy) elected to **keep 60%** — which is also the original verified engine default ([methodology.md](./reference/thrift-store-projections-skill/reference/methodology.md)). Consequences, handled by design:

- The **canonical correctness golden** reproduces the engine output at **60% labor**. Y1 revenue (~$426,911) is labor-independent and holds; net margin and the decision metrics are computed at 60% (the conservative House of Hope sample is a **loss/"revise"** case at 60%, which is a valid correctness fixture — the gate tests the math, not the recommendation).
- A separate **40% "design-parity" fixture** reproduces the prototype screenshots (margin ≈ 11%, capital ≈ $277,990, break-even ≈ month 5, reco = Proceed) for design-QA only, clearly labeled illustrative.
- Moving labor between 40% and 60% is a new `model_version` with regenerated golden fixtures **in the same change** — never a silent flip.

---

## React 18 + TypeScript + Vite; TanStack Query for the server-owned computed_json cache (keyed by view_slug); thin Zustand/useReducer for transient UI; hand-rolled SVG charts (no charting dependency).

**Call:** Frontend framework

**Rationale:** Already the Thriftly standard pinned in CLAUDE.md and BUILD_PLAN §9 (#5 'decided'); the handoff's 'open blocker' status is stale. All six founders and all four product-team leads concur. Engine-as-service is framework-agnostic since the server is the only math authority, so the choice carries near-zero engine risk. Re-opening only burns the M0 critical path. CLOSED.

---

## LABOR_PCT = 0.40 as a named, documented constant; slider stays editable with a 25-60% advisory band. 60% is superseded. If product ever moves to 60%, it is a NEW model_version with regenerated golden fixtures in the SAME change, never a silent flip.

**Call:** Labor default %

**Rationale:** Unanimous across all 10 voices and a correctness/testability decision, not a taste one: 40% is the ONLY value that reconciles the Appendix-D headline golden (Y1 rev ~$426,911, ~11% margin, capital ~$277,990, break-even ~month 5, reco=Proceed). 60% silently flips the headline recommendation, breaks design parity with every screenshot, and forces QA to chase a phantom mismatch between two 'correct' answers. Rationale documented in ENGINE_CONTRACT §1/§2. CLOSED before M1.

---

## Pin House of Hope conservative annual occupancy as an explicit annual-$ in the fixture JSON (~$120k / ~$12/sqft NNN-inclusive, finalized once ramp constants are pinned) so margin computes to ~11% AND break-even ~month 5. Do not leave it as 'sqft x unspecified rate'.

**Call:** Fixture occupancy pin (forced by Staff Engineer)

**Rationale:** The fixture says 'NNN, 10,000 sqft' but specifies no rent rate or annual occupancy $; the 11% margin / $277,990 capital targets are not derivable from any stated input, so the golden target is non-deterministic and the three-way gate is un-greenable. This is a prerequisite to the engine compute and decision tickets, not a nice-to-have. Filed as M1-FIX.

---

## Make it a MEASURED, CI-blocking number, not prose. scripts/ratio.py via cloc over an explicit path map (code: engine/** + app/** minus tests; test: engine/tests/**, app/tests/**, frontend/**/*.{test,spec}.*; excluded: migrations, generated fixtures, golden .xlsx blobs, vendored, __init__). Gate BOTH the per-PR diff ratio (>1.3) AND repo-wide non-regression below 1.3. The per-PR diff ratio measures the ACTUAL added lines of `git diff <base>...HEAD` (numstat), bucketed by the same path map — NOT the whole-file LOC of every touched file; a small, focused edit to a large file (e.g. the ~1200-line app/routers/projections.py) is judged on the lines it changed, so genuine tests are not drowned out by the size of the file they sit beside. Pair with engine/** branch coverage >=90% so the ratio cannot be gamed by trivial assertions. Concentrate density in engine/ (compute/monthly/decision/dag clear 1.5+); count meaningful interaction/a11y tests on the frontend; let the Mutation Safety quad carry the API. Remove the soft '~1.3x' from DoD Tier-2 and point it at the meter.

**Call:** test-LOC / code-LOC > 1.3 (HARD RULE)

**Rationale:** An unmeasured ratio is not a rule; high-velocity M2/M6 transcription will erode it. The pure, deterministic compute core is the cheapest place on earth to write dense golden+property tests, so the aggregate >1.3 is structurally achievable with the bulk of test LOC in the engine. Filed as QA-0 in M0 so the meter exists before any feature code (retroactive is unrecoverable).

---

## DEFER the price/free-vs-paid decision to M-1 (it is a server config toggle per PRD §3, not a rebuild). Keep create -> compute -> decision banner -> .xlsx -> basic shareable packet fully FREE and ungated (the lead-gen flywheel + the M-1 board-share metric). Gate ONLY expert review / sign-off. Build the price/gate config flag (M6) and the 'request expert review' intent event (pulled into M2) regardless of the price. Build the terms-acceptance gate now (M0) independent of monetization.

**Call:** Business-model gate (free vs paid)

**Rationale:** GTM + PLG founders: gating basic export kills SEO and the Thriftly-lead flywheel that is the real strategic value. M-1 must measure two WTP questions independently (pay for the artifact vs pay for human review), so instrument both. Fintech founder: terms gate is load-bearing for defensibility regardless of pricing - do not conflate the two.

---

## M2 is NOT done unless the rendered Projection tab shows the recommendation banner + capital required + break-even month + first-year cash gap + monthly cash-flow together on the conservative sample, EACH decision metric shown WITH its downside-scenario value and a confidence label (never bare). The PRD §28 M2 wording is silent on decision outputs; this plan resolves it - decision metrics are M2 must-haves, not M5.

**Call:** Decision artifact ships together in M2

**Rationale:** All three founders (fintech, GTM, design-led) plus Architect and QA: a board pays for 'proceed / raise cash / find cheaper rent' with defensible reasons, not a P&L. A capital number with no sensitivity band or confidence label in front of a funder is a liability. Splitting these across milestones produces an un-sellable calculator.

---

## Ship the uncalibrated ramp/break-even/capital, but NEVER bare. flags.ramp_low_confidence=true propagates to the banner, KPI tile, Excel monthly tab, and packet; break-even/capital/cash-gap always render WITH their downside value and a confidence label. A confidently-wrong break-even month is treated as a defect. Real calibration is the post-launch actuals backlog (PRD §6.3), not an M1 blocker.

**Call:** Calibration confidence posture

**Rationale:** Fintech + AI/dev-tools + data-network + Staff QA all flag this as the #1 trust risk. 'Uncalibrated' must not become 'unlabeled'. Filed as engine ticket M1-CONF (confidence propagation) + UI ticket M2-D3d (sensitivity strip / downside-on-tile).

---

## AI is never in the compute hot path and never produces a number a human quotes. Research is extract-only over server-fetched snippets (unfetched citations rejected, injection markers stripped, SSRF-hardened); narrative is numeric-grounded (every figure must exist in computed_json or generation rejected). Both have deterministic stubbed-provider adversarial tests. Full flow works with all AI keys unset (opt-out test). All deferred to M3/M5 behind the M-1 gate.

**Call:** AI bounding

**Rationale:** AI/dev-tools founder + Architect: fence the highest-variance, least-testable component off from the deterministic golden-tested core. These are correctness tests, not prompt politeness.

---

## Schema-only in v1: actuals table + cohort_json (frozen cohort fingerprint stamped at create / on settings change) + version-stamped snapshots + dual-backend Store conformance suite, all in 0001_init. ZERO actuals UI in v1. Add one-line ACs to the monthly engine + view-model tickets so forecast and future actuals share an identical month axis and line-item set. Capture M-1's 10 manual projections as model_version-pinned fixtures (first benchmark rows). Defer all pooling/benchmark surfacing to M7 via split I4a/b/c.

**Call:** Data-network moat posture

**Rationale:** Data-network founder, endorsed by panel: the network effect must never be a future migration, but building it before real stores open is premature. The conformance suite + cohort-stability tests are test-heavy / thin-implementation, which helps the >1.3 ratio by construction.

---


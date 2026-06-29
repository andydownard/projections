# Projections — Build Backlog

> Generated from the product-team + 6-founder convening. **9 epics (M-1→M7), 94 tickets.** Filed into GitHub Project **Projections Roadmap (#5)**. Scope source of truth: [reference/PRD.md](./reference/PRD.md) v3.1 + [reference/ENGINEERING_HANDOFF.md](./reference/ENGINEERING_HANDOFF.md). Decisions: [DECISIONS.md](./DECISIONS.md).

## Decision calls (product lead)

- **React 18 + TypeScript + Vite; TanStack Query for the server-owned computed_json cache (keyed by view_slug); thin Zustand/useReducer for transient UI; hand-rolled SVG charts (no charting dependency).** → Frontend framework
- **LABOR_PCT = 0.40 as a named, documented constant; slider stays editable with a 25-60% advisory band. 60% is superseded. If product ever moves to 60%, it is a NEW model_version with regenerated golden fixtures in the SAME change, never a silent flip.** → Labor default %
- **Pin House of Hope conservative annual occupancy as an explicit annual-$ in the fixture JSON (~$120k / ~$12/sqft NNN-inclusive, finalized once ramp constants are pinned) so margin computes to ~11% AND break-even ~month 5. Do not leave it as 'sqft x unspecified rate'.** → Fixture occupancy pin (forced by Staff Engineer)
- **Make it a MEASURED, CI-blocking number, not prose. scripts/ratio.py via cloc over an explicit path map (code: engine/** + app/** minus tests; test: engine/tests/**, app/tests/**, frontend/**/*.{test,spec}.*; excluded: migrations, generated fixtures, golden .xlsx blobs, vendored, __init__). Gate BOTH the per-PR diff ratio (>1.3) AND repo-wide non-regression below 1.3. Pair with engine/** branch coverage >=90% so the ratio cannot be gamed by trivial assertions. Concentrate density in engine/ (compute/monthly/decision/dag clear 1.5+); count meaningful interaction/a11y tests on the frontend; let the Mutation Safety quad carry the API. Remove the soft '~1.3x' from DoD Tier-2 and point it at the meter.** → test-LOC / code-LOC > 1.3 (HARD RULE)
- **DEFER the price/free-vs-paid decision to M-1 (it is a server config toggle per PRD §3, not a rebuild). Keep create -> compute -> decision banner -> .xlsx -> basic shareable packet fully FREE and ungated (the lead-gen flywheel + the M-1 board-share metric). Gate ONLY expert review / sign-off. Build the price/gate config flag (M6) and the 'request expert review' intent event (pulled into M2) regardless of the price. Build the terms-acceptance gate now (M0) independent of monetization.** → Business-model gate (free vs paid)
- **M2 is NOT done unless the rendered Projection tab shows the recommendation banner + capital required + break-even month + first-year cash gap + monthly cash-flow together on the conservative sample, EACH decision metric shown WITH its downside-scenario value and a confidence label (never bare). The PRD §28 M2 wording is silent on decision outputs; this plan resolves it - decision metrics are M2 must-haves, not M5.** → Decision artifact ships together in M2
- **Ship the uncalibrated ramp/break-even/capital, but NEVER bare. flags.ramp_low_confidence=true propagates to the banner, KPI tile, Excel monthly tab, and packet; break-even/capital/cash-gap always render WITH their downside value and a confidence label. A confidently-wrong break-even month is treated as a defect. Real calibration is the post-launch actuals backlog (PRD §6.3), not an M1 blocker.** → Calibration confidence posture
- **AI is never in the compute hot path and never produces a number a human quotes. Research is extract-only over server-fetched snippets (unfetched citations rejected, injection markers stripped, SSRF-hardened); narrative is numeric-grounded (every figure must exist in computed_json or generation rejected). Both have deterministic stubbed-provider adversarial tests. Full flow works with all AI keys unset (opt-out test). All deferred to M3/M5 behind the M-1 gate.** → AI bounding
- **Schema-only in v1: actuals table + cohort_json (frozen cohort fingerprint stamped at create / on settings change) + version-stamped snapshots + dual-backend Store conformance suite, all in 0001_init. ZERO actuals UI in v1. Add one-line ACs to the monthly engine + view-model tickets so forecast and future actuals share an identical month axis and line-item set. Capture M-1's 10 manual projections as model_version-pinned fixtures (first benchmark rows). Defer all pooling/benchmark surfacing to M7 via split I4a/b/c.** → Data-network moat posture

## Epics

| Epic | Milestone | Priority | Goal |
|---|---|---|---|
| **M-1** Pre-build validation (hard gate, non-eng) | M-1 | P0 | Prove someone pays BEFORE the engine-rewrite spend: 20 ICP interviews, 10 manual projections (at locked 40%, timed, stored as model_version-pinned fixtures), 5 board/fund |
| **M0** Scaffold & infra + quality meter | M0 | P0 | Deployable empty shell with invariants wired from commit one: repo layout, FastAPI boot-refuse config, SQLite WAL + Litestream on /data, Store Protocol (sqlite + postgres |
| **M1** Compute engine rewrite + three-way golden gate | M1 | P0 | A pure, deterministic, side-effect-free compute core (zero openpyxl/docx imports) emitting the Appendix-D view-model natively: three explicit shares, % cost lines, escala |
| **M2** MVP loop = the decision artifact (credibility gate) | M2 | P0 | The smallest board-defensible loop: wizard / start-from-example -> server compute -> decision banner + monthly cash-flow + recommendation + capital/break-even/cash-gap (e |
| **M3** Research + evidence/trust layer | M3 | P1 | Places + Census (city/county/manual) + retrieval-grounded rent (SSRF-hardened, extract-only, unfetched-citation rejected, injection-resistant) + the verified-vs-estimated |
| **M4** Editing depth: overrides, revisions, sharing, conflict | M4 | P1 | Full assumptions + cell-override UX on the server DAG (in-cell state machine + Inspector drawer), revisions/restore, view/edit/role links with atomic rotate/revoke, soft  |
| **M5** Board Packet + grounded narrative + sensitivity surface | M5 | P1 | The headline trust/paid artifact: evidence-first Board Packet (board/funder/advisor variants) leading with the canonical banner, verified-vs-estimated assumptions, inline |
| **M6** Feedback -> GitHub + intent -> CRM + price/gate flag | M6 | P2 | The discovery engine with the top data-leak risk neutralized by construction: redacted GitHub feedback (support_id only, CI-asserted), CRM intent (role/reason/timeline/ex |
| **M7** Hardening + a11y/error sweep + actuals + launch | M7 | P2 | Production hardening: full AA a11y sweep + responsive design-QA screenshot matrix (1440/768/375 on stress data), error/degraded states, Litestream restore drill with docu |

## Build sequence (critical path)

`M-1.5 → M0.1 → QA-0 → M0.3 → M0.4 → M0.5 → M0.7 → M0.6 → M0.2 → M1.0 → M1-FIX → M1.7 → M1.1a → M1.1b → M1.1c → M1.2 → M1.3 → M1-SENS → M1-CONF → M1.4 → M1.5 → M1.6 → M2.1 → M2.2 → M2.3 → M2-D3a → M2-D3b → M2-D3c → M2-D3d → M2.5 → M2.4-settings → M2.6 → M2.7 → M2-D2a → M2.8 → M2.9 → QA-7 → M2-MOBILE`

## Tickets

### M-1

| Key | Title | P | Size | Deps | Labels |
|---|---|---|---|---|---|
| `M-1.1` | M-1.1 — Run 20 ICP interviews with first-store nonprofit operators/boards | P0 | L |  | validation, gtm, non-eng |
| `M-1.2` | M-1.2 — Produce 10 manual projections at locked 40%, timed (time-to-value baseline) + stored as model_version-pinned computed_json fixtures (benchmark seed) | P0 | L | M-1.1 | validation, gtm, data-network |
| `M-1.3` | M-1.3 — 5 users share a manual packet with a board/funder | P0 | M | M-1.2 | validation, gtm |
| `M-1.4` | M-1.4 — 3 paid or SQL conversions against a posted $299 mid-band price; measure artifact-WTP vs human-review-WTP separately | P0 | M | M-1.2 | validation, gtm |
| `M-1.5` | M-1.5 — Close 3 program-blocking open questions (price/gate, labor default=40%, ramp/seasonality calibration source) + recorded human go/no-go | P0 | S | M-1.4 | validation, decision |

### M0

| Key | Title | P | Size | Deps | Labels |
|---|---|---|---|---|---|
| `M0.1` | Scaffold repo layout (app/, engine/, frontend/ Vite React+TS, docs/plans/) with green pytest + vite build | P0 | M |  | infra, scaffold |
| `M0.2` | Author CLAUDE.md + AGENTS.md + DEFINITION_OF_DONE.md (risks, Hard Rules, seeded Regression Registry, Mutation quad, Failure Mode Registry, M-1 checklist) | P0 | M | M0.1 | docs, scaffold |
| `QA-0` | test:code ratio meter + CI gate (scripts/ratio.py via cloc, explicit path map; fail PR if diff_ratio≤1.3 OR repo regresses <1.3; pair engine/** branch-coverage≥90%) | P0 | M | M0.1 | qa, ci, test-ratio |
| `M0.3` | FastAPI boot-refuse config validation (single-source env-requirements, no fallback chains; prod refuses on missing DB_PATH/Places/Census/AI-provider) | P0 | M | M0.1 | infra, security |
| `M0.4` | SQLite WAL+busy_timeout+serialized writes; Store Protocol (Sqlite+Postgres stub); ULID PKs; additive-only migrations incl. empty actuals + cohort_json in 0001_init | P0 | L | M0.1 | infra, data-model, data-network |
| `QA-store` | Store conformance suite (same suite green on SQLite AND Postgres stub, incl. actuals upsert/list + cohort fingerprint stability) — test-heavy | P1 | M | M0.4 | qa, data-model, portability |
| `M0.5` | GET /api/health (build SHA); enforcing CSP + CORS lock + X-Robots-Tag noindex + HSTS from day one; header tests | P0 | M | M0.1 | infra, security |
| `M0.6` | Terms-acceptance gate scaffold (required before export/share, versioned + timestamped per projection) + AI-disclosure stub | P0 | S | M0.3 | security, defensibility |
| `M0.7` | railway.toml + litestream.yml replicating /data/projections.db (NOT /app); pin soffice in Docker; ensure timeout/gtimeout; deploy healthcheck shows new build SHA | P0 | M | M0.1 | infra, ops, golden-gate |

### M1

| Key | Title | P | Size | Deps | Labels |
|---|---|---|---|---|---|
| `M1.0` | Freeze legacy annual generate_projection.py output as a non-authoritative House of Hope calibration golden (production must NOT import it) | P0 | S | M0.4 | engine, golden, tdd |
| `M1-FIX` | Pin House of Hope conservative annual occupancy $ in fixture JSON so margin ~11% AND break-even ~month 5 are deterministic | P0 | S | M1.0 | engine, fixture, correctness |
| `M1.7` | Three-way reconcile golden gate as a CI-BLOCKING RED gate FIRST (server == computed_json == LibreOffice recalc; <$0.50/0.1pp; total_errors==0; fail-closed; with AND without overrides) + reusable assert_reconciles(config, overrides) | P0 | L | M1.0, M0.7 | engine, golden-gate, ci, qa, tdd |
| `M1.1a` | compute.py driver chain: three explicit per-year shares (kill AVERAGE/midpoint; Y2 references its own input) — pure core, zero openpyxl/docx, cents/Decimal | P0 | M | M1.7, M1-FIX | engine, tdd, test-ratio |
| `M1.1b` | compute.py % cost lines: Marketing 3.75% (NEW) + Supplies 5% (REPLACES fixed $3,700) = total_rev x pct, in compute and as live Excel formulas | P0 | M | M1.1a | engine, tdd, test-ratio |
| `M1.1c` | compute.py occupancy (annual-$ OR sqft x rate; Gross/NNN +opex) + compound escalator rent_y1 x (1+e)^(y-1) on Y2-Y3 ONLY (NOT the Year-0 lease-deposit line) | P0 | M | M1.1a | engine, tdd, test-ratio |
| `M1.2` | monthly.py M0-M12 cash-flow (timed startup outflows, S-curve donation ramp, revenue lag, hire-date payroll, cumulative cash, min-cash trough); Year-1 annual == Sum(monthly M1..M12) to the penny | P0 | L | M1.1a, M1.1b, M1.1c | engine, tdd, test-ratio, data-network |
| `M1.3` | decision.py: break-even month, capital = Sum(startup)+\|peak shortfall\|+$25k reserve, cash gap, runway, payback (N/A guard), recommendation enum with traceable reasons | P0 | L | M1.2 | engine, decision, tdd, test-ratio |
| `M1.3-copy` | Recommendation copy + reason-string contract (own golden tests): each reco.tag has tested headline/sub/reason templates in plain language; House of Hope yields the exact prototype sentence; no jargon | P1 | M | M1.3 | engine, decision, copy, test-ratio |
| `M1.5` | Centralized N/A guards + flags map (rev=0 -> margins/per-unit null; Y1 net<=0 -> payback null; Y1 rev=0 -> CAGR null; negatives flagged); null != 0; zero-rev fixture .xlsx recalcs total_errors==0 | P0 | M | M1.3 | engine, tdd, test-ratio |
| `M1-SENS` | Sensitivity engine: base/down/up +/-25% on rent & donations -> net, break-even, capital; downside FIXTURED so a sign/compounding error cannot ship behind a passing happy path; Y3 rent == Y1 x 1.03^2 asserted | P0 | M | M1.3 | engine, decision, tdd, test-ratio |
| `M1-CONF` | Confidence propagation: thread flags.ramp_low_confidence + per-figure confidence into reco/metrics-reasons/kpis/Excel monthly-tab header/packet; break-even/capital/cash-gap never emitted bare | P0 | M | M1-SENS | engine, decision, trust, test-ratio |
| `M1.4` | dag.py override resolution: topological resolve, no upstream back-solve, stale-upstream flag, key {node}#{year}; derived/total/KPI/decision nodes non-pinnable REJECTED at API boundary (4xx); monthly + 3-year roll-up flow through ONE evaluator | P0 | L | M1.2 | engine, dag, tdd, test-ratio |
| `QA-2` | Override-resolution property suite (Hypothesis): any legal pin subset foots; pin->reset returns to computed; pinning net_profit#1 -> 4xx; orphaned upstream sets stale; each property case exports a clean-recalc .xlsx | P0 | M | M1.4, M1.7 | qa, engine, property-test, test-ratio |
| `QA-1` | Edge-case & N/A matrix test: parametrized over every ENGINE_CONTRACT §8 row asserts exact null + documented flag string for rev=0, Y1 net<=0, Y1 rev=0 (CAGR), break-even-never; zero-rev .xlsx recalcs total_errors==0 | P0 | M | M1.5, M1.7 | qa, engine, test-ratio |
| `QA-3` | Sensitivity sign/compounding golden fixtures (downside -25% rent&donations; escalator (1+e)^(y-1) Y3 == Y1*1.03^2) | P0 | S | M1-SENS, M1.7 | qa, engine, golden |
| `M1-IMPORTGUARD` | Import-guard test: engine/compute.py imports neither openpyxl nor python-docx (mechanical proof of single math surface) | P0 | S | M1.1a | qa, engine, ci |
| `M1.6` | xlsx.py to the §18 cell contract: blue inputs, live formulas, orange overridden component + comment, totals always formulas, separate monthly tab referenced by Y1 P&L, IF(denom=0,"",num/denom) on every division; per-request temp dir + stream (no org_name path traversal) | P0 | L | M1.4, M1.5 | engine, excel, tdd, test-ratio |
| `M1.8` | Version/upgrade lifecycle read path: stored model_version != current -> return snapshot verbatim + upgrade_available; never silently recompute; upgrade-model writes new revision | P0 | M | M1.3 | engine, versioning, tdd |
| `M1-PROV` | Provenance stamp on exports: xlsx.py + packet.py emit model_version + compute_schema_version + computed_hash + generation date as VISIBLE cells/footer | P1 | S | M1.6 | engine, excel, trust |
| `M1.9` | Perf test: p95 server compute < 50ms (excl. LLM) for monthly model + override resolution on §5 fixtures | P1 | S | M1.2, M1.4 | engine, perf |

### M2

| Key | Title | P | Size | Deps | Labels |
|---|---|---|---|---|---|
| `M2.1` | POST/GET/PATCH /api/projections — owner-scoped CRUD with the Mutation Safety quad (Bearer + If-Match, optimistic concurrency, 409-with-current-state) | P0 | L | M1.7 | api, persistence, mutation-quad |
| `M2.2` | Capability-token auth in deps.py — hashed SHA-256 owner/edit + plaintext view_slug, hmac.compare_digest, secrets only via Bearer/fragment, one-time recovery code | P0 | L | M2.1 | api, security, auth |
| `QA-5` | Mutation Safety quad as a PARAMETRIZED contract test over a route registry (unregistered mutating route fails the suite by omission) | P0 | M | M2.1, M2.2 | qa, api, security, test-ratio |
| `M2.3` | React 18 + TS + Vite scaffold — TanStack Query (computed_json cache keyed by view_slug) + thin Zustand/useReducer; delete all client math | P0 | M | M1.7 | frontend, scaffold |
| `QA-6` | No-client-math AST/lint guard (fails build on any calc/arithmetic-on-financial-fields) + axe-core a11y baseline on wizard/cell-edit/override-popover/inspector/409-modal (zero AA violations) | P0 | M | M2.3 | qa, frontend, a11y, ci |
| `M2.10` | Two-layer design tokens (brand-* vs semantic-*) as CSS custom properties; cell-state classes reference semantic tokens only; meaning by icon+text; tabular-nums on all numerics | P0 | S | M2.3 | frontend, design, a11y |
| `M2-D3a` | Decision banner + KPI strip — reco chip (icon+text) + plain-language headline + case/confidence label + 3 individually tappable metrics → reason strings; full a11y; renders House of Hope golden | P0 | L | M2.3, M2.10, M1.3 | frontend, decision, a11y, activation |
| `M2-D3b` | Monthly cash-flow chart + table — hand-rolled SVG dual-scale, break-even marker, cumulative-cash line, negatives in red parentheses + server-emitted numbers-anxiety reframing copy | P0 | L | M2-D3a | frontend, decision, a11y |
| `M2-D3c` | 3-year table — persistent legend (Input/Computed/Overridden/Estimated), cell classes, read-only derived rows, helper text, Settings-first steering; per-state ACs + design-QA at 1440/768/375 on the three golden fixtures | P0 | L | M2-D3a | frontend, a11y |
| `M2-D3d` | Sensitivity strip + downside value on capital/break-even tiles + 'Why?' plain-language reason tree for capital (Σ startup + peak trough + $25k reserve, in the user's own dollars) | P0 | M | M2-D3a, M1-CONF | frontend, decision, trust, a11y |
| `M2.5` | Two-tab detail page (Projection \| Settings) + persistent top bar + autosave loop (debounce → optimistic pending → PATCH If-Match → reconcile → saveLabel state machine); one revision per settle; stale responses dropped by version | P0 | L | M2-D3a, M2.1 | frontend, persistence, activation |
| `M2.4-settings` | Settings tab sliders (labor/marketing/supplies/card/payroll-tax/salvage, occupancy, escalator, 3 shares) with autosave + live re-decide — dragging labor 40→60 flips the chip in real time | P0 | M | M2.5 | frontend, decision, activation |
| `M2.6` | Save-conflict (409) modal — Reload latest / Overwrite / Save as copy; frontend tracks server version from every response and never silently overwrites | P0 | S | M2.5 | frontend, persistence |
| `M2-D6` | Error/degraded + autosave states (design+build) — 409 conflict, offline/save-failure (retry+local draft), version chip 'new model available', read-only edit attempt, AI opt-out | P1 | M | M2.6 | frontend, error-states, a11y |
| `M2.7` | Minimal 5-step wizard — 3 explicit per-year share fields (no auto-midpoint), even-ramp pre-fill + Conservative/Moderate/Aggressive presets, live share helper, defensible defaults (Generate from step 1), local draft recovery (no server record until Generate) | P0 | L | M2-D3a, M2.1 | frontend, wizard, activation |
| `M2-D2a` | One-click 'Start from example' — House of Hope prefilled → Generate → decision banner, zero wizard steps | P0 | S | M2.7 | frontend, activation |
| `M2.8` | Projections list (/, owner-scoped, never global) — name, location+basis, updated, Y1 revenue, net profit, capital required, recommendation chip; open/duplicate/trash+restore; empty state with 'start from example' | P0 | M | M2-D3a, M2.1 | frontend, activation |
| `C5-early` | Owner-token recovery affordance at create — 'save this link' + one-time recovery code (token loss = total account loss in a no-login product) | P0 | S | M2.2 | frontend, security, activation |
| `M2-INSTR` | Activation instrumentation (PostHog, non-financial events only per §22) — funnel landing→wizard_start→generate→banner_view→xlsx_download→reopen + computed time_to_first_decision | P0 | S | M2-D3a | frontend, growth, instrumentation |
| `M2-INTENT` | 'Request expert review' CTA + conversion event wired and instrumented in M2 — routes to CRM/intent store the day M2 ships to board-share users | P0 | S | M2-INSTR | frontend, gtm, instrumentation |
| `M2.9` | GET …/xlsx + GET …/packet (basic structured-facts packet, no prose, FREE/ungated) behind terms gate; packet page 1 leads with the canonical banner artifact; live-path .xlsx passes the recalc gate | P0 | M | M1.6, M2.1 | api, export, gtm |
| `QA-7` | Real-browser happy-path E2E (chrome MCP) — wizard → Generate → assert banner+cash-flow+reco from view-model → autosave → reopen by view_slug (same numbers) → export .xlsx → recalc.py (total_errors==0). The 'M2 IS the product' proof | P0 | M | M2.9, M2-D3b, M2.5 | qa, e2e, test-ratio |
| `M2-MOBILE` | Mobile-375 review-first — banner is FIRST paint (chip+headline+capital before scroll), tap popovers (no hover), horizontal-scroll KPI/cash-flow, feedback above bottom nav; light assumption edits only (heavy override is desktop/tablet by design) | P1 | M | M2-D3a, M2-D3b | frontend, mobile, a11y |

### M3

| Key | Title | P | Size | Deps | Labels |
|---|---|---|---|---|---|
| `M3.1` | M3.1 — Places autocomplete proxy + async POST /api/research (Census households per locked basis, ACS vintage + geography stored; never in compute hot path) | P1 | L | M2.1 | api, research |
| `M3.2` | M3.2 — Research fetcher SSRF hardening (block private/link-local/loopback/metadata ranges + redirects to them); store url/title/fetch_date/extracted_text/source_date/source_tier | P1 | M | M3.1 | api, research, security |
| `M3.3` | M3.3 — LLM extract-only rent estimate over server-fetched snippets (untrusted data; injection stripped; unfetched citations rejected); Anthropic-primary/OpenAI-fallback router | P1 | L | M3.2 | api, research, ai, security |
| `QA-AI` | QA-AI — Deterministic adversarial AI suite (stubbed providers): citation/injection/low-confidence invariants + full create→compute→save→.xlsx with ALL AI keys unset (opt-out) green | P1 | M | M3.3 | qa, ai, security, test-ratio |
| `M3.4` | M3.4 — Research caching by normalized location+size+basis key with TTL (manual re-research bypasses); per-IP + per-token rate limits on POST /api/research (429) | P1 | M | M3.3 | api, research |
| `M3.5` | M3.5 — Evidence panel (source/date/method/confidence + 'what would change this'); three-badge verified-vs-estimated separation (icon+text); low-confidence warning token + triangle; wizard Review-research states | P1 | L | M3.3 | frontend, research, trust, a11y |
| `M3.6` | M3.6 — POST …/evidence (attach quotes/notes/comps); file-upload hardening (type/size limits, no executable/SVG-with-script, Content-Disposition + non-executable type); attach can promote estimate→verified | P1 | M | M3.5 | api, research, security |

### M4

| Key | Title | P | Size | Deps | Labels |
|---|---|---|---|---|---|
| `M4.1` | Override cell state machine + three visual cell states (calculated/editing/overridden, auto-clear-on-equal, non-editable derived rows) | P1 | L | M2.5, M1.4 | frontend, overrides, a11y |
| `M4.2` | Override Inspector drawer (per-pin calc/value/note/date, server-computed affected[] + orphaned-upstream flag, per-pin & reset-all, driver-level-edit banner) | P1 | M | M4.1 | frontend, overrides, a11y |
| `M4.3` | Revisions list + restore, duplicate, trash/restore + hard DELETE; revision/audit log (actor_token_hash + access events); bounded growth | P1 | M | M2.1 | api, persistence, mutation-quad |
| `M4.4` | POST …/rotate-tokens: atomic owner/edit/view/role rotation, rotation audit event, immediate old-link invalidation; fragment-scrubbed edit token; read-only role views | P1 | L | M2.2 | api, security, sharing, mutation-quad |
| `M4.5` | Full Settings & assumptions tab (all sliders, occupancy/Gross-NNN/escalator, sqft, 3 shares, funding, reserve, pre-opening) with out-of-band guardrail justification notes into the packet | P1 | M | M2.4-settings | frontend, overrides |
| `M4.6` | Degraded/error states as first-class UI (remaining set): location-not-found → manual households, rent-research-failed → manual, low-confidence rent badge in editor context | P2 | M | M2-D6, M3.5 | frontend, error-states, a11y |

### M5

| Key | Title | P | Size | Deps | Labels |
|---|---|---|---|---|---|
| `M5-G0` | DESIGN: Board Packet on-screen layout + board/funder/advisor variants (page 1 canonical banner; verified-vs-estimated assumptions with confidence + 'what would change this'; downside sensitivity inline with the capital ask) | P1 | M | M2-D3d | design, packet, trust |
| `M5.1` | GET …/packet: full role-tailored Board Packet (recommendation; verified-vs-estimated assumptions; cited evidence w/ dates+confidence; sensitivity + downside; risks; cash need + break-even; monthly summary; 3-year P&L; KPIs; provenance stamp) — PDF/.docx from computed_json, banner NOT re-prose'd by LLM | P1 | L | M5-G0, M1-PROV | api, packet, export |
| `M5.2` | Grounded narrative from computed_json facts with post-generation numeric grounding (every figure must exist in computed_json/approved facts or response REJECTED — hard server validator + CI invariant); low temp; Anthropic→OpenAI fallback | P1 | L | M5.1 | api, narrative, ai, security |
| `QA-GROUND` | Numeric-grounding adversarial test (stubbed provider injects a hallucinated figure → rejection) registered in the Regression Registry; rent stated as estimate/range not fact | P1 | S | M5.2 | qa, narrative, ai, test-ratio |
| `M5.3` | Sanitize body_md server-side with an allowlist sanitizer (bleach) before storage AND render — closes stored-XSS → localStorage token theft. Test: injected <script>/inline-handler stripped | P1 | S | M5.2 | api, narrative, security |
| `M5.4` | Stale-narrative handling: store computed_hash at generation; on figure change show 'Out of date' + diff + Regenerate; never auto-overwrite user-edited prose (edited flag) | P1 | M | M5.2 | frontend, narrative |
| `M5.5` | Per-token + per-IP rate limits + regeneration cap on narrative:regenerate; AI opt-out path verified (compute/save/.xlsx with narrative disabled) | P1 | S | M5.2 | api, narrative, ai |
| `M5-G3` | Role views (board/funder/advisor) render the IDENTICAL decision banner (chip+headline+capital+Why) as the owner Projection tab — verdict travels verbatim, not a reduced summary; + AI opt-out path | P1 | M | M5.1, M4.4 | frontend, sharing, trust |

### M6

| Key | Title | P | Size | Deps | Labels |
|---|---|---|---|---|---|
| `M6.1` | POST /api/feedback — redacted bug/idea → GitHub Issue + support_id (no view_slug/token/link/financial field, ever; per-IP+token rate limit) | P2 | M | M2.1 | api, feedback, security |
| `QA-8` | Feedback-redaction CI fuzz test over a populated projection — payload never matches financial/link/token patterns; only support_id (Regression Registry, hard gate) | P2 | S | M6.1 | qa, feedback, security, test-ratio |
| `M6.2` | Feedback modal (Idea/Bug/Other + title/description/optional email; 'no sensitive financial details' notice; success shows support ID, no projection link) | P2 | S | M6.1 | frontend, feedback |
| `M6.3` | POST /api/intent → CRM (email, role, reason, opening timeline, request-expert-review, follow-up consent); distinct from feedback; per-IP+token rate limit; graceful-degrade if CRM_API_KEY unset | P2 | M | M2-INTENT | api, gtm, crm |
| `M6-GATE` | Price/gate config flag: free-vs-paid + $ price as a single server config (flip without deploy); flipping changes export/review CTA; exercised by M-1 A/B | P2 | S | M2.9 | api, gtm, config |

### M7

| Key | Title | P | Size | Deps | Labels |
|---|---|---|---|---|---|
| `M7.1` | Mobile-375 per-year stacked override editor (tap popovers, no hover, touch-reachable reset) + 768 sticky-first-col horizontal scroll | P2 | L | M2-MOBILE, M4.1 | frontend, mobile, a11y |
| `M7.2` | Full WCAG AA accessibility sweep: keyboard wizard/cell-edit/override/inspector/popover/modal, visible focus, icon+text, reduced-motion, grid arrow-nav + SR live-region on recompute | P2 | L | M7.1 | frontend, a11y, qa |
| `QA-9` | Responsive design-QA gate: 1440/768/375 stress-data screenshot set as PR artifact via chrome MCP | P2 | M | M7.2 | qa, a11y, design-qa |
| `M7.3` | Litestream restore drill: run restore-db.sh (R2 → throwaway volume), assert PRAGMA integrity_check + computed_json round-trip; document RPO/RTO/purge; LITESTREAM_* required-in-prod or loud health-check | P2 | M | M0.7 | ops, security |
| `M7.4` | Migration safety: additive-only ALTER discipline, pre-migration Litestream checkpoint, migrations before schema-dependent statements at boot, promote script verifies new build SHA | P2 | S | M0.4 | ops, data-model |
| `M7.5` | Full /security-review sweep: audit-log contents, CSP/CORS/noindex re-verify, provider data-retention, AI-disclosure UI, HTTPS/HSTS, key-loss=data-loss at create, rate limits + audit + token-entropy review | P2 | M | M7.3 | security, ops |
| `I4a` | Actuals manual entry + forecast-vs-actual diff for the operator's OWN store (single-tenant, no pooling, no privacy surface) on the already-migrated table | P3 | M | M1.2, M0.4 | data-network, actuals, post-launch |
| `I4b` | Opt-in consent + anonymized aggregation pipeline with k-anonymity minimum-cohort threshold (reuse feedback-redaction discipline); never egress a single projection's numbers | P3 | L | I4a | data-network, actuals, privacy, post-launch |
| `I4c` | Benchmark surfacing into wizard share presets / guardrail bands (the network effect); segment/filter by model_version (never blend vintages) | P3 | L | I4b | data-network, actuals, post-launch |
| `M7.7` | Observability: per-provider latency/error/volume metrics; cost-control verification (research/narrative caching, regen caps) | P2 | S | M5.5, M3.4 | ops, observability |

## Cut / deferred (v1)

- E3 full retrieval-grounded rent AUTOMATION pulled forward — DEFER to M3 behind M-1 gate (manual rent entry is sufficient for M-1 and M2; pulling research forward is the #1 way to blow budget before validating WTP)
- Override depth beyond review (cell-override state machine + Inspector) — DEFER to M4; M2 ships read-path + light assumption edits only
- Grounded LLM narrative (G2/M5.2) — DEFER to M5; M2 packet leads with the canonical banner from computed_json, NOT re-prose'd by an LLM
- Actuals/benchmarks (I4) — schema-only stub in M0 (actuals + cohort_json in 0001_init); ALL UI/pooling/benchmark surfacing DEFER to M7, split I4a/b/c; no benchmark UI in v1
- Radius / drive-time / ZCTA trade areas — OUT of v1 (City/County/Manual only); deferred with ACS-vintage/FIPS/MOE rules pre-written
- Demand drivers that scale the point estimate — OUT (v1 drivers adjust confidence only)
- Full heavy cell-override editing on mobile-375 — explicit SCOPE CUT (review-first + light assumption edits only on phone; heavy override is desktop/tablet); stated in ACs as intended scope, not unfinished
- 'Plain-language mode' label-map toggle (Occupancy->Rent as share of sales, etc.) — spec the label map now in the {raw,display} contract but CUT from v1 build; it is a config layer later, not a rebuild
- Multi-store / for-profit / chains — OUT of v1 scope
- Real ramp/seasonality CALIBRATION — DEFER to post-launch actuals backlog (PRD §6.3); v1 ships the placeholder ramp constants behind flags.ramp_low_confidence + mandatory sensitivity, never bare

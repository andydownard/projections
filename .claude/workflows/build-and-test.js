export const meta = {
  name: 'projections-build-and-test',
  description: 'Build & test the Thrift Projection site end-to-end (M0→M7), TDD-first, under a hard measured test-LOC/code-LOC > 1.3 gate with extensive E2E',
  phases: [
    { title: 'Scaffold', detail: 'M0: repo layout, FastAPI+Vite shell, SQLite/Litestream on /data, Store Protocol, CSP/CORS/noindex, terms gate, ratio meter + CI' },
    { title: 'Engine', detail: 'M1: pure compute core (TDD) behind the three-way golden gate (60% canonical + 40% design-parity)' },
    { title: 'MVP', detail: 'M2: owner-scoped API (mutation quad) + React decision-artifact UI; autosave/409; mobile-375; a11y' },
    { title: 'Research', detail: 'M3: Places + Census + extract-only grounded rent + evidence panel; works AI-disabled' },
    { title: 'Editing', detail: 'M4: cell-override DAG + inspector drawer, revisions/restore, sharing/rotate, soft delete' },
    { title: 'Packet', detail: 'M5: Board Packet variants + numeric-grounded narrative + stale-diff' },
    { title: 'Feedback', detail: 'M6: redacted GitHub feedback (support_id) + CRM intent + price/gate flag' },
    { title: 'Hardening', detail: 'M7: a11y sweep, error/degraded states, restore drill, design-QA matrix, actuals schema' },
    { title: 'Verify', detail: 'Full suite + ratio>1.3 + engine coverage ≥90% + golden gate + EXTENSIVE browser E2E' },
    { title: 'Gate', detail: 'Remediate until every gate is green; open PR' },
  ],
}

const REPO = '/Users/andydownard/projects/projections/projections'
const DOCS = `Authoritative specs (READ before writing code; do NOT invent requirements):
- ${REPO}/BUILD_PLAN.md (milestones + per-ticket sequence), ${REPO}/BACKLOG.md (the 94-ticket index), ${REPO}/ARCHITECTURE.md (layout, Store interface),
- ${REPO}/ENGINE_CONTRACT.md (formulas, defaults LABOR_PCT=0.60 canonical + 40% design-parity fixture, override DAG, golden gate, Excel contract),
- ${REPO}/DATA_MODEL.md (schema, migrations, Store Protocol), ${REPO}/API_SPEC.md (endpoints, Bearer+If-Match, 409),
- ${REPO}/SECURITY.md, ${REPO}/DEFINITION_OF_DONE.md (the Mutation Safety quad + the MEASURED ratio gate + the E2E requirement), ${REPO}/DECISIONS.md,
- ${REPO}/reference/PRD.md (v3.1), ${REPO}/reference/ENGINEERING_HANDOFF.md (view-model §5, brand §6),
- ${REPO}/reference/design/ (prototype House of Hope Projection.dc.html + screenshots), ${REPO}/CLAUDE.md + ${REPO}/AGENTS.md (the workflow rules).`

const RULES = `NON-NEGOTIABLE RULES:
1. TDD red→green: write FAILING tests FIRST, watch fail, then minimal implementation (Superpowers TDD; CLAUDE.md §2).
2. HARD GATE test-LOC/code-LOC > 1.3, MEASURED by scripts/ratio.py (cloc) over the DEFINITION_OF_DONE path map — gate BOTH the diff AND repo-wide; engine/** branch coverage ≥90% so the ratio can't be gamed by trivial assertions. Put test density in the pure engine.
3. The server compute core is PURE and the single math authority; NO client math; emit the Appendix-D view-model natively.
4. The three-way golden gate (server == legacy engine == LibreOffice-recalc'd .xlsx, <$0.50 / 0.1pp, zero formula errors) passes with AND without overrides, from the first engine commit. CANONICAL golden = House of Hope at LABOR_PCT=0.60 (revenue ~$426,911 holds; margin/decision-metrics pinned at 60% at fixture-gen). Keep a SEPARATE 40% design-parity fixture for design-QA.
5. No secrets client-side; noindex/CSP/CORS enforced; terms gate present; SSRF-guard the research fetcher; feedback carries only a support_id.
6. EXTENSIVE tests including E2E: unit/property (engine), contract+auth+409 (API), component+interaction+a11y (frontend), and Playwright E2E in e2e/ covering MULTIPLE flows (happy path, override+409, read-only share, feedback redaction, AI-disabled) at 1440/768/375.
7. Report evidence (command + output); never claim green without running it (verification-before-completion).
8. Work in the provided git worktree; commit per task with a red test first.`

phase('Scaffold')
const scaffold = await agent(
  `Scaffold the repo per ARCHITECTURE.md and the M0 tickets in BACKLOG.md/BUILD_PLAN.md. Create: the FastAPI app skeleton + a PURE compute package (engine/), the Vite/React+TS frontend shell, SQLite(WAL)+Litestream config for /data, the Store Protocol (Sqlite concrete + Postgres stub) with 0001_init incl. empty actuals + cohort_json, CSP/CORS/noindex middleware, the terms-acceptance gate, a boot-refuse-on-missing-secret config, and CRUCIALLY scripts/ratio.py (cloc-based, the path map from DEFINITION_OF_DONE) + a CI workflow (.github/workflows) that runs pytest, the frontend tests, the ratio gate (>1.3 diff + repo-wide), and engine coverage (≥90%). Write the failing smoke test and the ratio-meter self-test FIRST. Commit. Output the tree + the ratio command and its current reading.\n\n${RULES}\n\n${DOCS}`,
  { label: 'scaffold:M0', phase: 'Scaffold', isolation: 'worktree', effort: 'high' }
)

phase('Engine')
const ENGINE_PARTS = [
  'compute core: three explicit per-year shares (NO midpoint), %-of-revenue cost lines (labor 60%/marketing 3.75%/supplies 5%/card 2%/payroll-tax 7.5%/salvage 0.8%), rent escalator (compound Y2–Y3), $25k reserve; Decimal/cents internally',
  'monthly M0–M12 cash-flow: donation S-curve ramp + seasonality, hire-date payroll, timed startup outflows, cumulative cash, minimum cash, break-even month; ASSERT annual == Σ months to the penny',
  'decision metrics + recommendation enum (proceed|revise|find_cheaper_rent|raise_cash|delay|do_not_proceed) + reasons; capital = Σstartup + |peak shortfall| + reserve; cashGap; runway; sensitivity base/down/up ±25% on rent & donations; confidence flags (ramp_low_confidence)',
  'override DAG: topological recompute, pins use value, NO upstream back-solve (flag orphaned upstream), derived rows/KPIs non-pinnable (REJECT server-side), key "{node}#{year}"; N/A guards + flags map (revenue=0, Y1 net≤0, etc.)',
  'view-model emit (Appendix-D: reco/metrics/kpis/monthly/rows/overrides/evidence/settings/flags/meta, money/percent as {raw,display}) + Excel export contract (blue inputs/live formulas/orange overrides+comment/guarded IF divisions/monthly tab) + LibreOffice recalc verifier (recalc.py)',
]
const engine = await pipeline(
  ENGINE_PARTS,
  (part, _o, i) => agent(
    `M1 engine area #${i} — TDD-first behind the three-way golden gate: ${part}. Write golden + property tests FIRST (this pure deterministic core is where test density lives — push this area's ratio above 1.5). Then minimal implementation. Generate/lock the 60% canonical fixture AND the 40% design-parity fixture. Run the golden gate (recalc.py, total_errors==0) and scripts/ratio.py; output both readings. Build on the scaffold worktree.\n\n${RULES}\n\n${DOCS}`,
    { label: `engine:${i}`, phase: 'Engine', isolation: 'worktree', effort: 'high' }
  ),
  (res, _o, i) => agent(
    `Verify M1 engine area #${i}: run the full engine suite, the three-way golden gate WITH and WITHOUT overrides, engine branch coverage, and scripts/ratio.py. If red or ratio≤1.3 or coverage<90% for this area, FIX (add meaningful tests / correct math) until green. Evidence: exact commands + output.`,
    { label: `engine-verify:${i}`, phase: 'Engine', isolation: 'worktree', effort: 'high' }
  )
)

// Helper: a milestone = (implement areas TDD-first) → (verify+remediate). One pipeline per milestone keeps items flowing.
async function milestone(phaseName, areas) {
  return pipeline(
    areas,
    (area, _o, i) => agent(
      `${phaseName} — implement TDD-first (tests FIRST): ${area}. Build against the M1 engine + view-model and the prior milestones on the worktree. Run the relevant tests + scripts/ratio.py; output readings.\n\n${RULES}\n\n${DOCS}`,
      { label: `${phaseName.toLowerCase()}:${i}`, phase: phaseName, isolation: 'worktree', effort: 'high' }
    ),
    (res, _o, i) => agent(
      `Verify ${phaseName} area #${i}: run its tests + ratio meter; fix until green and ratio>1.3. Evidence: commands + output.`,
      { label: `${phaseName.toLowerCase()}-verify:${i}`, phase: phaseName, isolation: 'worktree', effort: 'high' }
    )
  )
}

phase('MVP')
const mvp = await milestone('MVP', [
  'API (M2): owner-scoped POST/GET/PATCH /api/projections with the Mutation Safety quad (Bearer + If-Match optimistic concurrency, 409-with-current-state), view-slug read-only, autosave PATCH + revision snapshot, .xlsx download, basic shareable packet, request-expert-review intent event',
  'Frontend (M2): wizard (3 explicit shares + live helper + presets, draft recovery after step 1) → Projection tab (decision banner + capital/break-even/cash-gap each with downside+confidence + monthly cash-flow SVG chart w/ break-even marker + 3-year table w/ legend + cell classes) → Settings tab (sliders, autosave) → .xlsx/packet; Thriftly brand tokens (§6); mobile-375 review-first; 409/offline states; a11y (keyboard table editing, AA, icon+text badges, recompute live-region)',
])

phase('Research')
const research = await milestone('Research', [
  'M3 API: Places autocomplete proxy + Census households (city/county/manual) + retrieval-grounded rent (SSRF-hardened fetch → snippet store → extract-only → reject unfetched citations → strip injection markers) with confidence+sources; cache; works fully with AI keys UNSET (opt-out test)',
  'M3 UI: trade-area basis selector + researched households (editable, names geography) + rent estimate w/ range+confidence badge+sources + evidence panel (verified vs estimated, method, "what would change this", +Attach evidence); research-failed/low-confidence/location-not-found states',
])

phase('Editing')
const editing = await milestone('Editing', [
  'M4: cell-override state machine (calculated/editing/overridden) + Override Inspector drawer (calc vs override, note, affected rows, reset/reset-all, prefer-driver-edits hint) wired to the server DAG',
  'M4: revisions list + restore (new revision), view/edit/role links with atomic rotate/revoke (fragment-only secrets), soft delete → trash/restore/purge window',
])

phase('Packet')
const packet = await milestone('Packet', [
  'M5: Board Packet export (board/funder/advisor variants) leading with the canonical banner, verified-vs-estimated assumptions, inline sensitivity+downside, provenance stamp; PDF/docx from computed_json',
  'M5: grounded narrative behind a HARD numeric-grounding validator (every figure must exist in computed_json or reject), body_md allowlist-sanitized, stale-diff without clobbering edited prose; AI opt-out path',
])

phase('Feedback')
const feedback = await milestone('Feedback', [
  'M6: POST /api/feedback → redacted GitHub issue (random support_id ONLY; no view_slug/token/link/financials — CI-asserted), abuse controls (per-IP/token rate limits, honeypot, caps)',
  'M6: intent capture (role/reason/timeline/expert-review) → CRM (separate store/endpoint) + the free-vs-paid price/gate server config flag (no deploy to flip)',
])

phase('Hardening')
const hardening = await milestone('Hardening', [
  'M7: full AA a11y sweep + error/degraded states (rent-failed, low-confidence, location-not-found, 409, offline, stale, read-only, AI opt-out) designed+handled',
  'M7: Litestream restore drill (documented RPO/RTO), additive-migration safety check, security review (OWASP/STRIDE on endpoints/auth/secrets), actuals schema present (NO UI), design-QA screenshot matrix 1440/768/375 on stress data',
])

phase('Verify')
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ratio_repo', 'ratio_pass', 'engine_coverage', 'golden_pass', 'tests_pass', 'e2e_flows_passed', 'e2e_flows_total', 'e2e_pass', 'failures', 'summary'],
  properties: {
    ratio_repo: { type: 'number', description: 'measured test-LOC/code-LOC repo-wide' },
    ratio_pass: { type: 'boolean' },
    engine_coverage: { type: 'number' },
    golden_pass: { type: 'boolean' },
    tests_pass: { type: 'boolean' },
    e2e_flows_passed: { type: 'number' },
    e2e_flows_total: { type: 'number' },
    e2e_pass: { type: 'boolean' },
    failures: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}
let verdict = await agent(
  `FULL end-to-end verification on the worktree. Run and report exact numbers: (1) scripts/ratio.py repo-wide (must be >1.3); (2) engine branch coverage (≥90%); (3) the three-way golden gate with & without overrides; (4) the ENTIRE test suite (pytest + frontend); (5) the EXTENSIVE Playwright E2E suite in e2e/ — count flows passed/total — covering: create→compute→decision-banner→autosave→reopen→.xlsx; override→recompute→409; read-only share cannot edit; feedback files a redacted issue (assert no projection data); AI-disabled full flow — run at 1440/768/375. Return the structured verdict with any failures.\n\n${RULES}\n\n${DOCS}`,
  { label: 'verify:all', phase: 'Verify', schema: VERIFY_SCHEMA, isolation: 'worktree', effort: 'high' }
)

phase('Gate')
let round = 0
const green = v => v.ratio_pass && v.golden_pass && v.tests_pass && v.e2e_pass && v.engine_coverage >= 90
while (round < 4 && !green(verdict)) {
  round++
  log(`Gate round ${round}: ratio=${verdict.ratio_repo} cov=${verdict.engine_coverage} golden=${verdict.golden_pass} tests=${verdict.tests_pass} e2e=${verdict.e2e_flows_passed}/${verdict.e2e_flows_total}. Remediating ${verdict.failures.length} failures.`)
  await agent(
    `Remediate until ALL gates pass. Failures: ${JSON.stringify(verdict.failures)}. ratio=${verdict.ratio_repo} (need >1.3), engine coverage=${verdict.engine_coverage} (need ≥90), golden=${verdict.golden_pass}, tests=${verdict.tests_pass}, e2e=${verdict.e2e_flows_passed}/${verdict.e2e_flows_total}. If ratio is low, add MEANINGFUL tests (golden/property in engine, interaction/a11y in frontend, mutation-quad in API, more E2E flows) — never trivial assertions. Fix failing tests/math/UI/E2E. Evidence: commands + output.\n\n${RULES}\n\n${DOCS}`,
    { label: `gate:remediate:${round}`, phase: 'Gate', isolation: 'worktree', effort: 'high' }
  )
  verdict = await agent(
    `Re-run the FULL end-to-end verification (ratio, coverage, golden, suite, extensive E2E) and return the structured verdict.`,
    { label: `gate:verify:${round}`, phase: 'Gate', schema: VERIFY_SCHEMA, isolation: 'worktree', effort: 'high' }
  )
}

if (green(verdict)) {
  await agent(
    `All gates are green. Push the build branch and open a PR against main titled "Build: M0–M7 thrift projection app" with a body summarizing milestones shipped, the final ratio/coverage/golden/E2E readings, and any deferred items (M-1 human validation, live-API-dependent paths). Output the PR URL.`,
    { label: 'gate:ship', phase: 'Gate', isolation: 'worktree', effort: 'high' }
  )
}

return {
  scaffold_done: !!scaffold,
  engine_areas: engine.filter(Boolean).length,
  milestones: { mvp: mvp.filter(Boolean).length, research: research.filter(Boolean).length, editing: editing.filter(Boolean).length, packet: packet.filter(Boolean).length, feedback: feedback.filter(Boolean).length, hardening: hardening.filter(Boolean).length },
  final_verdict: verdict,
  green: green(verdict),
}

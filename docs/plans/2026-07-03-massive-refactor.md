# Massive Refactor Implementation Plan — parameter surfacing, gap fixes, simplification, testing/security/design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Model policy (owner 2026-07-03): implementation subagents chosen by task weight (haiku = transcription, sonnet = glue, opus = engine/critical); **every code review runs on Fable**.

**Goal:** Surface every adjustable parameter as compact expand/collapse Advanced sections on the relevant wizard step and mirror the same grouping on the detail page's KPI tab, while fixing the audited P0 gaps (409-modal data loss, wizard Generate error path, narrative If-Match/rate-limit, unfrozen goldens, sensitivity never reaching users) and landing the highest-value simplifications.

**Architecture:** Server stays the only math authority. New parameters ride the existing three-layer settings pipeline (`AssumptionsIn`/`InputsIn` → frozen `Assumptions`/`Inputs` → `viewmodel.settings`), with `COMPUTE_SCHEMA_VERSION` 1.5.0→1.6.0 (settings-key + sensitivity-block additions; **no math change, MODEL_VERSION stays 2.6.0** — all new knobs default to today's byte-identical values, the anchor invariant). A single grouping taxonomy module (`web/src/wizard/paramGroups.ts`) drives both the wizard Advanced sections and the detail-page grouped grid.

**Tech Stack:** FastAPI + pydantic v2, SQLite Store, Decimal engine, openpyxl xlsx contract, React 18 + TS + Vitest + Testing Library, Playwright e2e, hypothesis for property tests.

## Global Constraints (verbatim from CLAUDE.md/ENGINE_CONTRACT)

- **NO-CLIENT-MATH** (PRD §13): client sends inputs/overrides via PATCH and renders `computed_json`. Percent÷100 / String() shaping in mappers is allowed; nothing else.
- **GOLDEN**: 3-way reconcile (server == stored == LibreOffice recalc) must stay green **with and without overrides**, < $0.50 / < 0.1pp, zero formula errors. If red, nothing lands.
- **Version discipline**: settings-key-only view-model change → bump `COMPUTE_SCHEMA_VERSION` only (1.3.0 utilitiesPerSqft precedent). Any output-math change → `MODEL_VERSION`. This plan bumps compute_schema to **1.6.0** and leaves MODEL_VERSION at **2.6.0**.
- **Anchor invariant**: every newly exposed knob's default must reproduce today's outputs byte-for-byte (goldens regen only for the *added settings keys*, never changed numbers).
- **Mutation Safety Quad** on every mutating endpoint: Bearer-401, owner-scope, If-Match→409, per-IP+per-token rate limit — each with a test.
- **Secrets**: never in URL path/query/log; edit tokens fragment-only; API stays cookie-blind (never reads `request.cookies`).
- **Override DAG**: derived rows/KPIs non-pinnable, rejected server-side; no upstream back-solve.
- **DOCS-CODE**: engine/API/schema changes update ENGINE_CONTRACT.md / API_SPEC.md / DATA_MODEL.md in the same PR.
- **tokens.css coverage gate**: every new static className needs a tokens.css rule (`tokens.coverage.test.ts`); 3-size type scale; `.num` tabular-nums; no inline `style=`.
- **NumberField** is the mandatory numeric input; unit repeated in `aria-label` (unit element is aria-hidden).
- **Ratio gate**: `python scripts/ratio.py` (test-LOC/code-LOC > 1.3) must stay green.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Verification proof set (run at every wave boundary; full set before PR)

```bash
pytest -q                              # all python
pytest engine/tests/test_golden_gate.py -q   # 3-way reconcile (needs soffice)
cd web && npm test -- --run && npm run typecheck && npm run lint
python scripts/ratio.py
```

---

## Wave 0 — Foundations (tasks independent; run in parallel)

### Task 0.1: Fix documentation drift (docs only)

**Files:** Modify: `AGENTS.md` (repo root), `DECISIONS.md`, `BUILD_PLAN.md`, `DEFINITION_OF_DONE.md`, `API_SPEC.md`
**Model: haiku.**

- [ ] `AGENTS.md`: replace `**Status:** scaffolded, **not yet built**` line with `**Status:** built & deployed (engine 2.6.0, 5-year horizon, redesign v2).`; in the same file update the stale "3-year projection" phrasing in the intro paragraph to "5-year projection" and add one sentence noting monthly cash-flow is Year-1-anchored. Do NOT touch `CLAUDE.md` (symlink).
- [ ] `DECISIONS.md`: find the labor-40% "CLOSED" entry (~line 35-39) and prepend `**SUPERSEDED by the owner 60% override (engine/model.py LABOR_PCT_OF_REVENUE)** — ` to its body. Leave history intact.
- [ ] `BUILD_PLAN.md` line ~3: update status line the same way as AGENTS.md.
- [ ] `DEFINITION_OF_DONE.md` + `AGENTS.md` Commands row: replace `pytest engine/tests/golden -q` (collects zero tests) with `pytest engine/tests/test_golden_gate.py -q`, and note `recalc.py` lives at `reference/thrift-store-projections-skill/scripts/recalc.py`.
- [ ] `API_SPEC.md` (~198-205): remove `occupancyAnnual` from the settings example (view-model never emits it); mark `donationsPerHh` as legacy alias of `donationsPerHouseholdPerYear`.
- [ ] Commit: `docs: fix status/verification/settings drift (audit W0.1)`

### Task 0.2: Delete dead code

**Files:** Delete: `web/src/wizard/StepDonorMarket.tsx`, `web/src/wizard/StepDonorMarket.test.tsx`, `web/src/wizard/StepHouseholds.tsx`, `web/src/wizard/StepHouseholds.test.tsx`, `app/schemas/` (empty package). Modify: `web/src/tokens.css` (delete the OLDER duplicate `.number-field` block — keep the later one).
**Model: haiku.**

- [ ] `grep -rn "StepDonorMarket\|StepHouseholds" web/src` → only their own test files may reference them; delete all four files.
- [ ] `grep -rn "app.schemas\|app/schemas" app scripts` → confirm zero imports, then `git rm -r app/schemas`.
- [ ] Find the two `.number-field` blocks in tokens.css; delete the first/older one; run `cd web && npm test -- --run` (tokens coverage + NumberField tests prove nothing broke).
- [ ] Run `pytest -q` and `python scripts/ratio.py` (deleting tests lowers the numerator — confirm ratio still > 1.3; if it dips, stop and report).
- [ ] Commit: `chore: delete dead wizard steps, empty app/schemas, duplicate CSS block`

### Task 0.3: scripts/regen_goldens.py — deterministic golden regeneration

**Files:** Create: `scripts/regen_goldens.py`, `scripts/test_regen_goldens.py`
**Interfaces:** Produces CLI `python scripts/regen_goldens.py` that rewrites every `engine/tests/golden/*.json` from the same fixture builders `engine/tests/conftest.py` exposes, byte-identical to what `test_fixtures_frozen.py` asserts.
**Model: sonnet.**

- [ ] Read `engine/tests/test_fixtures_frozen.py` and `engine/tests/conftest.py` to copy the exact serialization (`json.dumps(vm, indent=?, sort_keys=True)` — mirror precisely).
- [ ] Write failing test `scripts/test_regen_goldens.py`: run regen into a tmp dir, then assert output for `house_of_hope_canonical_60.json` is byte-identical to the checked-in golden (proves regen reproduces the frozen bytes **before** any engine change).
- [ ] Implement: import the fixture builders from `engine/tests/conftest.py` (refactor them into plain functions there if they are pytest-fixture-only, keeping fixture wrappers), call `to_view_model`, write each golden with the frozen serialization. `--check` flag exits 1 on diff.
- [ ] `pytest scripts/test_regen_goldens.py -q` → PASS; `pytest engine/tests -q` → PASS.
- [ ] Commit: `feat(scripts): deterministic golden regeneration with byte-identity test`

### Task 0.4: Shared API-test fixtures (app/tests/conftest.py)

**Files:** Create: `app/tests/conftest.py`. Do NOT migrate the 49 existing files (separate ticket) — new tests in this plan use these fixtures.
**Interfaces:** Produces pytest fixtures `client` (TestClient over `create_app()` with in-memory SqliteStore), `client_store` (tuple), and helper `create_projection(client, **overrides) -> (slug, owner_token, version, body)` posting the canonical House-of-Hope body.
**Model: sonnet.**

- [ ] Copy the exact fixture pattern from `app/tests/test_projections_api.py:19` (the most-copied variant) into `app/tests/conftest.py`; the factory returns the parsed create response incl. `view_slug`, bearer token, `version`.
- [ ] Prove no collision: `pytest app/tests -q` (existing files define their own local fixtures; identical names in conftest must not shadow-break — if any file's local fixture signature conflicts, rename conftest fixtures to `shared_client` / `shared_create_projection`).
- [ ] Commit: `test(app): shared client/create_projection fixtures for new tests`

### Task 0.5: Extract app/routers/common.py (duplicated router helpers)

**Files:** Create: `app/routers/common.py`, `app/tests/test_router_common.py`. Modify: `app/routers/projections.py`, `penny.py`, `feedback.py`, `research.py`, `places.py`, `roles.py`, `intent.py`, `cost_schedule.py`, `gate.py` (whichever define `_client_ip`/`_bearer`/`_utcnow`/`_rate_limited`/`_is_owner`/`_is_editor`/`_load_json`).
**Interfaces:** Produces `client_ip(request) -> str` (right-most XFF hop), `bearer(request) -> str | None`, `utcnow() -> datetime`, `is_owner(store, projection_id, token) -> bool`, `is_editor(...)`, `load_json(s) -> Any`. Penny's Optional-bearer variant preserved via the same `bearer()` returning None.
**Model: opus (security-relevant `_client_ip` drift; behavior must be preserved exactly).**

- [ ] `grep -n "_client_ip\|def _bearer\|def _utcnow\|def _rate_limited\|def _is_owner\|def _is_editor\|def _load_json" app/routers/*.py` and diff the variants. If `_client_ip` variants disagree, adopt the right-most-XFF-hop version and list every call site in the commit message.
- [ ] Write `app/tests/test_router_common.py` first: XFF parsing cases (no header, single, multi-hop, spoofed left hop), bearer extraction (missing/malformed/ok), is_owner constant-time comparison still used underneath.
- [ ] Move implementations to `common.py`; each router imports from it (keep old names as local aliases `_client_ip = client_ip` to minimize the diff). 429 response shapes must stay byte-identical (existing rate-limit tests are the net).
- [ ] `pytest app -q` → PASS. Commit: `refactor(api): single-source router plumbing helpers (client_ip/bearer/owner checks)`

---

## Wave 1 — Engine + API parameter plumbing (sequential: 1.1 → 1.2 → 1.3 → 1.4 → 1.5)

### Task 1.1: Wire SENSITIVITY_DELTA + expose it as an assumption

**Files:** Modify: `engine/model.py`, `engine/compute.py` (Assumptions), `engine/decision.py`, `engine/tests/test_decision.py`, `engine/tests/test_model.py`
**Interfaces:** Produces `Assumptions.sensitivity_delta: str = model.SENSITIVITY_DELTA`; `decision.py` derives `down = 1 + delta`, `up = 1 - delta` from it (default 0.25 → literally "1.25"/"0.75", byte-identical outputs).
**Model: opus.**

- [ ] RED: in `engine/tests/test_decision.py` add `test_sensitivity_delta_assumption_drives_stress`: build the canonical fixture with `Assumptions(sensitivity_delta="0.10")` and assert the downside scenario's occupancy stress is ×1.10 (assert via sensitivity["downside"]["net"] differing from the 0.25 run, and equality with a hand-built `_scenario_net(..., "1.10", "0.90")` call). Also `test_sensitivity_default_unchanged`: default Assumptions → sensitivity block equals the current golden values.
- [ ] `pytest engine/tests/test_decision.py -q` → FAIL (no field).
- [ ] Implement: add field to `Assumptions` (compute.py:72-86); in `decision.py:180-186` replace the `"1.25"`/`"0.75"` literals with `str(Decimal("1") + D(assumptions.sensitivity_delta))` / `str(Decimal("1") - D(assumptions.sensitivity_delta))`. Update the comment: SENSITIVITY_DELTA is now the single source (fixes the model.py-docstring violation).
- [ ] `pytest engine/tests -q` → PASS (goldens untouched — outputs byte-identical at default).
- [ ] Commit: `fix(engine): sensitivity stress reads SENSITIVITY_DELTA (dead-constant violation); expose as assumption`

### Task 1.2: Serialize sensitivity + confidence into the view-model (audit P0)

**Files:** Modify: `engine/viewmodel.py`, `engine/model.py` (COMPUTE_SCHEMA_VERSION → "1.6.0" + rationale comment), `engine/tests/test_viewmodel.py`, `engine/tests/test_model.py` (version literals)
**Interfaces:** Produces `vm["sensitivity"] = {"base"|"downside"|"upside": {"net": {raw,display}, "breakeven": int|None, "capital": {raw,display}}, "delta": float}` and `vm["confidence"] = {"ramp": "low"}` (from `flags.ramp_low_confidence`). Also adds settings keys (Task 1.3 fills values): `sensitivityDelta`, `reserveBuffer` already present, `fixedAnnual`, `nnnOpexAnnual`, `buildingSqft`, `salesfloorPct`.
**Model: opus.**

- [ ] RED: `test_viewmodel.py` — `test_sensitivity_block_serialized` (downside net/capital are `{raw,display}` money views; breakeven int-or-None; delta == 0.25) and `test_settings_block` extended with the six new keys; bump expected `compute_schema_version` literal to "1.6.0" here and in `test_model.py`.
- [ ] Implement in `to_view_model`: money_view over `result.decision.sensitivity`; settings additions: `"sensitivityDelta": float(D(a.sensitivity_delta))`, `"fixedAnnual": {label: float(v) for label, v in a.fixed_annual.items()}`, `"nnnOpexAnnual": float(D(result.inputs.nnn_opex_annual))`, `"buildingSqft": float(D(result.inputs.building_sqft))`, `"salesfloorPct": float(D(result.inputs.salesfloor_pct))`. Bump `COMPUTE_SCHEMA_VERSION = "1.6.0"` and append the rationale line to the version comment.
- [ ] Regenerate goldens: `python scripts/regen_goldens.py`; `git diff engine/tests/golden` must show ONLY added keys (sensitivity/confidence blocks + new settings keys) — zero changed numbers. Paste the diff summary in the commit body.
- [ ] `pytest engine/tests -q && pytest engine/tests/test_golden_gate.py -q` → PASS.
- [ ] Commit: `feat(engine): view-model carries sensitivity scenarios + ramp confidence + full settings (schema 1.6.0)`

### Task 1.3: Expose reserve_buffer / fixed_annual / sensitivity_delta / bounds via the API, and re-validate PATCH merges

**Files:** Modify: `app/routers/projections.py` (`AssumptionsIn`, `_merge_patch`, `_build_engine_args_from_dicts`), `app/penny/tools.py` (`_ASSUMPTION_BUCKET`), `app/routers/penny.py` (`_DRAFT_ASSUMPTION_KEYS`). Create: `app/tests/test_settings_exposure.py`
**Interfaces:** Produces `AssumptionsIn` fields: `reserve_buffer: Optional[int] = Field(None, ge=0)`, `sensitivity_delta: Optional[str] = None` (validator: Decimal in [0, 0.9]), `fixed_annual: Optional[dict[str, float]] = None` (allowlist keys == `engine.model.FIXED_ANNUAL` keys, values ge=0). Percent-field bounds added: every `*_pct` + escalator validated to Decimal in [0, 1]. `_merge_patch` re-validates the MERGED assumptions/inputs dicts through `AssumptionsIn`/`InputsIn` (drop engine-only keys before validation, e.g. `startup`) so PATCH can no longer inject out-of-range values (422, not engine crash).
**Model: opus.**

- [ ] RED tests (use Task 0.4 fixtures) in `test_settings_exposure.py`: (a) PATCH `assumptions.reserve_buffer: 40000` → 200, settings echo `reserveBuffer == 40000`, `metrics.capital.raw` moved by exactly +15000 vs before; (b) PATCH `fixed_annual: {"Pest control": 600}` → 200, Y1 total expenses +300, settings echo; (c) PATCH `fixed_annual: {"Rocket fuel": 1}` → 422; (d) PATCH `labor_pct: "5.0"` → 422 (bounds); (e) PATCH `sensitivity_delta: "0.10"` → 200 and `sensitivity.downside` changes; (f) create-time `assumptions.reserve_buffer` works too.
- [ ] Implement the fields + a `model_validator` on `AssumptionsIn` for bounds/allowlist; in `_merge_patch` (projections.py:634-641) validate merged dicts: `AssumptionsIn(**{k: v for k, v in merged_a.items() if k in AssumptionsIn.model_fields})` and reject unknown keys explicitly (keep the current TypeError→422 for engine-only keys). Preserve legacy-snapshot recompute: `_build_engine_args_from_dicts` must tolerate stored rows lacking the new keys (they all default in the frozen dataclass — verify with a stored-2.5.0-shape recompute test).
- [ ] Penny allowlists: add `reserve_buffer`, `sensitivity_delta` to `_ASSUMPTION_BUCKET` ("assumptions") and `_DRAFT_ASSUMPTION_KEYS`; do NOT allowlist `fixed_annual` (dict-valued; Penny stays fail-closed — note in code comment).
- [ ] `pytest app -q` → PASS. Commit: `feat(api): expose reserve_buffer/fixed_annual/sensitivity_delta; validate PATCH merges with bounds`

### Task 1.4: xlsx blue input cells for the newly editable settings

**Files:** Modify: `engine/xlsx.py`, `engine/tests/test_xlsx.py`
**Interfaces:** Every setting that feeds a sheet formula is a blue INPUT cell in `input_specs` referenced via `cell_ref`; fixed-annual expense rows and the reserve-buffer-fed capital line must re-foot when the input cell is edited.
**Model: opus.**

- [ ] Read `engine/xlsx.py:74-96` (`input_specs`) and locate: fixed-annual lines (verify whether they are already input-cell-driven or literal), the capital-required cell (does the sheet carry reserve buffer?), sensitivity table if present.
- [ ] RED: `test_xlsx.py` — for a workbook built with `reserve_buffer=40000`, assert the reserve-buffer input cell exists (label lookup by column A) and the capital formula references it (formula string contains the cell ref, not the literal); same pattern for one fixed-annual line ("Pest control").
- [ ] Implement minimal `input_specs` additions; every new division guarded `IF(denom=0,"",…)`.
- [ ] `pytest engine/tests/test_xlsx.py engine/tests/test_golden_gate.py -q` → PASS (recalc zero errors, with + without overrides).
- [ ] Commit: `feat(xlsx): blue input cells for reserve buffer, fixed-annual lines, sensitivity delta`

### Task 1.5: Docs for the schema/API changes (same PR, DOCS-CODE)

**Files:** Modify: `ENGINE_CONTRACT.md` (header + §1/§2 defaults), `API_SPEC.md` (settings example, §4.4 PATCH body), `DATA_MODEL.md` (settings example + view-model changelog)
**Model: haiku.**

- [ ] Add 1.6.0 changelog entries listing: sensitivity/confidence blocks, settings keys (sensitivityDelta, fixedAnnual, nnnOpexAnnual, buildingSqft, salesfloorPct), AssumptionsIn additions + bounds, PATCH re-validation. Update every defaults table row touched.
- [ ] Commit: `docs: ENGINE_CONTRACT/API_SPEC/DATA_MODEL for schema 1.6.0 settings exposure`

---

## Wave 2 — Wizard advanced options (2.1 first; 2.2–2.5 parallel after; 2.6 last)

### Task 2.1: Shared grouping taxonomy + AdvancedOptions disclosure component

**Files:** Create: `web/src/wizard/paramGroups.ts`, `web/src/components/AdvancedOptions.tsx`, `web/src/components/AdvancedOptions.test.tsx`. Modify: `web/src/tokens.css`, `web/src/wizard/useWizardState.ts` (expand-state map)
**Interfaces:** Produces:

```ts
// paramGroups.ts — single source for wizard-step advanced groups, reused by SettingsTab
import type { StepKey } from "./steps";
export interface ParamGroup { id: string; label: string; step: StepKey }
export const PARAM_GROUPS: readonly ParamGroup[] = [
  { id: "space-rates",   label: "Space & occupancy rates", step: "square-footage" },
  { id: "donation-econ", label: "Donation economics",      step: "configure-donations" },
  { id: "rent-lease",    label: "Rent & lease",            step: "startup-costs" },
  { id: "cost-structure",label: "Operating cost structure",step: "startup-costs" },
  { id: "funding",       label: "Funding & capital",       step: "startup-costs" },
  { id: "timing",        label: "Timing",                  step: "startup-costs" },
] as const;
export const groupsForStep = (s: StepKey) => PARAM_GROUPS.filter(g => g.step === s);

// AdvancedOptions.tsx — controlled <details> disclosure, compact (closed) by default
export interface AdvancedOptionsProps {
  label?: string;               // default "Advanced options"
  open: boolean;                // controlled — state lives in useWizardState
  onToggle: (open: boolean) => void;
  children: React.ReactNode;
}
```

`useWizardState` gains `advancedOpen: Partial<Record<StepKey, boolean>>` + `toggleAdvanced(step, open)` (all steps default closed = loads compact; state survives step navigation because it lives in the hook, not the step — audit landmine: steps unmount on Next/Back).
**Model: sonnet.**

- [ ] RED: AdvancedOptions renders `<details className="advanced-options">` with `<summary>` carrying the label + count badge (`{children count} settings`), respects `open`, fires `onToggle` on summary click, children hidden when closed. Test keyboard: Enter/Space on summary toggles. Test in useWizardState.test.ts: toggle persists across `goNext()`/`goBack()`.
- [ ] Implement; style `.advanced-options`, `.advanced-options__summary`, `.advanced-options__badge`, `.advanced-options__grid` in tokens.css modeled on the existing `details.assumption__sources` pattern (tokens.css:1078-1084) — muted summary row, `--space-2` gap 2-col grid (1-col ≤560px). tokens.coverage.test.ts must pass.
- [ ] `cd web && npm test -- --run` → PASS. Commit: `feat(wizard): AdvancedOptions disclosure + shared param-group taxonomy`

### Task 2.2: Square-footage step advanced section (Space & occupancy rates)

**Files:** Modify: `web/src/wizard/StepSquareFootage.tsx`, `StepSquareFootage.test.tsx`
**Interfaces:** Consumes `AdvancedOptions`, `groupsForStep("square-footage")`, existing `wiz.setUtilitiesPerSqft`/`setFixturesPerSqft` and `wiz.set`. Fields (all NumberField unless noted): utilitiesPerSqft ($/sqft/yr, 2dp), fixturesPerSqft ($/sqft, 2dp), buildoutPerSqft ($/sqft, 2dp — add `setBuildoutPerSqft` to useWizardState mirroring setFixturesPerSqft incl. cost-row reseed), leaseType (native `<select>` gross|nnn, labelled "Lease type"), nnnOpexAnnual ($/yr, 0dp, only rendered when leaseType==="nnn"; add `nnnOpexAnnual: number` to WizardDraft default 0).
**Model: sonnet.**

- [ ] RED: renders closed by default ("Advanced options" summary visible, fields absent); open → all five fields present with correct units/aria-labels; editing utilities calls setUtilitiesPerSqft; changing buildout reseeds the Build-out cost row (assert via wiz mock); leaseType select switches nnn field visibility.
- [ ] Implement; provenance badges: reuse the existing `AssumptionSource` display for utilities/fixtures ("default" → "Regional default", "user" → "Set by you") exactly as StepStartupCosts renders rent provenance.
- [ ] `npm test -- --run` → PASS. Commit: `feat(wizard): square-footage advanced options (rates, lease type, NNN opex)`

### Task 2.3: Configure-donations step advanced section (Donation economics)

**Files:** Modify: `web/src/wizard/StepConfigureDonations.tsx`, `StepConfigureDonations.test.tsx`, `web/src/wizard/useWizardState.ts` (add `salvagePct: number` default 0.8 to WizardDraft — human units, %)
**Interfaces:** Advanced fields: basket ($, 2dp, existing draft.basket — currently dead, now real), donationsPerHh (/yr, 0dp), salvagePct (%, 2dp). Consumes AdvancedOptions from 2.1.
**Model: sonnet.**

- [ ] RED: closed by default; open shows the three fields; edits write draft keys (basket 17.08 shown; salvage shows 0.8 with % suffix; aria-labels carry units).
- [ ] Implement. `npm test -- --run` → PASS.
- [ ] Commit: `feat(wizard): donation-economics advanced options (basket, donations/yr, salvage %)`

### Task 2.4: Startup-costs step — visible Source of funds + three advanced groups

**Files:** Modify: `web/src/wizard/StepStartupCosts.tsx`, `StepStartupCosts.test.tsx`, `web/src/wizard/useWizardState.ts` (add to WizardDraft: `laborPct: 60, marketingPct: 3.75, suppliesPct: 5, cardPct: 2, payrollTaxPct: 7.5, escalatorPct: 3, reserveBuffer: 25000, sensitivityDeltaPct: 25, fixedAnnual: { "Insurance liability": 2000, "Internet, Phones": 3000, "Pest control": 300, "Repairs/maintenance": 1600, "Security system": 900 }` — human units)
**Interfaces:** (a) NEW always-visible "Source of funds" fieldset: cash / grant / loan NumberFields ($, 0dp) + a server-free note "Totals are computed after Generate" (no client sum displayed — NO-CLIENT-MATH); (b) AdvancedOptions "Rent & lease": escalatorPct (%); (c) "Operating cost structure": the five cost %s + five fixedAnnual lines ($/yr, 0dp); (d) "Funding & capital": reserveBuffer ($), sensitivityDeltaPct (%). Rent stays primary (research badge untouched). Opening month + cost schedule stay primary ("Timing" group label added as the heading above them).
**Model: sonnet.**

- [ ] RED: source-of-funds fieldset always visible with three fields defaulting 300000/0/0; each advanced group closed by default, opens independently; all 13 advanced fields render with correct units + aria-labels; edits write the draft.
- [ ] Implement (grid via `.advanced-options__grid`). `npm test -- --run` → PASS.
- [ ] Commit: `feat(wizard): source-of-funds visible; rent/cost/funding advanced groups on startup-costs`

### Task 2.5: Wizard Generate error state + render the disclaimer (audit P0 + P1)

**Files:** Modify: `web/src/pages/CreateProjectionPage.tsx` (Generate handler ~396-461), `web/src/pages/CreateProjectionPage.test.tsx`, `web/src/wizard/StepStartupCosts.tsx` (disclaimer paragraph)
**Interfaces:** Generate: wrap the POST in try/catch + `if (!resp.ok)`; on failure set `generateError: string | null` state, render `<div role="alert" className="wizard__generate-error">` with the message + a Retry button (re-invokes Generate); draft stays intact; never navigate unless `resp.ok && body.id`. Disclaimer: render `<p className="wizard__disclaimer">These figures are planning estimates, not financial advice.</p>` above the Generate button (class already styled at tokens.css:2407 — CSS-only today).
**Model: sonnet.**

- [ ] RED: mock fetch → 500 → alert appears with retry, `location.pathname` unchanged, draft field values preserved; mock network reject → same; mock ok → navigates as today. Disclaimer text visible on the last step.
- [ ] Implement. `npm test -- --run` → PASS.
- [ ] Commit: `fix(wizard): Generate failure surfaces an alert w/ retry; planning-estimates disclaimer renders`

### Task 2.6: Send the new fields — payload mappers + draft persistence

**Files:** Modify: `web/src/wizard/shareHelper.ts` (WizardDraft done in 2.2-2.4; extend `CreatePayload.assumptions` + `ServerCreateBody.assumptions` + both mappers), `shareHelper.test.ts`, `web/src/wizard/useWizardState.ts` + test (localStorage draft persistence)
**Interfaces:** `CreatePayload.assumptions` becomes `{ utilities_per_sqft: number; basket: number; donations_per_hh: number; salvage_pct: number; labor_pct: number; marketing_pct: number; supplies_pct: number; card_pct: number; payroll_tax_pct: number; escalator: number; reserve_buffer: number; sensitivity_delta: number; fixed_annual: Record<string, number> }`; `ServerCreateBody.assumptions` mirrors with string values (fractions: human % ÷ 100 in `buildCreatePayload`, matching the shares' existing ÷100 convention; `reserve_buffer`/`fixed_annual` stay numbers). `nnn_opex_annual: String(d.nnnOpexAnnual)` replaces the hard-coded `"0"`. Persistence: debounced (500ms) `localStorage.setItem("wizard-draft-v1", JSON.stringify(draft))`; on mount with a non-default stored draft, render a resume banner (Resume / Start fresh) — the `.wizard__resume` CSS already exists; clear the key on successful Generate.
**Model: opus (mapper correctness feeds the engine).**

- [ ] RED mapper tests: full draft round-trips — assert `ServerCreateBody.assumptions.labor_pct === "0.6"`, `salvage_pct === "0.008"`, `sensitivity_delta === "0.25"`, `fixed_annual["Pest control"] === 300`, `nnn_opex_annual === "150"` when draft.nnnOpexAnnual=150; defaults produce values byte-equal to engine defaults (anchor: a default-draft create must compute identically to an assumptions-less create — assert string equality against `engine/model.py` constants listed in the test).
- [ ] RED persistence tests: draft edit → localStorage written; remount with stored draft → banner; Resume restores; Start fresh clears; Generate success clears.
- [ ] Implement both. `npm test -- --run && npm run typecheck` → PASS.
- [ ] Commit: `feat(wizard): create payload carries all advanced assumptions; local draft persistence + resume`

---

## Wave 3 — Detail page (3.1 → 3.2 → 3.3 sequential; 3.4, 3.5 parallel anytime after 3.1)

### Task 3.1: SettingsTab grouped by wizard presentation

**Files:** Modify: `web/src/components/SettingsTab.tsx`, `SettingsTab.test.tsx`, `web/src/pages/ProjectionDetail.tsx` (settingsVm ~191-212), `web/src/tokens.css`
**Interfaces:** `ControlDef` gains `section: ParamGroup["id"]` (import PARAM_GROUPS from `../wizard/paramGroups`). Render order: KPI cells first (unchanged), then one `<AdvancedOptions>`-style collapsible group per PARAM_GROUP **in wizard order** with heading `<h3 className="kpis-grid__group-heading">{step label} — {group label}</h3>`; groups load collapsed except the group containing donor shares (primary drivers stay visible: shares Y1-Y5 + donationValue render un-grouped at top as today). New controls added with their sections: reserveBuffer ($, 0dp, patchKey `reserve_buffer`, group assumptions→funding), sensitivityDelta (%, scale 100, patchKey `sensitivity_delta`, funding), the five fixedAnnual lines ($, 0dp, patchKey `fixed_annual` — buildBody special-case: `{assumptions: {fixed_annual: {[label]: value}}}`), nnnOpexAnnual ($, 0dp, inputs `nnn_opex_annual`, rent-lease), buildingSqft (sqft, 0dp, inputs `building_sqft`, space-rates), salesfloorPct (%, scale 100, inputs `salesfloor_pct`, space-rates), rentPerSqft ($/sqft, 2dp, inputs `rent_per_sqft`, rent-lease), utilitiesPerSqft ($/sqft, 2dp, assumptions, space-rates). `settingsVm` in ProjectionDetail maps the new 1.6.0 keys (optional-presence pattern for legacy snapshots).
**Model: opus.**

- [ ] RED: groups render in wizard order with correct headings; collapsed by default (fields hidden); expanding shows controls; editing reserveBuffer PATCHes `{assumptions:{reserve_buffer:40000}}` with If-Match; editing "Pest control" PATCHes `{assumptions:{fixed_annual:{"Pest control":600}}}`; legacy snapshot (no new keys) renders zero new controls and no empty groups; existing flat-control tests updated for grouping.
- [ ] Implement. `npm test -- --run` → PASS.
- [ ] Commit: `feat(detail): settings grid grouped to mirror wizard steps; all 1.6.0 params editable`

### Task 3.2: POST /{id}/duplicate endpoint (quad-complete) + real 409-modal recovery (audit P0)

**Files:** Modify: `app/routers/projections.py`, `web/src/api/patch.ts` (PatchConflictError carries the failed body), `web/src/pages/ProjectionDetail.tsx` (resolveOverwrite/resolveSaveAsCopy ~600-611), `web/src/api/projections.ts` (duplicate call). Create: `app/tests/test_projections_duplicate.py`, e2e later (Wave 4).
**Interfaces:** `POST /api/projections/{id}/duplicate` (Bearer owner-only): copies the row (new id/view_slug/owner-scoped tokens minted like create; name = `"{name} (copy)"`; inputs/assumptions/overrides/cost_schedule copied; fresh revision snapshot; optional JSON body `{"patch": PatchProjectionIn}` applied to the copy before compute so save-as-copy carries the conflicted edit). Returns the same shape as create (201). Client: `PatchConflictError` gains `.failedBody: PatchBody`; `resolveOverwrite` re-PATCHes `err.failedBody` with the conflict's `current_version` (not `{name}`); `resolveSaveAsCopy` POSTs duplicate with `{patch: failedBody}` then navigates to the copy.
**Model: opus.**

- [ ] RED API tests (quad): 401 no bearer; 403/404 cross-owner; 429 rate-limited (per-IP+token, reuse create's limiter budget); duplicate copies settings+overrides and applies the optional patch (assert the copy's settings echo the patched value); revision row exists for the copy.
- [ ] RED client tests: conflicted settings edit → Overwrite replays the exact failed body with fresh If-Match (assert fetch body); Save-as-copy POSTs duplicate carrying the pending edit and navigates; Reload discards.
- [ ] Implement server then client. `pytest app -q && cd web && npm test -- --run` → PASS.
- [ ] Commit: `feat(api+detail): real duplicate endpoint; 409 modal overwrite/save-as-copy actually preserve the edit`

### Task 3.3: Surface sensitivity + confidence on DecisionBanner and packet (audit P0)

**Files:** Modify: `web/src/api/viewModel.ts` (types), `web/src/components/DecisionBanner.tsx` + test, `app/packet.py` (~123-145 sensitivity table) + `app/tests/test_packet.py`
**Interfaces:** DecisionBanner renders under the headline: `Downside (rent +25% / donations −25%): {sensitivity.downside.net.display} net · break-even {month|"not reached"} · capital {display}` plus a `Confidence: ramp estimate — low` chip when `vm.confidence.ramp === "low"` (delta rendered from `vm.sensitivity.delta`, not hard-coded). Packet: replace the base-only sensitivity table with base/downside/upside columns from the same block (server display strings verbatim).
**Model: sonnet.**

- [ ] RED: banner shows downside line when block present, hides cleanly for legacy snapshots (no block); "not reached" when breakeven null; packet test asserts three columns + the disclaimer row.
- [ ] Implement. `pytest app/tests/test_packet.py -q && npm test -- --run` → PASS.
- [ ] Commit: `feat(detail+packet): downside/upside sensitivity + ramp-confidence surfaced (was computed-but-dropped)`

### Task 3.4: Contrast + design-token fixes (audit P1)

**Files:** Modify: `web/src/tokens.css`, `web/src/components/OverrideAudit.tsx`, `FieldChange.tsx`, `web/src/pages/RoleView.tsx` (inline styles → classes). Create: `web/src/tokens.contrast.test.ts`
**Interfaces:** Tokenize band backgrounds (`--band-input/--band-overridden/--band-estimated`), set negative/error-on-band text to `#b91c1c`-family until every declared pair ≥ 4.5:1; darken `--placeholder` to ≥ 4.5:1; define `--warn-text`; replace literal `#35644f`/`#1d4733` with vars; move the audited inline styles into tokens.css classes. The new test computes WCAG contrast (small local luminance helper — test code, not client math) over an explicit list of declared token pairs and fails < 4.5.
**Model: sonnet.**

- [ ] RED: contrast test fails on current values for the listed pairs (error-on-band 3.56-4.49, placeholder 2.59).
- [ ] Implement token changes until the test passes; visually spot-check via existing component tests (no assertion changes expected beyond class names).
- [ ] `npm test -- --run` → PASS. Commit: `fix(design): AA contrast for cell-state bands/placeholder; tokenize inline styles; CI contrast test`

### Task 3.5: Small honesty/consistency fixes (audit P2 cluster)

**Files:** Modify: `web/src/components/ShareModal.tsx` (+test), `web/src/pages/ProjectionDetail.tsx` (updatedLabel → `formatListDate`), `web/src/components/ProjectionsList.tsx` (+test: RecoChip column + `.num` on Payback/Breakeven), `app/penny/tools.py:171` + test (Y4/Y5 diff bug)
**Model: sonnet.**

- [ ] ShareModal: only toast "Link copied" on clipboard promise resolve; on reject render "Press Ctrl+C to copy" inline (RED test with rejecting clipboard mock).
- [ ] Delete `updatedLabel`'s `toLocaleDateString` (ProjectionDetail.tsx:217-226); reuse `formatListDate` from displayLabels.ts (RED: same date renders identically in list + detail).
- [ ] ProjectionsList: add RecoChip column (component exists) + right-align Payback/Breakeven with `.num` (RED snapshot-ish assertions on cell classes).
- [ ] Penny diff: RED test — PATCH changing share_y5 → Penny's narrated diff mentions Year 5 (currently silent); fix `_diff_view_models` year iteration to the packet's `_YEAR_KEYS` tuple.
- [ ] `pytest app -q && npm test -- --run` → PASS. Commit: `fix: clipboard honesty, unified dates, list reco chip, penny y4/y5 diff`

---

## Wave 4 — Security + testing (4.1–4.5 parallel)

### Task 4.1: Narrative writes get real If-Match + rate limits (audit P0 ×2)

**Files:** Modify: `app/routers/projections.py` (put_narrative ~1107, regenerate_narrative ~1152). Create: `app/tests/test_narrative_concurrency.py`
**Interfaces:** Both endpoints: compare If-Match against the projection's current `version`; stale → 409 with `{current_version, message}` (same shape as PATCH's); success bumps version via the standard `UPDATE … WHERE version=?` optimistic write and snapshots a revision. Rate limits: regenerate = 10/hr/IP + 20/hr/token (SECURITY.md §10.1 numbers) + per-projection/day cap 50; PUT narrative = coarse 120/hr/token.
**Model: opus.**

- [ ] RED: stale If-Match → 409 both endpoints; concurrent second PUT with the pre-bump version → 409 (no silent clobber); 31st regenerate within the window → 429 with Retry-After; provider stub asserts NO provider call on 429/409.
- [ ] Implement using `common.rate_limited` (Task 0.5). `pytest app -q` → PASS.
- [ ] Commit: `fix(security): narrative writes get real optimistic concurrency + LLM rate limits`

### Task 4.2: Complete Mutation-Quad leg (d) across mutating endpoints

**Files:** Modify: `app/routers/projections.py` (PATCH, rotate-tokens, revisions/restore, trash/restore, DELETE). Create: `app/tests/test_rate_limits_mutations.py`; extend `app/tests/test_projections_revisions.py`, `test_projections_rotate.py`, `test_projections_cross_owner.py`
**Interfaces:** Coarse abuse caps (per-IP+token): PATCH 240/hr, others 60/hr — generous for autosave (350ms debounce ⇒ worst-case ~170/hr legit) yet bounding revision-row growth. Also: revisions/restore non-owner 403 + stale-If-Match 409 tests; rotate stale-409 test; DELETE cross-owner test. Update SECURITY.md §10.1 table (the doc currently exempts PATCH — reconcile to CLAUDE.md's quad, which wins).
**Model: sonnet.**

- [ ] RED each: 429 after N requests (freeze the limiter clock via its existing test seam), 403/409/cross-owner cases above.
- [ ] Implement; `pytest app -q` → PASS. Commit: `fix(security): rate-limit all mutations; close revisions/rotate/DELETE test gaps (quad complete)`

### Task 4.3: Freeze the two missing named goldens (audit P0)

**Files:** Create: `engine/tests/golden/aggressive_flagged.json`, `engine/tests/golden/grace_mission_loss.json`. Modify: `engine/tests/conftest.py` (fixture builders: Aggressive = shares 15/20/25 legacy + Y4/Y5 26/27; Grace = negative-Y1 loss case with rent $14/sqft low-confidence + one pinned Payroll cell per CLAUDE.md fixture spec), `test_fixtures_frozen.py`, `test_golden_gate.py` (3-way entries with AND without overrides), `scripts/regen_goldens.py` (include new fixtures), `app/tests/test_packet.py` (justification note travels into packet for the aggressive case)
**Model: opus.**

- [ ] RED: frozen-bytes tests for both new fixtures fail (files absent); golden-gate parametrization includes them; packet test asserts the §12.2 note renders.
- [ ] Build fixtures, regen via script, verify Grace: payback flag `N/A — no Year 1 profit`, parentheses negatives in display strings, recalc clean WITH the Payroll override pinned; Aggressive: `net_margin_out_of_band` + `share_y1_out_of_band` flags set.
- [ ] `pytest engine/tests -q && pytest engine/tests/test_golden_gate.py -q` → PASS.
- [ ] Commit: `test(golden): freeze aggressive+grace fixtures; 3-way recalc w/ and w/o overrides`

### Task 4.4: Engine property tests (hypothesis)

**Files:** Create: `engine/tests/test_properties.py`
**Interfaces:** Strategies: households 100–500k, shares 0.001–0.3 (5), basket 1–100, donation_value 1–500, sqft 500–50k, rent 1–60, opening month 1–12, schedule 0–10 rows ≤ 24 months ≤ $500k. Properties: (1) Y1 annual == sum of 12 operating-month values, exactly (Regression #15); (2) capital == |trough| + reserve (no startup double-count: recompute trough independently from rows); (3) rent Y(n) == rent Y1 × (1+e)^(n-1) for n=2..5; (4) every `{raw,display}` money pair in the vm: display parses back to round(raw) (parens negatives); (5) break-even month None or ≥ G; (6) settings echo == inputs given.
**Model: opus.**

- [ ] Write all six (deadline=None, max_examples=50 CI-friendly); run `pytest engine/tests/test_properties.py -q` → PASS (any counter-example found = STOP, report as a bug finding, do not "fix the test").
- [ ] Commit: `test(engine): property-based invariants (rollup, capital, escalator, display, breakeven)`

### Task 4.5: Coverage gate for app/ + pydantic ConfigDict + e2e conflict-recovery

**Files:** Modify: `pyproject.toml` (+`app` in coverage source, floor 80% to start), `app/routers/places.py`, `research.py` (+2 more class-Config sites → `model_config = ConfigDict(...)`). Create: `e2e/conflict-recovery.spec.ts`
**Interfaces:** e2e: open the seeded projection in two contexts; edit in A (bump version), then in B edit a driver → 409 modal → drive **each** action: Reload (B shows A's value), Overwrite (server reflects B's edit; re-GET), Save-as-copy (new projection exists with B's edit; list shows the copy).
**Model: sonnet.**

- [ ] Coverage: `pytest -q` with the new gate → if below floor, lower to the measured value minus 0 (record actual %; never delete tests to pass).
- [ ] ConfigDict migration: `pytest -q -W error::DeprecationWarning -k places` proves the warnings are gone for migrated modules.
- [ ] e2e: `cd e2e && npx playwright test conflict-recovery.spec.ts` → PASS (depends on Task 3.2's real overwrite/save-as-copy).
- [ ] Commit: `test: app coverage gate, pydantic v2 config, conflict-recovery e2e`

---

## Wave 5 — Structure splits (after all above; 5.1, 5.2, 5.3 parallel — different files)

### Task 5.1: Split app/routers/projections.py (1,747 lines) by concern

**Files:** Create: `app/routers/projections_exports.py` (xlsx, packet, staticmap), `app/routers/projections_narrative.py`, `app/routers/projections_lifecycle.py` (rotate-tokens, revisions, trash/restore, DELETE, duplicate). Keep in `projections.py`: CRUD, PATCH pipeline (`apply_projection_patch` — shared with Penny, do NOT move), preview, schemas, `_build_engine_args*`.
**Interfaces:** Identical paths/status codes/response bodies — the existing API test suite is the contract. Routers mount in `app/main.py` in the same order. Shared schemas/helpers imported from `projections.py` (no circular imports: split modules import FROM projections, never the reverse).
**Model: opus. Behavior-preserving — zero test-assertion changes allowed.**

- [ ] `pytest app -q` green BEFORE (baseline); move endpoint functions verbatim (no signature edits); `pytest app -q` green AFTER with zero test edits; `git diff --stat` in commit body.
- [ ] Commit: `refactor(api): split projections router by concern (exports/narrative/lifecycle)`

### Task 5.2: Extract ProjectionDetail hooks

**Files:** Create: `web/src/pages/detail/useProjectionSnapshot.ts`, `usePatchPipeline.ts`, `useFieldChanges.ts`, `detailHelpers.ts` (sv/shareCells/auditItems/settingsVm/MetricBar). Modify: `web/src/pages/ProjectionDetail.tsx` (target < 400 lines)
**Interfaces:** Hook signatures preserve existing behavior; the 776-line ProjectionDetail.test.tsx + override-conflict.spec.ts run unmodified.
**Model: opus. Behavior-preserving — zero test-assertion changes.**

- [ ] `npm test -- --run` green before/after with zero test edits; typecheck clean.
- [ ] Commit: `refactor(detail): extract snapshot/patch/field-change hooks from god component`

### Task 5.3: Split PennyDrawer.tsx (1,615 lines)

**Files:** Create: `web/src/components/penny/PennyPanel.tsx` (primitives), `PennyAssistant.tsx`, `PennyDraftAssistant.tsx`, `PennyGeneralAssistant.tsx` under `penny/`. Modify: `PennyDrawer.tsx` → thin re-export barrel (imports stay working).
**Model: sonnet. Behavior-preserving.**

- [ ] All 4 penny test files + importing sites pass unmodified; typecheck clean.
- [ ] Commit: `refactor(penny): split drawer into per-assistant modules behind a re-export barrel`

---

## Wave 6 — McKinsey engine fixes + final gate

### Task 6.1: Adjudicated McKinsey P0/P1 math fixes

Appended by the orchestrator after the partner synthesis lands and each finding is verified against the engine source by Fable. Only findings graded "math is wrong" (not "assumption needs data") enter this branch; assumption-default changes go to tickets (they change goldens and need owner sign-off).

### Task 6.2: Final verification + PR

- [ ] Full proof set (see top) — paste outputs; `python scripts/regen_goldens.py --check` clean; `git rebase` onto latest integrate/redesign-v2 if it moved.
- [ ] PR to `integrate/redesign-v2` with: wave summary, golden-diff note (keys added, zero numbers changed), quad matrix, screenshots of wizard advanced sections + grouped detail page at 1440/768/375.

---

## Explicitly OUT of this branch (ticketed instead)

Role-view layouts (§6.2), stale-cell popover/override UX, mobile stacked editor, evidence attachments + upload hardening, upgrade-model endpoint, expert-review CTA + funnel instrumentation, NarrativeCanvas wire-or-remove (+ DOMPurify if kept), share presets/live revenue helper, S-curve ramp presets + calibration, seasonality/opening_status/demand-confidence wire-or-remove, PDF packet, list duplicate/trash actions + start-from-example, migrating 49 test files to shared fixtures, grounding-stack consolidation (narrative.py vs aisafety.py), e2e keyboard-editing + per-worker DB + degraded-state specs, loading skeletons, cost-schedule editing on the detail page (Timing group shows opening month read-only this branch), McKinsey assumption-default changes.

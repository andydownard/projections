# Plan — Sq-ft inputs, location-researched rent, and sq-ft-scaled utilities & fixtures

- **Date:** 2026-06-27
- **Status:** SPEC / PROPOSED — leave open for owner review. This is a planning doc for a
  deferred-feature build; **no feature code lands from this PR** (docs-only).
- **Owner request (verbatim):** "ask for sqft and fraction salesfloor in the wizard; search
  based on location for representative rent; and scale utilities and fixtures with sqft, based
  on the local utilities cost and the fixtures cost in the example xlsx."
- **Engine baseline:** `model_version = 2.4.0`, `compute_schema_version = 1.2.0`.

---

## 0. Governance call — M-1 gate / M3 deferral (read first)

The request has three parts with **different** governance status:

| Part | Maps to | Gate status |
|---|---|---|
| **A.** Ask for sq-ft + salesfloor fraction in the wizard | engine inputs already exist (`building_sqft`, `salesfloor_pct`); pure UI/input plumbing | **Gate-clear.** No research, no new math authority. |
| **B.** Search by location for representative rent | **M3.3 rent estimate** (issues **#60 M3.1**, **#62 M3.3**, **#64 M3.4**, **#65 M3.5**) — explicitly **deferred behind the M-1 hard gate** (AGENTS.md / CLAUDE.md; BACKLOG "E3 retrieval-grounded rent → DEFER to M3 behind M-1 gate"). | **Gated — lifted for THIS feature by the owner.** The owner asking for it here is the human go/no-go that lifts the M-1 gate **for the rent-research slice only**. The rest of M3 (attachments #66, full evidence automation) stays deferred. |
| **C.** Scale utilities + fixtures with sq-ft from the example basis | engine-spine math change (utilities derivation) + default cost-schedule seed | **Gate-clear engine work**, but it is a **`model_version` bump + golden regen** (§4). |

**Explicit statement to fold into the build:** part B *is* the M3 research feature the owner
deferred behind the M-1 hard gate. The owner's request **lifts the gate for this feature**. It
must still be built to the **LLM-GROUNDING contract exactly** (AGENTS.md):

- **Extract-only** over **server-fetched** snippets (`app/research/fetch.py` → `app/research/snippets.py`
  → `app/research/extract.py:extract_rent`). The model never invents a number; every figure
  traces to fetched snippet text.
- **Unfetched citations are rejected** (`extract.py` already drops any cited URL not in the
  fetched set; forces `confidence="low"` when nothing survives).
- **SSRF-hardened fetch** (`fetch.py` already blocks private/link-local/loopback/metadata ranges,
  re-validates every redirect hop, pins the validated IP to defeat DNS-rebinding).
- **Injection-stripped** untrusted data (`extract.py:sanitize_for_prompt`).
- **Works with AI disabled end-to-end** — `extract_rent([], provider=None)` returns a **labeled
  benchmark at low confidence**; the wizard always allows **manual rent entry**.

**Foundation already in place (do not rebuild):** M3.2 (#61, SSRF fetcher) is **CLOSED/built**.
`fetch.py`, `snippets.py`, and `extract.py` (with `extract_rent`, the benchmark fallback, the
injection patterns, and adversarial tests `app/tests/test_research_extract.py` /
`test_research_fetch.py`) **exist and are green**, but are **not yet wired into any router**
(no `/api/research` endpoint; `extract_rent` is called only from tests). This plan wires the
snippet-builder + research router + provider router + wizard pre-fill **on top of** that
foundation; it does not re-implement the fetcher or the extractor.

---

## 1. Example-derived per-sq-ft constants (the numeric basis)

Basis = the example store: **10,000 sq ft** (`reference/.../examples/house_of_hope.json` `sqft:10000`;
methodology "Longview, TX, 10k sq ft store"). The example/methodology dollar figures divided by
10,000 sq ft give the per-sq-ft constants this feature scales by:

| Concept | Example figure (source) | Per-sq-ft basis | Proposed named constant |
|---|---|---|---|
| **Utilities/trash service** (annual operating) | `$22,300/yr` (`model.FIXED_ANNUAL`, methodology, ENGINE_CONTRACT §2) | `22,300 / 10,000` = **$2.23 / sq ft / yr** | `UTILITIES_PER_SQFT = "2.23"` |
| **Equipment & Fixtures** (one-time) | `$45,000` (`model.STARTUP`, ENGINE_CONTRACT §2) | `45,000 / 10,000` = **$4.50 / sq ft** | `FIXTURES_PER_SQFT = "4.50"` |
| **Build-out / Renovations / TI** (one-time) | `$50,000` (`model.STARTUP`) | `50,000 / 10,000` = **$5.00 / sq ft** | `BUILDOUT_PER_SQFT = "5.00"` |
| _(combined fixtures + build-out)_ | `$95,000` | **$9.50 / sq ft** | _(sum; not a separate constant)_ |
| **Rent** (representative) | example json `rent_per_sqft: 16`; canonical golden uses `occupancy_annual = $120,000` = **$12 / sq ft** at 10k | research-driven (§3); **AI-off default** pinned to keep parity | `DEFAULT_RENT_PER_SQFT = "12.00"` |

**Anchor invariant (load-bearing for §4):** every per-sq-ft constant is chosen so that **at the
example's 10,000 sq ft it reproduces today's literal exactly** (`2.23 × 10000 = 22,300`;
`4.50 × 10000 = 45,000`; `5.00 × 10000 = 50,000`). Therefore golden fixtures sized at 10,000 sq ft
(House of Hope canonical, design-parity, pre-opening custom schedule, month-1-lump) are
**numerically unchanged**; only fixtures at a different size move (§4). Document these constants in
`engine/model.py` (single source) and `ENGINE_CONTRACT.md` §2, citing the example as the basis.

> Note the rent discrepancy: the example **json** says `$16/sq ft` but the canonical golden /
> wizard default resolve occupancy to **$120,000** (`$12/sq ft` at 10k). The golden fixtures pass
> `occupancy_annual` explicitly, so they are unaffected by a wizard-default change. Pin the AI-off
> manual default to `$12/sq ft` (= today's $120k at 10k sq ft) so new manual projections do not
> silently jump; surface the value in the UI either way.

---

## 2. Current state (what exists today, with file references)

- **Engine inputs** (`engine/compute.py:Inputs`): `building_sqft`, `salesfloor_pct` (a **fraction**,
  e.g. `0.70`), `occupancy_annual` **OR** `rent_per_sqft`, `lease_type`, `nnn_opex_annual` all
  exist. `_occupancy_y1()` resolves occupancy = `occupancy_annual` **or** `building_sqft × rent_per_sqft`
  (+ `nnn_opex_annual` when `nnn`). The escalator compounds Y2–Y3 on rent only.
- **Utilities today** (`engine/model.py:FIXED_ANNUAL`): `"Utilities/trash service": 22300` — a
  **fixed annual $** in operating expenses (in `EXPENSE_ORDER`, resolved in
  `compute_annual` as `D(val)` for every year). It is **NOT** inside occupancy and does **not**
  scale with sq ft today. It is a **pinnable** component line (ENGINE_CONTRACT §8).
- **Fixtures today** (`engine/model.py:STARTUP` → `default_cost_schedule()`): `Equipment & Fixtures
  $45,000`, `Build-out/Renovations/TI $50,000` are **one-time** startup lines, seeded into the
  `cost_schedule` (mirrored client-side as `web/src/wizard/shareHelper.ts:DEFAULT_COST_SCHEDULE`).
- **Wizard** (`web/src/wizard/*`, `web/src/pages/CreateProjectionPage.tsx`): steps are
  `store → trade-area → donor-market → cost → review` (`useWizardState.ts:STEPS`). **`building_sqft`,
  `salesfloor_pct`, and rent/occupancy are NEVER asked** — they are seeded as `DEFAULT_DRAFT`
  defaults (`buildingSqft: 10000`, `salesfloorPct: 70`, `occupancyAnnual: 120000`) and shipped
  via `shareHelper.ts:buildCreatePayload` (which sends `occupancy_annual`, **not** `rent_per_sqft`).
- **Research** (`app/research/`): `fetch.py` (SSRF), `snippets.py` (`Snippet` record),
  `extract.py` (`extract_rent`, benchmark fallback `_BENCHMARK_RENT = {estimate 12, low 8, high 16,
  rent_type nnn, opex 3, basis "$/sq ft/yr"}`). **No router, no snippet-builder, not wired.**
- **Geo** (`app/geo/client.py`): Places (New) v1 autocomplete/details + Census geocoder + ACS
  households already resolve the location server-side; keys never reach the client. The resolved
  `formatted_address` / lat-lng / FIPS are available to seed rent-research queries.
- **Golden gate** (`engine/tests/test_golden_gate.py` + `engine/tests/golden/*.json`): three-way
  reconcile (engine == `computed_json` == LibreOffice recalc) **with and without overrides**.
  Fixtures: canonical (10k sq ft), design-parity (10k), pre-opening custom schedule (10k),
  month-1-lump (10k), payroll-override (10k), **Grace Mission loss case (8,000 sq ft)**.

---

## 3. Recommended design (1-paragraph summary)

Add a single new **"Space & rent"** wizard step (between trade-area and donor-market) that collects
**`building_sqft`**, the **salesfloor fraction** (entered as a percent, stored `/100` like the
shares), and **rent ($/sq ft)** — the rent field **pre-filled by a server research call** that, given
the already-resolved Places/Census location, builds candidate market-rent snippets, fetches them
through the SSRF-hardened `fetch.py`, and runs `extract_rent` (extract-only, citation-validated) to
return a representative `$/sq ft` with low/high + a **verified-vs-estimated confidence badge** and
its **sources**; with AI disabled (or no snippets) it returns the **labeled regional benchmark** at
low confidence and the field is plain manual entry. The wizard then sends **`rent_per_sqft`** (not a
flat `occupancy_annual`) so occupancy = `building_sqft × rent_per_sqft` flows through the existing
engine path, user-overridable. On the engine side, **utilities stops being a flat $ and becomes the
same existing line derived as `UTILITIES_PER_SQFT × building_sqft`** (a `model_version` bump +
golden regen), and the **default cost-schedule seed for Equipment & Fixtures / Build-out is derived
as `FIXTURES_PER_SQFT × sq ft` / `BUILDOUT_PER_SQFT × sq ft`** (a seed change, still user-editable) —
both anchored so 10,000 sq ft reproduces today's literals, keeping all 10k goldens byte-identical.

---

## 4. Engine change → `model_version` bump + golden impact (call-out)

**Yes — this changes the math authority, so it is versioned.**

- **Utilities derivation change is a math/shape change** → bump `MODEL_VERSION` **2.4.0 → 2.5.0**
  (utilities line now scales with `building_sqft`). Update the version note in `engine/model.py`
  and `ENGINE_CONTRACT.md` §0/§2.
- **View-model gains fields** (`settings.rentPerSqft`, `settings.utilitiesPerSqft`, the rent
  `evidence[]` entry) → bump `COMPUTE_SCHEMA_VERSION` **1.2.0 → 1.3.0** (additive shape change).
- **Decision: utilities stays the SAME existing line** (`"Utilities/trash service"`, same label,
  same slot in `EXPENSE_ORDER`, still pinnable) — only its *derivation* changes from
  `FIXED_ANNUAL[...]` to `utilities_per_sqft × building_sqft`. **Not a new line.** This keeps the
  view-model row set, the `.xlsx` rows, and the DAG node set stable (no new pinnable node, no
  packet/xlsx row churn).
- **Decision: fixtures are a SEED change, not an engine-resolution change.** The engine still
  consumes whatever `cost_schedule` it is given; we change the **default seed** (`engine/model.py`
  `default_cost_schedule()` derives Equipment & Fixtures / Build-out from the per-sq-ft constants ×
  `building_sqft`; `shareHelper.ts:DEFAULT_COST_SCHEDULE` mirrors it as the wizard default). Because
  the seed needs `building_sqft`, `default_cost_schedule()` takes a `building_sqft` argument
  (defaulting to the example 10,000 for the legacy/migration backfill so existing rows are
  unchanged).
- **Golden regen (the three-way gate must stay green, with AND without overrides):**
  - **Unchanged (anchor invariant):** every 10,000-sq-ft fixture — canonical (60%), design-parity
    (40%), pre-opening custom schedule, month-1-lump, payroll-override. `2.23/4.50/5.00 × 10000`
    reproduce `22,300/45,000/50,000` exactly. Their `computed_json` is numerically identical; only
    the stamped `model_version`/`compute_schema_version` strings change → **regenerate the fixture
    JSON to re-stamp the version**, assert the dollar cells are unchanged.
  - **Changed:** **Grace Mission loss case (8,000 sq ft)** — utilities moves `$22,300 → 2.23 × 8000
    = $17,840`; its net/margin/capital shift. **Regenerate this fixture** at `model_version 2.5.0`
    and re-confirm it still recalcs clean (the §12.4 N/A guards with the Payroll override present).
  - Re-run the full gate: `pytest engine/tests/golden -q` (LibreOffice `soffice` pinned), `<$0.50`
    dollar / `<0.1pp` percent, zero formula errors.
- **Backward-compat (regression #12 — no silent recompute):** existing stored projections keep
  their `computed_json` verbatim on read; a stored `model_version != 2.5.0` surfaces "New model
  available", and **`upgrade-model` writes a new revision** (existing M1.8 path). Old projections
  retain their old flat-$ utilities until explicitly upgraded. **No migration recomputes anyone.**

---

## 5. Phased TDD tasks

Each task is RED-test-first (Iron Law). Model-selection named per task (CLAUDE.md MODEL-SELECTION).
DOCS-CODE: any engine/API/view-model change updates `ENGINE_CONTRACT.md` / `API_SPEC.md` /
`DATA_MODEL.md` **in the same PR** as the code.

### Phase 1 — Engine: sq-ft-scaled utilities + per-sq-ft constants (most-capable)

- **T1.1 — Named constants + version bump.** Add `UTILITIES_PER_SQFT`, `FIXTURES_PER_SQFT`,
  `BUILDOUT_PER_SQFT`, `DEFAULT_RENT_PER_SQFT`, `EXAMPLE_BUILDING_SQFT = 10000` to `engine/model.py`;
  remove `"Utilities/trash service"` from `FIXED_ANNUAL`; bump `MODEL_VERSION` → `2.5.0`,
  `COMPUTE_SCHEMA_VERSION` → `1.3.0` with version notes.
  - *Files:* `engine/model.py`, `ENGINE_CONTRACT.md` (§0, §2).
  - *RED:* a unit test asserting `UTILITIES_PER_SQFT * EXAMPLE_BUILDING_SQFT == 22300` (Decimal) and
    the three fixtures/build-out anchors equal `45000/50000`.
  - *AC:* constants exist; anchor identities hold to the penny; no literal hard-coded in a formula.
- **T1.2 — Compute utilities from sq-ft.** In `engine/compute.py:compute_annual`, derive
  `exp["Utilities/trash service"] = building_sqft × assumptions.utilities_per_sqft` (resolved via
  `_resolve_get` so it stays pinnable), keeping its slot in `EXPENSE_ORDER`. Add
  `utilities_per_sqft` to `Assumptions` (default `model.UTILITIES_PER_SQFT`).
  - *Files:* `engine/compute.py`, `ENGINE_CONTRACT.md` (§2 expense table, §6 formula).
  - *RED:* `compute()` with `building_sqft=10000` yields Utilities `$22,300`; with `building_sqft=8000`
    yields `$17,840`; the line is still pinnable (`Utilities#1` override resolves).
  - *AC:* utilities scales linearly with sq ft; 10k = today's literal; remains a component line.
- **T1.3 — Fixtures/build-out default seed scales with sq-ft.** `default_cost_schedule(building_sqft
  = EXAMPLE_BUILDING_SQFT)` derives Equipment & Fixtures = `FIXTURES_PER_SQFT × sqft`, Build-out =
  `BUILDOUT_PER_SQFT × sqft`; Consultant + Legal stay flat. Legacy/migration callers pass no arg →
  10,000 → unchanged literals.
  - *Files:* `engine/model.py`, callers in `app/routers/projections.py` (`_schedule_columns` default).
  - *RED:* `default_cost_schedule(10000)` == today's `DEFAULT_COST_SCHEDULE` amounts;
    `default_cost_schedule(20000)` doubles the two scaled lines only.
  - *AC:* seed scales; no-arg backfill is byte-identical to today.
- **T1.4 — Golden regen + 3-way gate.** Regenerate all golden fixture JSON at `2.5.0/1.3.0`; assert
  10k fixtures' dollar cells unchanged and Grace Mission (8k) updated. Run the full reconcile with
  and without overrides.
  - *Files:* `engine/tests/golden/*.json`, `engine/tests/test_golden_gate.py` (if size asserts),
    `engine/tests/conftest.py` fixtures.
  - *AC:* `pytest engine/tests/golden -q` green; `<$0.50`/`<0.1pp`; zero formula errors.

### Phase 2 — Wizard: collect sq-ft + salesfloor fraction (standard)

- **T2.1 — New "Space & rent" step.** Add `space` to `STEPS` between `trade-area` and `donor-market`;
  `StepSpace.tsx` collects `buildingSqft` (number > 0), salesfloor **percent** (0 < p ≤ 100), and
  `rentPerSqft` (≥ 0, pre-filled in Phase 3). Validators + `blockReason` copy.
  - *Files:* `web/src/wizard/useWizardState.ts` (STEPS, STEP_LABELS, validators, blockReason),
    `web/src/wizard/StepSpace.tsx` (new), `web/src/pages/CreateProjectionPage.tsx` (render),
    `web/src/wizard/StepReview.tsx` (read-back rows), tests `useWizardState.test.ts`,
    `CreateProjectionPage.test.tsx`.
  - *RED:* Next is blocked until `buildingSqft > 0` and `0 < salesfloor% ≤ 100`; review shows them.
  - *AC:* both fields are asked, validated, humanized in Review; a11y label + `aria-describedby`
    block reason (matches existing step pattern).
- **T2.2 — Shape sq-ft, salesfloor fraction, and rent into the body.** `shareHelper.ts`: send
  `salesfloor_pct = p/100` (already coded), `building_sqft` from the step, and switch occupancy to
  **`rent_per_sqft`** (drop the flat `occupancy_annual` default). Keep `occupancy_annual` accepted by
  the server for back-compat / Penny drafts.
  - *Files:* `web/src/wizard/shareHelper.ts` (`WizardDraft`, `CreatePayload`, `ServerCreateBody`,
    `buildCreatePayload`, `toServerCreateBody`), `shareHelper`/wizard tests.
  - *RED:* `buildCreatePayload` emits `rent_per_sqft` and `salesfloor_pct` as the `/100` fraction;
    a 10k × $12 draft resolves server-side to $120,000 occupancy (parity).
  - *AC:* body carries `building_sqft`, `salesfloor_pct` (fraction), `rent_per_sqft`; server 200s.
- **T2.3 — `InputsIn` already accepts these** (no schema change needed: `building_sqft`,
  `salesfloor_pct`, `rent_per_sqft` exist on `InputsIn`). Add a server-side validation test that a
  missing/zero `building_sqft` is rejected (422) and salesfloor fraction is in `(0, 1]`.
  - *Files:* `app/routers/projections.py` (validation if absent), `app/tests/...`.
  - *AC:* invalid sq-ft / salesfloor → 422 `invalid_inputs`; valid round-trips.

### Phase 3 — Location rent research (the M3.3 slice; standard, security-reviewed)

- **T3.1 — Snippet-builder.** New `app/research/rent.py:build_rent_snippets(location, building_sqft,
  basis)` that constructs market-rent **query candidate URLs** from the resolved Places/Census
  location (city/county + "retail lease rate $/sq ft"), fetches each via `fetch.py:fetch_url`
  (SSRF-safe), and returns `list[Snippet]` (url/title/text/fetch_date/source_tier). No model here.
  - *Files:* `app/research/rent.py` (new), `app/tests/test_research_rent.py`.
  - *RED:* with a stubbed transport, blocked/oversized/redirect-to-private URLs are dropped; only
    safe fetched snippets are returned; zero snippets is a valid (empty) result.
  - *AC:* every returned snippet came through the SSRF fetcher; no raw provider payload leaks.
- **T3.2 — Provider router (Anthropic primary, OpenAI fallback), extract-only.** Wire a `Provider`
  (the `extract.py` injectable seam) that calls Anthropic, falls back to OpenAI, and returns the
  `{estimate, low, high, rent_type, opex, confidence, sources[]}` shape; **all numbers come from the
  fetched snippets**, citations validated by `extract_rent`. With keys unset → `provider=None` →
  benchmark at low confidence.
  - *Files:* `app/research/provider.py` (new, or extend `app/narrative_provider.py` pattern),
    `app/tests/test_research_extract.py` (adversarial: hallucinated URL rejected, injection stripped,
    low-confidence on no-source).
  - *AC (QA-AI #63 invariants):* unfetched citation rejected; injection markers stripped + logged
    (no full input logged); AI-off path returns labeled benchmark; deterministic with stubbed
    provider.
- **T3.3 — `POST /api/research` endpoint (#60/#62/#64).** Async endpoint: given a resolved location
  + `building_sqft` + basis, returns the grounded rent estimate with `confidence`, `sources[]`,
  `rent_type`, and a derived `rent_per_sqft` pre-fill. **Caching** by normalized
  `location+size+basis` key with TTL (#64); **per-IP + per-token rate limit** (429); never on the
  compute hot path. Reuse `app/ratelimit.py`.
  - *Files:* `app/routers/research.py` (new), `app/main.py` (mount), `app/tests/test_research_router.py`,
    `API_SPEC.md` (new endpoint).
  - *AC:* SSRF block test; unfetched-citation reject test; cache-hit test; 429 abuse test; AI-off
    returns benchmark; **no key in any response/log/URL**.
- **T3.4 — Wizard rent pre-fill + evidence (#65; standard, design/a11y).** On entering the
  Space & rent step with a resolved location, call `/api/research` and pre-fill `rentPerSqft`; show a
  **verified-vs-estimated badge** (icon + text, not color-only), source/date/method, a
  low-confidence warning triangle, and a "what would change this" line. The field is **always
  editable** (override → flips provenance to user-edited). AI-off / failed research → manual entry
  with a clear note (mirror the households `manual` degraded state).
  - *Files:* `web/src/wizard/StepSpace.tsx`, `web/src/api/research.ts` (new), evidence component,
    `web/src/wizard/StepReview.tsx`, tests.
  - *AC:* pre-fill populates; badge + sources render; override works; AI-off degrades to manual;
    keyboard + SR accessible.

### Phase 4 — Local utilities $/sq-ft from research (optional refinement; standard)

- **T4.1 — Utilities $/sq-ft via the same extract-only contract.** Default utilities uses
  `UTILITIES_PER_SQFT` (regional constant). **Optionally** refine it from research: when a fetched
  snippet carries a local utilities figure, `extract.py` surfaces a `utilities_per_sqft` (same
  citation/injection rules — a number the LLM invents is forbidden). The resolved value feeds
  `assumptions.utilities_per_sqft`; AI-off keeps the constant. Surface its confidence in evidence.
  - *Files:* `app/research/extract.py` (extend return), `app/research/rent.py`, `app/routers/research.py`,
    view-model `settings.utilitiesPerSqft`, tests.
  - *AC:* with no source → constant $2.23/sq ft; with a cited source → extracted value, evidence-
    labeled; AI-off unchanged. (If this proves low-signal, ship Phase 1–3 and keep utilities on the
    regional constant — YAGNI.)

---

## 6. Acceptance criteria (feature-level)

1. The wizard asks for **building sq ft** and **salesfloor fraction** (as a percent), validates them,
   shows them on Review, and sends them to the server (`salesfloor_pct` as a 0–1 fraction).
2. Given a resolved location, the wizard **pre-fills a representative `rent_per_sqft`** from
   server-side extract-only research, shows **verified-vs-estimated confidence + sources**, and lets
   the user override. With **AI disabled** the field is manual entry seeded by the regional benchmark;
   the full create→compute→save→`.xlsx` flow works with all AI keys unset.
3. **Utilities scales with sq ft** (`UTILITIES_PER_SQFT × building_sqft`, same existing line);
   **Equipment & Fixtures / Build-out default seed scales with sq ft** — both reproduce today's
   literals at 10,000 sq ft.
4. `MODEL_VERSION = 2.5.0`, `COMPUTE_SCHEMA_VERSION = 1.3.0`; **golden gate green with and without
   overrides** (`<$0.50` / `<0.1pp`, zero formula errors); 10k fixtures' dollars unchanged, Grace
   Mission (8k) regenerated.
5. Existing projections **read verbatim** (no silent recompute); upgrade writes a new revision.
6. Security (M3 full-audit lens): SSRF block, unfetched-citation reject, injection-strip, no key in
   path/query/log/response, per-IP + per-token rate limit, terms gate intact.
7. `scripts/ratio.py` non-regression (test-LOC/code-LOC > 1.3); `engine/**` branch coverage ≥ 90%.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Engine-spine change** (utilities) needs golden regen + the three-way gate | Anchor constants so 10k fixtures are byte-identical; only Grace Mission (8k) regenerates; run the full gate with/without overrides before land; LibreOffice `soffice` pinned. |
| **Confidently-wrong rent** (the §6.3 top damage risk) | Extract-only, never an LLM-invented number; surface low/high + **verified-vs-estimated** confidence; **always user-overridable**; AI-off labeled benchmark; "what would change this" line. |
| **Research correctness / SSRF** | Reuse the already-CLOSED, tested `fetch.py` (private/link-local/metadata blocks, per-hop redirect re-validation, IP-pinning); adversarial CI tests with stubbed providers; no raw payload/key egress. |
| **Backward-compat** (existing projections without these inputs) | `occupancy_annual` still accepted; `default_cost_schedule()` defaults to 10,000 for legacy backfill; read returns stored snapshot verbatim; upgrade = new revision (regression #12). |
| **Wizard default occupancy jump** (flat $120k → rent×sqft) | Pin AI-off `DEFAULT_RENT_PER_SQFT = $12` so 10k resolves to $120k (parity); the value is always visible/editable. |
| **Scope creep into full M3** | This lifts the gate for the **rent-research slice only** (#60/#62/#64/#65). Attachments (#66) and full evidence automation stay deferred; Phase 4 is optional/YAGNI. |
| **No-client-math regression** | All scaling + rent resolution is server-side; the client only collects inputs and renders server `{display}` strings. |

---

## 8. Global Constraints (copied verbatim from CLAUDE.md / AGENTS.md — survives compaction)

- **ENGINE = the one version-locked math authority.** `model_version` + `compute_schema_version` are
  stamped on every `computed_json`. Projections **never silently recompute** on a newer engine — read
  returns the stored snapshot and surfaces "New model available"; `upgrade-model` writes a **new
  revision** preserving the prior. The engine is the *one* math authority; the server emits display
  strings as the *one* formatting authority (`{raw, display}`).
- **NO-CLIENT-MATH.** The client sends inputs/overrides via `PATCH`/`POST` and renders `computed_json`
  only. No `calc*` in production.
- **GOLDEN — the three-way reconcile is CI-blocking.** server compute == stored `computed_json` ==
  LibreOffice recalc of the exported `.xlsx`, **with AND without overrides**, within **< $0.50** on
  dollar cells / **< 0.1pp** on percent cells, **zero** formula errors
  (`#VALUE! #DIV/0! #REF! #NAME? #NULL! #NUM! #N/A`). `soffice` pinned. If red, nothing lands.
- **LLM-GROUNDING (extends AI + INJECTION).** Web text is **untrusted data** (strip injection
  markers); the model **extracts only from server-fetched snippets**; **unfetched citations are
  rejected**; every numeric figure in narrative prose must exist in `computed_json` or generation is
  rejected; SSRF guard on the research fetcher (block private/link-local/loopback/metadata + redirects
  to them). **AI opt-out works end-to-end.** Adversarial CI tests with stubbed providers.
- **Override DAG is server-enforced.** Topological resolve; no upstream back-solve; derived
  rows/totals/KPIs are non-pinnable (rejected at the API boundary); key `"{node}#{year}"`. Utilities
  stays a pinnable component line; no new pinnable node is added.
- **Mutation Safety Quad** on every `PATCH`/`POST` (Bearer→401; owner-scope isolation;
  `If-Match`→409-with-state; per-IP + per-token rate limit), each with a test.
- **DOCS-CODE.** Any PR touching the engine, the API contract (`computed_json`/view-model), or the
  schema updates `ENGINE_CONTRACT.md` / `API_SPEC.md` / `DATA_MODEL.md` in the **same PR**.
- **MODEL-SELECTION.** Name the model in every subagent dispatch: most-capable for the engine change
  (Phase 1) + milestone-end whole-branch review; standard for the wizard/research integration
  (Phases 2–4); cheapest for pure transcription.
- **TDD / YAGNI / VERIFY.** RED test first; build only the slice in front of you (Phase 4 optional);
  claim done only with fresh command output (`pytest -q`, golden gate, `recalc.py total_errors==0`,
  `scripts/ratio.py`, browser QA at 1440/768/375).

---

## 9. Files touched (summary)

- **Engine:** `engine/model.py`, `engine/compute.py`, `engine/tests/golden/*.json`,
  `engine/tests/conftest.py`, `engine/tests/test_golden_gate.py`.
- **Research / API:** `app/research/rent.py` (new), `app/research/provider.py` (new),
  `app/research/extract.py`, `app/routers/research.py` (new), `app/main.py`, `app/ratelimit.py`,
  `app/routers/projections.py` (validation + schedule seed default).
- **Wizard / FE:** `web/src/wizard/useWizardState.ts`, `web/src/wizard/StepSpace.tsx` (new),
  `web/src/wizard/shareHelper.ts`, `web/src/wizard/StepReview.tsx`,
  `web/src/pages/CreateProjectionPage.tsx`, `web/src/api/research.ts` (new), evidence component +
  tests.
- **Docs (same-PR):** `ENGINE_CONTRACT.md`, `API_SPEC.md`, `DATA_MODEL.md`, `DECISIONS.md`
  (record the per-sq-ft constants + the M-1-gate-lift-for-this-feature decision).

---

## 10. Open questions for owner review

1. **Rent default ($12 vs $16/sq ft).** The example json says `$16`; the canonical golden uses `$12`
   (= today's $120k at 10k). Plan pins the AI-off default to **$12** for parity. Confirm, or prefer
   `$16`.
2. **Utilities escalation.** Today utilities is flat across Y1–Y3 (a fixed line). Keep it flat after
   sq-ft scaling (recommended — simplest, only sq-ft drives it), or also apply the rent escalator?
3. **Phase 4 (research-driven utilities $/sq-ft).** Worth it, or keep utilities on the regional
   constant and ship Phases 1–3? (YAGNI default: ship 1–3, constant utilities.)
4. **Where to ask sq-ft.** New "Space & rent" step (recommended) vs folding into the existing Store
   step.

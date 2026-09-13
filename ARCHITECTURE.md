# ARCHITECTURE — Thrift Store Projection Web App

**Repo:** `rallytasks/projections` · **Status:** Pre-build (scaffold target) · **Source PRD:** `reference/PRD.md` (v3.1, design-aligned) · **Owner:** Andy Downard

This document is the actionable system architecture. It expands PRD §23 (the boxes-and-arrows sketch) into a buildable design. It is binding on every other build doc; cross-link the siblings rather than restating them:

| Doc | Covers |
|---|---|
| [BUILD_PLAN.md](./BUILD_PLAN.md) | Milestones M-1→M7, sequencing, exit gates |
| [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) | Exact formulas, defaults, override DAG, golden-test gate |
| [DATA_MODEL.md](./DATA_MODEL.md) | SQLite schema, JSON column shapes, migrations |
| [API_SPEC.md](./API_SPEC.md) | Endpoint-by-endpoint request/response, status codes |
| [SECURITY.md](./SECURITY.md) | Capability tokens, CSP/CORS, SSRF, sanitization, env inventory |
| [OPS_RUNBOOK.md](./OPS_RUNBOOK.md) | Railway, Litestream, restore drill, RPO/RTO, incidents |
| [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md) | Tier-1/Tier-2 gates, mutation-safety quad |
| [CONTRIBUTING.md](./CONTRIBUTING.md) · [CLAUDE.md](./CLAUDE.md) · [AGENTS.md](./AGENTS.md) | Build loop and repo rules |
| [IDEA_FAB.md](./IDEA_FAB.md) | Redacted GitHub feedback + CRM intent loop |

---

## 0. The one correction that governs this design

> **The existing Python engine (`reference/.../generate_projection.py`) is a *calibration seed*, not the v1 math authority.** PRD §13/§23/§A call it "the reused single math authority." A line-by-line read shows it satisfies roughly 30% of v1. It is **annual-only**, hard-codes **Year-2 = midpoint** of Y1/Y3 (`compute()` line 65, and `=AVERAGE(...)` line 209) which PRD §7.1 explicitly forbids, has **no monthly cash-flow**, **no decision metrics** (break-even / capital required / cash gap / sensitivity), **no override DAG**, **no Marketing line**, treats **supplies as a fixed $3,700** (line 45) instead of % of revenue, has **no rent escalator**, and returns **positional tuples** (line 94) instead of the Appendix-D view-model. Its `build_xlsx()` also emits unguarded `=net/totrev` (line 257) and `=startup/Y1net` (line 284), which produce `#DIV/0!` and fail the §18 gate today.

Therefore M1 is an **engine rewrite that preserves the bottom-up driver chain and the blue-input / live-formula Excel styling**, behind a stable interface, version-stamped, with a golden + LibreOffice reconciliation gate built **first**. Anywhere a builder reads "reuse the engine," substitute "**extract and extend the formulas into a pure compute core, rebuild the renderers to the §18 cell contract.**" Full gap list and formula spec live in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md); the calibration seed is retained as a regression golden only.

---

## 1. Goals & non-goals (architectural)

**In scope (v1):**
- A **decision-and-funding tool** for first-store nonprofits (PRD §2 ICP): break-even month, startup capital required, first-year cash gap, and a rules-based recommendation (§4/§12) — not just a 3-year P&L.
- **Server-authoritative compute** as the *only* math surface (§13). No client math.
- **Monthly launch cash-flow** (M0–M12) from which Year-1 annual totals are rolled up (§10).
- **Capability-token access, no login** (§20). Owner bearer token; view/edit/role links.
- **Trust layer**: per-number evidence + confidence; retrieval-grounded research; grounded narrative (§15–17).
- Trade area locked to **city / county / manual** (§8). Radius/ZCTA stay deferred.
- `.xlsx` and Board Packet exports driven by the same compute output (§17/§18).
- SQLite (WAL) + Litestream on a durable Railway volume (§26), behind a data-access interface with a documented Postgres path.

**Out of scope (v1), built so it is not a later migration:**
- Multi-store / for-profit / established-chain operators (§2).
- Radius / drive-time / ZCTA trade areas (§8) — rules pre-specified for later.
- Actuals / forecast-vs-actual benchmarking and data-compounding (§6.3) — **ship the `actuals` table schema (§24) but no UI**.
- Demand drivers that *scale* the estimate (v1 drivers only adjust confidence, §9).

---

## 2. Stack decisions & rationale

| Layer | Choice | Why |
|---|---|---|
| **Backend API** | **Python 3.12 + FastAPI** | The math engine is Python (openpyxl/python-docx). Putting the API in Python means **one language owns the single math authority** with zero cross-runtime serialization of the compute graph. FastAPI gives typed Pydantic request/response models that double as the §App-D view-model schema, async I/O for the bounded research/LLM calls, and OpenAPI for free. |
| **Compute core** | Pure Python module, no web/Excel imports | A stateless, deterministic `compute(...)` decoupled from openpyxl/docx so a request never imports the Excel builder to get numbers. Renderers consume its output. This kills the §13 anti-goal of a second math/format surface. |
| **Frontend** | **React 18 + TypeScript + Vite** | Thriftly standard (§23). Dense, finance-grade table UI with live editing. TanStack Query for the server-owned `computed_json` cache; a thin local store (Zustand/useReducer) for transient UI (editing cell, drawer, wizard draft). Hand-rolled SVG charts (not a charting lib) to keep the dual-scale bar/line + break-even marker and bundle size controlled. |
| **Database** | **SQLite (WAL) + Litestream** on a **durable Railway volume** | This is a **low-write, single-host, no-login** product: writes are debounced autosaves on one row per projection, reads are owner-scoped. SQLite + WAL + `busy_timeout` + serialized writes is more than enough, with **continuous WAL replication to object storage** for durability (RPO near-zero). |
| **Not serverless / not edge** | Single long-lived host with a mounted volume | The DB **must not live on ephemeral/edge FS** (§26). Serverless functions have ephemeral disk and cold starts that break a continuously-replicated SQLite file and the autosave write pattern. A single Railway service with a volume at `/data` is the correct shape and matches the sibling `timpager` deployment. |
| **Why not Postgres in v1** | Data-access **interface** with a `PostgresStore` path | A managed Postgres is operationally heavier and unjustified at v1 write volume. We isolate all persistence behind a `Store` Protocol so the move is a drop-in **when concurrency/auth/multi-instance demand it** (§22/§26) — not a rewrite. |
| **LLM** | Anthropic primary → OpenAI fallback, behind a provider router | §16/§17. Extract-only over server-fetched snippets; never in the compute hot path; fully optional (§21 opt-out). |

> **Pin both versions.** `model_version` (the math) and `compute_schema_version` (the shape of `computed_json` / the view-model) are **separate constants**. A renderer/shape change must not be mistaken for a math change when deciding whether to show "new model available."

---

## 3. Component diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│  BROWSER  —  React 18 + TS (Vite SPA)                                       │
│  • TanStack Query cache (server-owned computed_json + version)              │
│  • Local UI store (editing cell, drawer, popover, wizard draft)             │
│  • NO MATH. Renders server view-model. Optimistic "pending" only (§10).     │
└───────────────┬────────────────────────────────────────────────────────────┘
                │  HTTPS · REST/JSON · CORS-locked · X-Robots-Tag: noindex
                │  No Authorization header — no authentication (owner decision, 2026-09-13)
                │  Mutations: + If-Match: <version>
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  APP API  —  Python / FastAPI  (single long-lived Railway service)         │
│  app/main.py  boot-time config validation (refuse to boot if required env  │
│               unset, no fallback chains) · CSP/CORS/noindex middleware      │
│  app/deps.py  If-Match parsing only — no auth of any kind lives here       │
│               anymore; rate-limit is per IP only                          │
│                                                                            │
│  app/routers/ ──────────┐                                                  │
│   projections  research  │                                                 │
│   narrative    packet    │   each router validates → calls a service       │
│   evidence     revisions │   → returns the §App-D view-model + version     │
│   tokens       feedback  │                                                 │
│   intent       actuals   │                                                 │
│   places       health    │                                                 │
│  ───────────────────────┘                                                  │
│                                                                            │
│  ┌─────────────── engine/  (THE SINGLE MATH AUTHORITY) ─────────────────┐ │
│  │  compute.py   pure compute(inputs,assumptions,demand,trade,overrides) │ │
│  │  monthly.py   M0–M12 ramp / cash-flow (Y1 annual = roll-up of months) │ │
│  │  dag.py       override DAG: topo resolve, no back-solve, stale flags  │ │
│  │  decision.py  break-even, capital required, cash gap, sensitivity,    │ │
│  │               guardrails, rules-based recommendation                  │ │
│  │  model.py     DEFAULTS, model_version, compute_schema_version         │ │
│  │  xlsx.py      .xlsx renderer (consumes resolved nodes; §18 contract)  │ │
│  │  packet.py    Board Packet (.docx/PDF) renderer                       │ │
│  │  narrative_facts.py  facts extracted from computed_json for the LLM   │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│  COMPUTE SERVICE  thin wrapper: resolve overrides → compute → version-     │
│                   stamp → persist computed_json/monthly_json/flags         │
│  RESEARCH         Places + Census + retrieval(fetch+store) + LLM extract   │
│  NARRATIVE        grounded prose from computed_json + numeric-grounding +  │
│                   stale tracking (computed_hash)                           │
│  ACCESS           tokens, view/edit/role links, revisions, soft delete,    │
│                   optimistic-concurrency (409)                             │
│  FEEDBACK→GitHub (redacted, support_id) · INTENT→CRM                        │
│                                                                            │
│  app/store/  Store Protocol → SqliteStore (v1) | PostgresStore (stub)      │
└───────────────┬────────────────────────────────────────────────────────────┘
                │  WAL writes (serialized, busy_timeout)
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  SQLite @ DB_PATH=/data/projections.db  (durable Railway volume)           │
│  Litestream → continuous WAL replication → object storage (R2/S3)          │
└──────────────────────────────────────────────────────────────────────────┘

EXTERNAL SERVICES (server-side only; browser never talks to these directly)
  Google Places · US Census (ACS) · Anthropic · OpenAI · GitHub · CRM · R2/S3
```

The boundary rule: **the browser holds bearer tokens and renders; the API holds all secrets, all math, all validation.** This is the direct analogue of the sibling product's "backend owns logic / server is single source of truth" rule and is the load-bearing invariant for the trust story.

---

## 4. Compute-core contract

The heart of the system. Specified fully in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md); the architectural contract is:

```python
# engine/compute.py — pure, deterministic, side-effect-free.
# No openpyxl / python-docx / network / filesystem / clock imports.
def compute(
    inputs: Inputs,            # opening, lease/rent type, sqft, salesfloor_pct,
                               # donation_value, share_y1/y2/y3, source_of_funds
    assumptions: Assumptions,  # labor_pct, marketing_pct, supplies_pct, card_pct,
                               # payroll_tax_pct, salvage_pct, escalator, basket,
                               # donations_per_hh, reserve_buffer, fixed lines
    demand_drivers: DemandDrivers,   # confidence only in v1 (+ seasonality → ramp)
    trade_area: TradeArea,     # basis (city|county|manual), households, acs_vintage
    overrides: dict[str, Override],  # key "{node}#{year}" → {value, note, ts}
) -> ComputeResult            # the §App-D view-model + persisted computed_json
```

Guarantees:
- **Deterministic & stateless.** Same inputs → byte-identical `computed_json` (no wall-clock, no RNG, no env reads inside the core).
- **Three explicit donor shares.** `share_y1/y2/y3` are all inputs. The Year-2 midpoint is **dead** — never compute `(y1+y3)/2`, never emit `=AVERAGE(...)`.
- **Monthly-first.** `monthly.py` builds M0–M12 (timed startup outflows, donation S-curve ramp seasonality-adjusted, hire-date payroll, lease-start fixed costs, revenue-scaled variable costs). **Year-1 annual totals are the roll-up of the 12 operating months** so the annual P&L and the monthly model can never disagree (asserted by a golden test).
- **New cost lines** (replacing the seed's structure): Marketing & outreach = `total_rev × marketing_pct`; Supplies & processing = `total_rev × supplies_pct` (replaces fixed $3,700); rent escalator = `rent_y1 × (1+escalator)^(y-1)`. Exact compounding/NNN treatment is fixed in ENGINE_CONTRACT.
- **Decision metrics in the core** (not the renderer): break-even month, startup capital required = `Σ startup + |peak cumulative cash shortfall| + reserve_buffer`, first-year cash gap = most-negative cumulative cash M0–M12, cash runway, payback, sensitivity (±25% rent & donations), and the rules-based recommendation (§12.3) as a semantic enum.
- **Numeric discipline.** Compute in cents/`Decimal`; round only at display/compare. This is what the golden gate's `<$0.50` tolerance absorbs (Python `Decimal` vs LibreOffice double recalc). ENGINE_CONTRACT names which side rounds.
- **Edge cases as explicit `null` + a `flags` map** (§12.4): revenue=0 → margin/per-unit KPIs null; Y1 net≤0 → payback null ("N/A — no Year 1 profit"); Y1 revenue=0 → CAGR null; never `#DIV/0!` in Excel.
- **Version stamp.** Every `ComputeResult` carries `model_version` + `compute_schema_version`; both are persisted on `computed_json`.

### 4.1 Override DAG (`engine/dag.py`)

Cell overrides are **pins** keyed `"{node}#{year}"` (matches `overrides_json`, §24). Resolution is a topological recompute: `resolve(node) = pin.value if pinned else f(resolve(parents))`. Rules, enforced **server-side at the API boundary, not just hidden in the UI**:
- **No upstream back-solve** — pinning a downstream node never mutates an upstream input. Upstream rows that no longer drive any pinned downstream node get a **stale flag**.
- **Derived rows / totals / margins / KPIs are non-pinnable** — pin writes to them are **rejected** (so the statement always foots).
- The monthly model and the 3-year roll-up **both flow through this single evaluator** so the two never diverge.

### 4.2 Versioning & upgrade lifecycle

- `computed_json` is persisted with the `model_version` that produced it.
- **Read path never silently recomputes.** If stored `model_version` ≠ current, return the stored snapshot **verbatim** plus an `upgrade_available: true` flag.
- `POST .../upgrade-model` recomputes on the current engine and **writes a NEW revision** — the prior revision is preserved.
- The golden fixtures (House of Hope conservative; the aggressive flagged case; the Grace Mission loss case) are pinned to a `model_version`; see ENGINE_CONTRACT for expected outputs and the LibreOffice reconciliation gate.

---

## 5. Request lifecycle

### 5.1 Read a projection
1. Browser navigates to `/{view_slug}` (read-only) or `…/edit` (editable; edit secret in URL **fragment**).
2. `GET /api/projections/{slug}` with `Authorization: Bearer <token>` if present. `app/deps.py` resolves the bearer to owner/edit/role via **constant-time hash compare**; `view_slug` is the plaintext lookup key.
3. The API returns the stored §App-D view-model + `version` (also as an `ETag`-style header) + `upgrade_available` if the stored `model_version` is behind current. **No recompute on read.**
4. The frontend caches it under the `view_slug` key (TanStack Query) and renders. The edit fragment is read once then scrubbed from the URL (`history.replaceState`) and never sent in a path/query or logged.

### 5.2 Edit → optimistic preview → server reconcile (the core loop — PRD §10/§13/§19.3)

This is the interaction the whole product depends on, and the place where PRD §13 ("no client-side computation") and the prototype's client math collide. **The prototype's `calcYears/calcMonthly/scenario` are forbidden in production.** Optimistic preview is a *visual pending state only*, never a second math authority.

```
User edits a cell / slider
   │
   ▼
[1] Local UI store records {key, draft}; cell enters "editing" state
   │
   ▼
[2] On commit (Enter/blur):
      if |value − calculated| < $0.50  → drop the pin, cell returns to "calculated"
      else                              → mark "overridden" (pending)
   │
   ▼
[3] Optimistic PREVIEW: render the edited cell + a dimmed/"pending" reconcile
    state on dependent rows/KPIs/chart. saveLabel → "Saving…".
    (Purely visual. The client does NOT recompute the statement.)
   │
   ▼
[4] Debounce ~300–400ms, then PATCH /api/projections/{slug}
      headers: Authorization: Bearer <edit>  ·  If-Match: <version>
      body:    changed inputs/assumptions/overrides
      A newer keystroke cancels the in-flight request (stale responses
      dropped by version) so the table never flickers backward.
   │
   ▼
[5] SERVER (authoritative):
      resolve overrides on the DAG → compute() → version-stamp →
      persist computed_json/monthly_json/flags → bump version
      → write ONE revision snapshot per autosave settle (§24)
   │
   ├── 200: returns the FULL §App-D view-model + new version (+ ETag)
   │        Frontend replaces the cache; pending states clear;
   │        saveLabel → "All changes saved"; chart/metrics reconcile to server truth.
   │
   └── 409 (If-Match stale): body = { error, current_version, current_state }
            Frontend shows the Save-conflict modal:
            Reload latest · Overwrite · Save as copy (§19.4).
            Never silently overwrites; the version returned in every
            response is the only source of truth for the next If-Match.
```

Budget: server compute is the **p95 server-side budget < 50ms** *excluding* research/LLM (§27). The monthly model + DAG topo-sort + override resolution is heavier than the annual model, so M1 includes a perf test. Network RTT + debounce, not compute, is the felt latency; the optimistic-pending UI hides it.

> **Single rounding/formatting authority.** The server emits each numeric as `{ raw, display }` (whole dollars / 0.1% per §12.4) so the UI, the `.xlsx`, and the packet never disagree on rounding. The client never re-derives money/percent strings. The `reco` field emits a semantic **enum** (`proceed | revise | find_cheaper_rent | raise_cash | delay | do_not_proceed`); the **client** maps enum → design token, so the API never hardcodes hex and brand/semantic token separation is preserved.

### 5.3 Export
`GET …/xlsx` and `GET …/packet` run on the server through `engine/xlsx.py` / `engine/packet.py`, consuming the **same resolved node values** as `compute()` (overridden components become hard-coded orange cells with the audit comment; totals stay `=SUM(...)` over them so the sheet foots). Output is written to a **server-controlled per-request temp dir** (never a user-supplied path — `org_name` cannot traverse), streamed, then cleaned up. Export is gated behind terms acceptance (§21); read-only users may export (§20).

### 5.4 Research / narrative (async, off the hot path)
`POST /api/research` and `POST …/narrative:regenerate` are bounded async services with per-IP + per-token rate limits. They never block compute; the full create→compute→save→export loop works with **all AI keys unset** (§21 opt-out, verified by a test). Research is retrieval-grounded (server fetches & stores sources; LLM extracts only from provided snippets; unfetched citations rejected; web text treated as untrusted data). Narrative is generated from `computed_json` facts with **post-generation numeric grounding** (every prose figure must exist in `computed_json` or the response is rejected) and a `computed_hash` for stale detection. These are **hard server-side validators**, not prompt politeness — see [SECURITY.md](./SECURITY.md).

---

## 6. Data-access layer

All persistence is behind a `Store` Protocol (`app/store/base.py`). `SqliteStore` ships in v1; `PostgresStore` is a documented drop-in stub.

```python
class Store(Protocol):
    def get_projection_by_slug(self, slug: str) -> Projection | None: ...
    def list_card_summaries(self, *, include_trashed: bool = False) -> list[Projection]: ...   # global, no auth (owner decision 2026-09-13)
    def create(self, p: Projection) -> Projection: ...
    def update_with_version_check(self, id: str, expected_version: int, patch: dict) -> int: ...  # rows-affected; 0 ⇒ 409
    def insert_revision(self, rev: Revision) -> str: ...
    def list_revisions(self, id: str) -> list[Revision]: ...
    def list_evidence(self, id: str) -> list[Evidence]: ...
    # … narratives, research_cache, feedback, intent, actuals
```

**Postgres-portability rules** (so the drop-in is real, not aspirational):
- **App-generated string PKs** (UUID/ULID), never `last_insert_rowid()` / `INSERT OR REPLACE`.
- No SQLite-only SQL above the interface (no `rowid`, no JSON1-only constructs leaking up; WAL/`busy_timeout` are `SqliteStore` internals).
- A conformance test runs the same suite against both backends so portability does not silently rot.
- Optimistic concurrency is `UPDATE … SET version=version+1, … WHERE id=? AND version=?`; a 0-row result is the **409** with `current_state` in the body. `DB_BACKEND` (`sqlite|postgres`) is an **explicit** env var so the path is never ambiguous.

Schema, JSON column shapes, and additive-only migration discipline live in [DATA_MODEL.md](./DATA_MODEL.md).

---

## 7. Proposed repo / project layout

```
projections/
├── ARCHITECTURE.md  BUILD_PLAN.md  ENGINE_CONTRACT.md  DATA_MODEL.md
├── API_SPEC.md  SECURITY.md  OPS_RUNBOOK.md  DEFINITION_OF_DONE.md
├── CONTRIBUTING.md  CLAUDE.md  AGENTS.md  IDEA_FAB.md
├── railway.toml                      # builder=dockerfile, healthcheckPath=/api/health,
│                                     # numReplicas=1, restartPolicyType=always, sleepApplication=false
├── litestream.yml                    # replicates /data/projections.db  (NOT /app — see §10)
├── Dockerfile                        # FastAPI + pinned LibreOffice (soffice) + gtimeout for the recalc gate
│
├── app/                              # FastAPI application
│   ├── main.py                       # boot + config validation (refuse-to-boot), middleware (CSP/CORS/noindex)
│   ├── deps.py                       # Bearer→owner/edit/role resolution, constant-time compare, If-Match parsing, rate limit
│   ├── config.py                     # env-requirements single source of truth (required vs optional)
│   ├── routers/
│   │   ├── projections.py            # list (owner-scoped) / create / fetch / PATCH+recompute / duplicate
│   │   │                             #   / upgrade-model / trash|restore / DELETE
│   │   ├── revisions.py  tokens.py   # revisions list+restore ; rotate-tokens
│   │   ├── research.py   places.py   # POST /api/research ; GET /api/places/autocomplete
│   │   ├── narrative.py  packet.py   # narrative GET/PUT/POST:regenerate ; xlsx + packet export
│   │   ├── evidence.py   actuals.py  # attach evidence ; post-launch actuals (schema only in v1)
│   │   ├── feedback.py   intent.py   # redacted GitHub + support_id ; CRM intent
│   │   └── health.py                 # /api/health (build SHA, db reachable, litestream live)
│   ├── services/                     # compute_service, research, narrative, access, feedback, intent
│   ├── schemas/                      # Pydantic: requests/responses incl. the §App-D view-model
│   └── store/
│       ├── base.py  sqlite.py  postgres.py(stub)
│       └── migrations/               # versioned, additive-only
│
├── engine/                           # THE SINGLE MATH AUTHORITY (pure; no web/Excel imports in compute.py)
│   ├── model.py                      # DEFAULTS, model_version, compute_schema_version
│   ├── compute.py  monthly.py  dag.py  decision.py
│   ├── xlsx.py  packet.py  narrative_facts.py
│   ├── recalc.py                     # LibreOffice recalc + formula-error gate (from the skill)
│   └── tests/golden/                 # fixtures + expected computed_json + .xlsx recalc reconciliation
│       ├── house_of_hope.json        # conservative 6/8/10% — the calibration golden
│       ├── aggressive_flagged.json   # 15/20/25% — must trigger §12.2 guardrail + justification
│       └── grace_mission_loss.json   # negative Y1, N/A payback, low-confidence rent, one overridden Payroll cell
│
├── web/                              # React 18 + TS + Vite SPA
│   ├── src/
│   │   ├── api/                      # typed client; TanStack Query hooks keyed by view_slug
│   │   ├── state/                    # local UI store (editing cell, drawer, popover, wizard draft)
│   │   ├── tokens.css                # brand-* and semantic-* CSS custom properties (Appendix D)
│   │   ├── components/               # TopBar, DecisionBanner, KpiStrip, MonthlyCashflowChart,
│   │   │                             #   ThreeYearTable, OverrideInspectorDrawer, EvidencePanel,
│   │   │                             #   SensitivityTable, SaveConflictModal, degraded-state set,
│   │   │                             #   MobileStackedYearEditor (net-new), RoleView, BoardPacketPreview
│   │   └── pages/                    # ListView, Wizard, ProjectionDetail (tabs), SettingsView
│   └── vite.config.ts
│
└── scripts/                          # restore-db.sh, dev seeders, CI helpers
```

The frontend is a static SPA served by (or alongside) the FastAPI service; everything ships in one Railway service with one volume. The prototype (`reference/.../House of Hope Projection.dc.html` and `support.js`) is a **layout + view-model-field-name reference only**; its client math does not survive into `web/`.

---

## 8. External services

| Service | Used by | Notes |
|---|---|---|
| **Google Places** | `places.py`, research | Location autocomplete → place/county + lat/lng. Server-side; `GOOGLE_PLACES_API_KEY`. |
| **US Census (ACS)** | research | Household base per locked basis (city/county) with ACS vintage + geography surfaced. `CENSUS_API_KEY`. |
| **Anthropic** | research extract, narrative | **Primary** LLM. Low temperature, extract-only. `ANTHROPIC_API_KEY`. |
| **OpenAI** | research, narrative | **Fallback** behind a provider router. `OPENAI_API_KEY` (optional; graceful degrade). |
| **GitHub** | feedback (IDEA_FAB) | Redacted issue creation; **never** a `view_slug` or resolvable link; random `support_id` only. `GITHUB_TOKEN` + `GITHUB_REPO`. |
| **CRM** | intent | Customer-intent capture (§6.1). `CRM_API_KEY` (optional). |
| **R2/S3** | Litestream | Continuous WAL replication of `/data/projections.db`. `LITESTREAM_*`. |

All external calls are **server-side only**. The browser's `connect-src` is limited to the app origin (research/narrative are proxied through the API); see [SECURITY.md](./SECURITY.md). The research fetcher must block private/link-local/metadata IP ranges (SSRF) since it fetches attacker-influenceable URLs.

---

## 9. Versioning

| Constant | Lives in | Meaning | On mismatch |
|---|---|---|---|
| `model_version` | `engine/model.py`, stamped on `computed_json` | The **math** (formulas, defaults, ramp shape) | Read returns stored snapshot verbatim + `upgrade_available`; `upgrade-model` recomputes into a **new revision** (prior preserved). |
| `compute_schema_version` | `engine/model.py`, stamped on `computed_json` | The **shape** of the view-model / `computed_json` | Drives renderer/migration compatibility; tracked separately so a shape change is never mistaken for a math change. |
| `version` (per projection) | `projections.version` (INTEGER) | Optimistic-concurrency counter | `If-Match` mismatch on any mutation → **409** with `current_state`. |

Golden fixtures are pinned to a `model_version`; the §13/§18 reconciliation gate (server compute == `computed_json` == LibreOffice recalc of the `.xlsx`, `<$0.50` / `0.1pp`, zero formula errors, **with and without overrides**) is CI-blocking and built in M1 before any UI depth.

---

## 10. Ops alignment (summary; full detail in OPS_RUNBOOK.md)

Deployment target: a Railway service in the **thriftly.com** project, single replica, volume mounted at **`/data`**, **`DB_PATH=/data/projections.db`**.

- **`railway.toml`** mirrors the sibling product: `builder=dockerfile`, `healthcheckPath=/api/health`, `numReplicas=1`, `restartPolicyType=always`, `sleepApplication=false`. `watchPatterns=["**"]` so no change deploys as silently SKIPPED.
- **`litestream.yml`** replicates **`/data/projections.db`** to R2/S3. **Do not copy the sibling's bug**: its `litestream.yml` points at `/app/timpager.db` (ephemeral container FS). The DB must live on the durable `/data` volume and Litestream must replicate from there, or the RPO/RTO claims are fiction.
- **Boot-refuse config validation** (no fallback chains): production refuses to boot if any required secret is unset. Required: `DB_BACKEND`, `DB_PATH` (sqlite) / `DATABASE_URL` (postgres), `GOOGLE_PLACES_API_KEY`, `CENSUS_API_KEY`, and **at least one** AI provider key. Optional/graceful-degrade: `OPENAI_API_KEY`, `GITHUB_TOKEN`+`GITHUB_REPO`, `CRM_API_KEY`, `LITESTREAM_*` — but Litestream replication must be **health-checked live** so it is never silently off.
- **Restore drill is a deliverable** (`scripts/restore-db.sh`), actually exercised into a throwaway volume with `PRAGMA integrity_check` and a `computed_json` round-trip, with documented RPO (near-zero) / RTO (~2 min) and backup purge limits (§21).
- **LibreOffice (`soffice`) version is pinned** in the Dockerfile and the recalc step is sandboxed/timeboxed (the gate shells out to `soffice` + a Basic macro).
- **Migrations are additive-only** (`ALTER TABLE` in idempotent steps; never DROP/recreate), run **before** the app serves, with a pre-migration Litestream checkpoint.

---

## 11. Cross-cutting invariants (the non-negotiables)

1. **Server is the only math authority.** No client compute; the prototype's `calc*` functions are forbidden (§13).
2. **One compute output feeds three surfaces** (UI, `.xlsx`, packet) — same resolved node values, same `{raw, display}` formatting authority. No second math/format surface.
3. **`computed_json` carries both versions** and never silently recomputes on a newer engine (§13).
4. **Every mutation requires `Authorization: Bearer` + `If-Match: <version>`** and has a real 409 path; lists are **owner-scoped, never global** (§20/§25).
5. **Capability tokens**: CSPRNG-generated, stored hashed, constant-time compared; secrets only in `localStorage` + URL fragment, never in path/query/logs; rotate/revoke in v1 (§20).
6. **Trust validators are hard server-side checks**: unfetched citations rejected; web text treated as untrusted data; narrative numeric-grounding rejects any figure absent from `computed_json` (§16/§17).
7. **Feedback never leaks a resolvable projection link** — `support_id` only, no financial fields (§22).
8. **AI opt-out works end-to-end**: compute, save, and `.xlsx` export with zero AI calls (§21).
9. **The golden + LibreOffice reconciliation gate is CI-blocking** and exists before UI depth (§13/§18).

These are the rules a reviewer checks every PR against; they are restated as gates in [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md) and as hard rules in [CLAUDE.md](./CLAUDE.md).

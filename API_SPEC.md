# API_SPEC.md — Thrift Store Projection HTTP API

**Repo:** `rallytasks/projections` · **Status:** build-ready spec (not yet built) · **Source of truth:** [PRD.md](./reference/PRD.md) §13–§27, Appendices B & D · **Siblings:** [ARCHITECTURE.md](./ARCHITECTURE.md) · [DATA_MODEL.md](./DATA_MODEL.md) · [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) · [SECURITY.md](./SECURITY.md) · [OPS_RUNBOOK.md](./OPS_RUNBOOK.md) · [BUILD_PLAN.md](./BUILD_PLAN.md) · [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md)

This document is the contract for the FastAPI HTTP surface. It is authoritative over PRD §25 ("API endpoints (indicative)"), which is intentionally terse; where this doc and PRD §25 disagree on shape, **this doc wins** and the PRD is the requirement it satisfies. Engine math, the view-model field set, and the Excel cell contract live in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md); the persisted schema lives in [DATA_MODEL.md](./DATA_MODEL.md). This doc covers **only** the wire contract: methods, paths, auth, request bodies, responses, errors, capabilities, rate limits, and headers.

---

## 0. Conventions

- **Base path:** all endpoints are under `/api`. Health is `/api/health`.
- **Transport:** HTTPS only (HSTS, §20). JSON request/response unless a binary export.
- **Encoding:** request and response bodies are `application/json; charset=utf-8` unless noted (`.xlsx`, `.docx`, `.pdf`).
- **Time:** all timestamps are RFC 3339 UTC strings (`2026-06-24T17:03:21Z`).
- **Money / percent in the API:** the engine is the **single math authority** (PRD §13). The compute response carries each figure as a **dual value** `{ "raw": <number>, "display": "<string>" }` so the client never re-derives rounding (whole dollars / 0.1 pp per §12.4). `raw` for money is **whole dollars** (the engine computes in cents/Decimal internally and rounds once at the API boundary). The frontend MUST render `display` and MUST NOT recompute. **No client-side math (PRD §13/Appendix C #22).**
- **IDs:** application-generated ULID/UUID strings (no SQLite `rowid` leakage; Postgres-portable per [DATA_MODEL.md](./DATA_MODEL.md)). Projections are addressed in the URL by **`view_slug`** (the read lookup key), never by internal `id`.
- **`null` vs absent:** an N/A metric is an explicit `null` plus an entry in the `flags` map (§12.4). It is never `0`, `NaN`, `#DIV/0!`, or an omitted key.
- **Determinism:** a `GET` of a projection never recomputes on a newer engine. It returns the stored `computed_json` verbatim with an `upgrade_available` flag (§13). Recompute happens only on a mutation (`PATCH`) or an explicit `POST …/upgrade-model`.

---

## 1. Authentication & capability model

No login, no cookies, no sessions. Access is by **capability token** (PRD §20). Because there is no cookie, mutations are **CSRF-free**; do not introduce a cookie (hard rule — see [SECURITY.md](./SECURITY.md)).

### 1.1 The three capabilities

| Capability | Carried as | Grants | Generated / stored |
|---|---|---|---|
| **owner token** | `Authorization: Bearer <owner_token>` | Full control of one projection **and** the owner-scoped list (`GET /api/projections`); rotate/revoke; trash/delete; revisions/restore. | ≥256-bit, `secrets.token_urlsafe(32)`. Stored **hashed** (`owner_token_hash`, SHA-256). Lives in browser `localStorage`. |
| **edit token** | `Authorization: Bearer <edit_token>` | Read + mutate **one** projection (PATCH, narrative save/regenerate, evidence attach, upgrade-model). **Cannot** list, rotate, or delete. | ≥128-bit. Stored **hashed** (`edit_token_hash`). Delivered to the browser only via **URL fragment**; scrubbed from the URL after read; never sent in a path/query; never logged. |
| **view_slug** (read-only) | path segment `/api/projections/{view_slug}` with **no** `Authorization` header | Read one projection + download `.xlsx`/packet (read-only). No mutation. Role flag (`board`/`funder`/`advisor`) tailors emphasis/CTAs in the read response (§6.2). | ≥128-bit, `secrets.token_urlsafe(16)`. Stored **plaintext** (it is the lookup key). |

**Resolution order** for a request to `/api/projections/{view_slug}`:
1. If `Authorization: Bearer` present → constant-time (`hmac.compare_digest`) compare the SHA-256 of the presented token against `owner_token_hash`, then `edit_token_hash`, of the projection identified by `{view_slug}`. First match wins and sets the request's capability (`owner` or `edit`).
2. If no `Authorization` header → the request is **read-only** (`view` capability), valid only for `GET`/export routes.
3. No match → **403** (never reveal whether the token would match a *different* projection).

A token is always scoped to **one** projection except the owner token, which additionally authorizes that owner's list. There is **no global list** and no cross-owner read/write (PRD §20). Every list query is filtered by `owner_token_hash` server-side.

### 1.2 Auth error responses

| Condition | Status | Body `error` |
|---|---|---|
| Mutation route with no `Authorization` header | `401` | `auth_required` |
| `Authorization` present but token matches neither owner nor edit hash for this projection | `403` | `forbidden` |
| Read-only (`view`) capability attempts a mutation | `403` | `read_only` |
| Edit token attempts an owner-only route (list, rotate, delete, trash, revisions list/restore) | `403` | `owner_required` |
| Secret detected in URL path or query string | `400` | `secret_in_url` (defense-in-depth; secrets only via header/fragment) |

Bodies: `{ "error": "<code>", "message": "<human readable>", "support_hint": "<optional>" }`. Never echo the token. Never log `Authorization` headers or URL fragments (§20).

### 1.3 Optimistic concurrency (`If-Match`)

Every **mutating** request (`PATCH`, and the `POST` routes that change projection state) **MUST** carry `If-Match: <version>`, where `<version>` is the integer `version` the client last received. The server runs the conditional update:

```sql
UPDATE projections SET version = version + 1, ... WHERE id = ? AND version = ?
```

- 1 row affected → success; new `version` returned in the body **and** as the `ETag` response header (`ETag: "5"`).
- 0 rows affected → **409 Conflict** (§1.4, Appendix B shape). The client offers Reload / Overwrite / Save-as-copy (§19.4).
- Missing `If-Match` on a mutation → **428 Precondition Required**, body `{ "error": "if_match_required" }`.
- Malformed `If-Match` (non-integer) → **400**, body `{ "error": "if_match_malformed" }`.

Writes are serialized server-side (single writer, WAL, `busy_timeout`); see [OPS_RUNBOOK.md](./OPS_RUNBOOK.md). Each settled mutation writes one **revision snapshot** (PRD §19.3/§24).

### 1.4 The 409 conflict shape (Appendix B / §19.4) — normative

On any stale mutation the server returns **HTTP 409** with the **current server state** in the body so the client can present a meaningful diff and recovery options without a second round-trip:

```json
{
  "error": "version_conflict",
  "message": "This projection changed since you loaded it.",
  "current_version": 7,
  "your_version": 5,
  "current_state": { "...full compute view-model (§3) at current_version..." },
  "recovery": ["reload", "overwrite", "save_as_copy"]
}
```

- `current_version` is the authoritative server version; `your_version` echoes the rejected `If-Match`.
- `current_state` is the **complete view-model** (identical shape to the §3 `200` body) so the UI can render the latest without a follow-up `GET`.
- **Overwrite** path: the client re-issues the same `PATCH` with `If-Match: <current_version>` (it has it from this body). The server does **not** auto-merge.
- **Save-as-copy** path: the client calls `POST …/duplicate` (§4.4), which mints a fresh owner token and forks the projection at its own version 1.

---

## 2. Global headers, CORS, and rate limits

### 2.1 Response headers (on every response)

| Header | Value | Why |
|---|---|---|
| `X-Robots-Tag` | `noindex, nofollow` | Projections must never be indexed (§20). Also `Disallow: /` in `/robots.txt`. |
| `Content-Security-Policy` | `default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' api.anthropic.com api.openai.com` | **Enforcing from day one** (greenfield SPA, no inline-script debt — contrast timpager M7). The browser talks only to our origin + the two AI providers; Places/Census/GitHub/CRM are server-side only and absent from `connect-src`. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | HSTS (§20). |
| `X-Content-Type-Options` | `nosniff` | |
| `Referrer-Policy` | `no-referrer` | Prevents leaking `view_slug` / fragment to third parties. |
| `Cache-Control` | `no-store` on all `/api/*` JSON; `private, max-age=0, must-revalidate` on exports | Projections are sensitive; never cache. |
| `ETag` | current `version` (mutations + projection `GET`) | Powers `If-Match` concurrency. |

Export endpoints additionally send `Content-Disposition: attachment; filename="..."` and a non-executable content type (file-download hardening, [SECURITY.md](./SECURITY.md)).

### 2.2 CORS

CORS is **locked to the app origin** (PRD §20). Allowed origin is the deployed SPA origin (e.g. `https://projections.thriftly.com`) plus the local dev origin in non-prod. Allowed methods: `GET, POST, PATCH, DELETE, OPTIONS`. Allowed headers: `Authorization, Content-Type, If-Match`. Exposed headers: `ETag`. `Access-Control-Allow-Credentials` is **false** (no cookies). Preflight (`OPTIONS`) is answered for the allowlisted origin only; any other `Origin` gets no CORS headers (browser blocks). This is not auth — bearer tokens are the auth boundary — but it limits drive-by cross-origin use.

### 2.3 Rate limits

Limits apply **per IP and per token** (PRD §20/§27), 429 on breach with `Retry-After`. Tokens are free to mint (no accounts), so the expensive/abuse-prone endpoints are the brakes against cost-amplification and spam. Numbers below are the **starting template** (tune against real traffic; mirror timpager's pattern of explicit numeric limits):

| Endpoint | Limit (per IP) | Limit (per token) | Rationale |
|---|---|---|---|
| `POST /api/research` | 10 / hour | 20 / hour | LLM + Places + Census cost; cached by location+size key (§16.6). |
| `POST …/narrative:regenerate` | 10 / hour | 6 / hour / projection | Regeneration cap (§27 cost control). |
| `POST /api/feedback` | 5 / hour | — | GitHub-issue spam. |
| `POST /api/intent` | 5 / hour | — | CRM spam. |
| `POST /api/projections` (create) | 20 / hour | — | Projection-creation flood. |
| `POST …/evidence` (file upload) | 30 / hour | 60 / hour / projection | Upload abuse. |
| `POST …/penny`, `POST /api/penny/draft` | 600 / hour (coarse) | **120 / hour / token, 240 / hour / projection** | Bounded provider tool-use loop — **keyed on token/projection, not the shared proxy IP** (§6.6, issue #189). |
| `POST /api/penny/proposal` | 120 / hour (coarse) | 60 / hour / token | Upload intake (token-hashed key). |
| `PATCH …` (autosave) | 600 / 5 min | 600 / 5 min / projection | High by design (debounced autosave); serialized server-side. Client debounces ~300–400 ms. |
| `GET …/xlsx`, `GET …/packet` | 60 / hour | — | Export cost (LibreOffice/render). |
| All other `GET` | 600 / 5 min | — | General read. |

`429` body: `{ "error": "rate_limited", "retry_after_seconds": <int>, "scope": "ip" | "token" }`.

The Penny endpoints **key the rate limit primarily on the caller's capability token (SHA-256-hashed) and the `projection_id`, not the client IP** — behind Railway's single shared proxy IP a per-IP cap is one global bucket that lets one owner lock out all others (issue #189). The per-IP cap is a coarse safety bound only. See SECURITY.md §10.1.

---

## 3. The compute view-model (shared response body)

Every read or mutation of a projection returns the **same** view-model — the engine's native output (PRD Appendix D), consumed identically by the React frontend and the `.xlsx`/packet builders so there is one math/format surface. Field semantics are defined in [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md); this is the **wire shape**:

```json
{
  "view_slug": "p_8x…",
  "name": "House of Hope — Longview, TX",
  "status": "active",
  "version": 7,
  "model_version": "2.0.0",
  "compute_schema_version": "1.0.0",
  "upgrade_available": false,
  "role": "owner",

  "reco":    { "tag": "proceed", "headline": "...", "sub": "...", "icon": "..." },
  "metrics": {
    "capital":   { "raw": 277990, "display": "$277,990" },
    "cashGap":   { "raw": -41200, "display": "($41,200)" },
    "breakeven": { "raw": 5, "display": "Month 5" },
    "reasons":   { "reasonCapital": "...", "reasonGap": "...", "reasonBreakeven": "..." }
  },
  "milestones": {
    "grandOpening": { "raw": 1, "display": "Month 1" },
    "breakEven":    { "raw": 5, "display": "Month 5" },
    "payback":      { "raw": null, "display": "N/A", "reason": "N/A — startup costs are not recovered within the projection horizon" }
  },
  "kpis": [
    { "label": "Sales / sq ft", "value": {"raw":61,"display":"$61"}, "sub":"...", "color":"neutral" },
    { "label": "Payback period", "value": {"raw":null,"display":"N/A"}, "sub":"to recover startup", "color":"text" }
  ],

  "monthly": [
    { "month": 1, "revenue":{"raw":0,"display":"$0"}, "expenses":{"raw":0,"display":"$0"},
      "scheduledCosts":{"raw":20000,"display":"$20,000"}, "net":{"raw":-20000,"display":"($20,000)"},
      "cumulativeCash":{"raw":-20000,"display":"($20,000)"} }
  ],
  "breakevenMonth": 5,

  "rows": [
    { "label":"Donor market share", "group":"drivers",
      "y1":{"raw":0.06,"display":"6.0%"}, "y2":{...}, "y3":{...},
      "class":"input", "editable":true, "node":"market_share" }
  ],

  "overrides": [
    { "node":"Payroll", "year":2, "calculated":{"raw":233000,"display":"$233,000"},
      "value":{"raw":250000,"display":"$250,000"}, "note":"signed 2 hires",
      "pinnedDate":"2026-06-20T14:00:00Z", "affected":["Payroll taxes","Total Expenses","Net profit"] }
  ],

  "evidence": [
    { "field":"rent", "label":"Market rent", "value":{"raw":9.0,"display":"$9.00 / sq ft"},
      "method":"retrieval", "badge":"estimated_low", "change":"A broker quote would verify this.",
      "meta":"LoopNet, 2026-05 · low confidence" }
  ],

  "settings": {
    "laborPct":0.40, "marketingPct":0.0375, "suppliesPct":0.05, "cardPct":0.02,
    "payrollTaxPct":0.075, "salvagePct":0.008, "escalator":0.03, "basket":17.08,
    "donationsPerHh":3, "shareY1":0.06, "shareY2":0.08, "shareY3":0.10,
    "occupancyAnnual":90000, "leaseType":"nnn", "salesfloorSqft":7000, "reserveBuffer":25000
  },

  "flags": { "payback": "na_no_year1_profit" },
  "trade_area": { "basis":"city", "households":31798, "acs_vintage":2023, "geography":"Longview city, TX" },
  "saveLabel": "All changes saved",
  "updated_at": "2026-06-24T17:03:21Z"
}
```

Notes:
- **`milestones`** (`compute_schema_version ≥ 1.2.0`) is the three detail-page milestones — `grandOpening`, `breakEven`, `payback` — each `{raw, display}` (the server formats "Month 6"; the client renders it verbatim, no client math). An unreached milestone is `{raw:null, display:"N/A", reason}` (N/A-with-reason, **never 0**); `payback` adds a `duration` ("25 months") when reached. The **Payback period** KPI is sourced from `milestones.payback`; the old `simple_payback_years` KPI is gone from the wire surface (ENGINE_CONTRACT §6.6).
- **`monthly`** is an array over **project months `1..N`** (`N = opening_month_number + 11`); each entry is `{month, revenue, expenses, scheduledCosts, net, cumulativeCash}` with `net = revenue − expenses − scheduledCosts` (same columns as the `.xlsx` Monthly tab). `breakevenMonth` is a sibling top-level field.
- **`reco.tag`** is a **semantic enum**, not a hex color: `proceed | revise | find_cheaper_rent | raise_cash | delay | do_not_proceed` (§12.3). The client maps enum → design token (brand vs semantic separation). The API never emits hex.
- **`row.class`** ∈ `input | computed | overridden | estimated`; `row.node` is the DAG node key used by overrides. Derived rows and KPIs have `editable:false` and are **non-pinnable** (server rejects pin attempts — §6.1).
- **Override keys** are `"{node}#{year}"` in storage (`overrides_json`, [DATA_MODEL.md](./DATA_MODEL.md)); the `overrides[]` array splits them into `node`+`year` for the inspector.
- **`model_version`** + **`compute_schema_version`** are tracked separately: the former changes when the math changes; the latter when the view-model shape changes. `upgrade_available` is true when the stored `model_version` is older than the deployed engine — but the body is still the **stored snapshot** (no silent recompute, §13).
- For a **read-only** request `role` reflects the share-link role (`board`/`funder`/`advisor`); `settings` editability and CTAs are tailored, and write-only fields may be elided.

---

## 4. Projection lifecycle endpoints

### 4.1 `GET /api/projections` — list (owner-scoped)

- **Auth:** owner token (Bearer). **Capability:** owner only. There is **no** view/edit access to the list and **no global index** (PRD §19.1/§20).
- **Request:** no body. Query: `?status=active|trashed` (default `active`).
- **Response `200`:** a lightweight list (not the full view-model per row):

```json
{ "projections": [
  { "view_slug":"p_8x…", "name":"House of Hope — Longview, TX",
    "location":"Longview, TX", "basis":"city",
    "y1_revenue":{"raw":426911,"display":"$426,911"},
    "y1_net":{"raw":47100,"display":"$47,100"},
    "capital_required":{"raw":277990,"display":"$277,990"},
    "reco_tag":"proceed", "status":"active", "version":7,
    "updated_at":"2026-06-24T17:03:21Z" }
] }
```

- **Errors:** `401` no bearer; `403` if the bearer is an edit token (edit tokens cannot list — `owner_required`).

### 4.2 `POST /api/projections` — create

- **Auth:** none required to create (anonymous create; the response returns the freshly minted owner token). **No `If-Match`** (creation).
- **Request body:** the wizard payload (PRD Appendix B):

```json
{
  "name": "House of Hope — Longview, TX",
  "location": { "query":"Longview, Texas", "place_id":"…" },
  "trade_area": { "basis":"city", "households":31798, "acs_vintage":2023 },
  "inputs": {
    "opening":"2027-03", "opening_status":"pre_launch",
    "building_sqft":10000, "salesfloor_pct":0.70, "lease_type":"nnn",
    "donation_value":74, "rent_per_sqft":12,
    "demand": { "mode":"market_share", "share_y1":0.06, "share_y2":0.08, "share_y3":0.10 },
    "source_of_funds": { "cash":150000, "grant":50000 }
  },
  "demand_drivers": { "competition":"low", "pickup_service":true },
  "assumptions": { "labor_pct":0.40, "utilities_per_sqft":"2.23" },
  "terms_accepted": true
}
```

- **Occupancy driver (#245):** the wizard ships **`inputs.rent_per_sqft`** (and leaves `occupancy_annual` null) so the engine resolves occupancy = `building_sqft × rent_per_sqft`; a flat `inputs.occupancy_annual` is still accepted for back-compat and **takes precedence when present**. `assumptions.utilities_per_sqft` (default `"2.23"`) scales the Utilities/trash line (`building_sqft × utilities_per_sqft`); the Equipment & Fixtures / Build-out cost-schedule rows are seeded from `FIXTURES_PER_SQFT`/`BUILDOUT_PER_SQFT × building_sqft` (anchored so 10,000 sq ft reproduces today's literals).
- **Validation:** `share_y1/y2/y3` are **three explicit values** — no auto-midpoint (PRD §7.1; supersedes `methodology.md` line 17). `salesfloor_pct ∈ (0,1]`; `building_sqft > 0` (0 sq ft blocked, §12.4); `terms_accepted` must be `true` before any export/share is later allowed (§21) — create may proceed without it, but exports are gated (see §6/§7).
- **Behavior:** computes server-side (the only math authority), persists `inputs/assumptions/trade_area/computed_json/monthly_json/flags`, stamps `model_version`, sets `version=1`, mints owner + edit + view tokens. When `terms_accepted: true` is sent, the server **stamps `terms_accepted_at` = now** so the later `.xlsx`/packet exports (§6/§7) are reachable; when it is absent/`false`, `terms_accepted_at` stays unset and exports `403 terms_required`. `terms_accepted` defaults to `false` — an unchecked box must never silently accept.
- **Response `201`:** the full view-model (§3) **plus** the one-time secrets, returned **only here** (never stored in retrievable plaintext on the server beyond `view_slug`):

```json
{
  "...view-model (§3)...",
  "tokens": {
    "owner_token": "…(store in localStorage)…",
    "edit_token":  "…(deliver via URL fragment)…",
    "recovery_code": "…(show once; staff cannot recover it)…"
  }
}
```

The frontend MUST surface the **one-time recovery code** forcefully (key loss = data loss; staff cannot recover access — only resolve support IDs, [SECURITY.md](./SECURITY.md)).
- **Errors:** `400` validation (`{ "error":"validation", "fields":{...} }`); `429` create rate limit.

### 4.3 `GET /api/projections/{view_slug}` — fetch one

- **Auth:** owner/edit (Bearer) → full editable view-model with `role` set accordingly; **or** no header → read-only view (role from the share link). **Capability:** owner/edit/view.
- **Behavior:** returns the **stored** `computed_json` verbatim (no recompute on a newer engine; `upgrade_available` reflects drift, §13).
- **Response `200`:** the view-model (§3). `ETag: "<version>"`.
- **Errors:** `404` unknown slug or trashed-and-not-owner; `403` if a presented bearer matches no token for this projection.

### 4.4 `PATCH /api/projections/{view_slug}` — update + recompute

The core editing endpoint. Drives autosave (debounced) and every Settings/driver edit.

- **Auth:** owner or edit (Bearer). **Capability:** owner/edit. **Requires `If-Match: <version>`.**
- **Request body:** a partial of the editable surface — any subset of `inputs`, `assumptions` (the `settings` sliders), `trade_area`, `demand_drivers`, `name`, and **`overrides`** (pin/unpin operations):

```json
{
  "assumptions": { "labor_pct": 0.45 },
  "inputs": { "demand": { "share_y2": 0.09 } },
  "overrides": {
    "set":   [ { "node":"Payroll", "year":2, "value":250000, "note":"signed 2 hires" } ],
    "clear": [ { "node":"Payroll", "year":3 } ]
  }
}
```

- **Override rules (server-enforced, not just UI — PRD §14):**
  - Pinnable nodes are **inputs and expense component lines only**. A pin on a derived/total/margin/KPI node → **422** `{ "error":"node_not_pinnable", "node":"Net profit" }`.
  - Recompute is a **topological DAG evaluation**: `resolve(node) = pin.value if pinned else f(resolve(parents))`. **No back-solve** — pinning a downstream node never mutates upstream inputs; upstream rows that no longer drive any pinned downstream node get a **stale flag** surfaced in `flags`/`overrides[].affected`.
  - Setting an override whose value equals the calculated value within tolerance ($0.50) **deletes** the pin (auto-clear-on-equal, matching the design's commit semantics).
- **Behavior:** recompute server-side (<50 ms p95 target, §27), persist new `computed_json/monthly_json/overrides_json/flags`, increment `version`, write one revision snapshot (`actor_token_hash`, `change_summary`).
- **Response `200`:** the recomputed view-model (§3). `ETag: "<new version>"`. `saveLabel:"All changes saved"`.
- **Errors:** `428` missing `If-Match`; `409` stale (§1.4 shape); `422` invalid override / out-of-domain input; `403` read-only; `400` malformed.

### 4.4a `POST /api/projections/{view_slug}/preview` — dry-run (read-only)

A **read-only what-if**: merge the same editable-surface partial as `PATCH` (§4.4), recompute via the engine, and return the before/after delta **without touching stored state**. Powers the Settings/driver "preview before you commit" surface.

- **Auth:** owner or edit (Bearer). **Capability:** owner/edit. **No `If-Match`** (it never mutates).
- **Read-only invariants (CI-blocking, epic-N N12):** it **MUST NOT** persist, **MUST NOT** bump `version`, and **MUST NOT** write a revision. A view-only request (no/invalid bearer) is `403`.
- **Request body:** identical to the `PATCH` partial (any subset of `inputs`/`assumptions`/`trade_area`/`demand`/`name`/`overrides`).
- **Behavior:** `before` is the stored snapshot's decision metrics; `after` recomputes the merged partial in memory. Same `422` rejections as `PATCH` (`invalid_inputs`, `node_not_pinnable`). Rate-limited on the **read bucket**.
- **Response `200`:**

```json
{
  "before": { "capital": {"raw":277990,"display":"$277,990"}, "cashGap": {...}, "breakeven": {...} },
  "after":  { "capital": {"raw":233000,"display":"$233,000"}, "cashGap": {...}, "breakeven": {...} },
  "changed": [ { "label":"Capital required", "was":"$277,990", "now":"$233,000", "sign":"down" } ],
  "reco_before": { "tag":"proceed", "headline":"...", "sub":"..." },
  "reco_after":  { "tag":"proceed", "headline":"...", "sub":"..." }
}
```

`changed[].sign` ∈ `up | down | flat` (direction of the raw value). No `ETag` (no version change).
- **Errors:** `403` read-only; `404` unknown slug; `422` `invalid_inputs` / `node_not_pinnable`; `429` read-bucket rate limit.

### 4.5 `POST /api/projections/{view_slug}/duplicate`

- **Auth:** owner or edit (Bearer) on the source. **Capability:** owner/edit. **No `If-Match`** (creates a new resource).
- **Behavior:** deep-copies inputs/assumptions/overrides/trade_area into a **new** projection, recomputes at the current engine, mints **fresh** owner/edit/view tokens and a recovery code, sets the copy's `version=1`. Powers "Save as copy" from the 409 flow (§1.4) and the list "Duplicate" action.
- **Request body (optional):** `{ "name": "House of Hope (copy)" }`.
- **Response `201`:** the new projection's view-model + `tokens` block (same shape as §4.2).
- **Errors:** `403`; `429` create limit.

### 4.6 `POST /api/projections/{view_slug}/upgrade-model`

- **Auth:** owner or edit (Bearer). **Capability:** owner/edit. **Requires `If-Match: <version>`.**
- **Behavior:** recompute the projection under the **current** engine `model_version`, writing a **new revision** (the prior `computed_json`+`model_version` are preserved in `revisions`, never destroyed — §13). Only call when `upgrade_available` is true; calling when already current is a no-op `200` with unchanged version.
- **Response `200`:** the upgraded view-model with the new `model_version` and incremented `version`.
- **Errors:** `428`/`409` (concurrency); `403`.

### 4.7 `POST /api/projections/{view_slug}/rotate-tokens`

- **Auth:** **owner token only** (Bearer). **Capability:** owner. **Requires `If-Match: <version>`** (rotation is a state change).
- **Behavior:** in **one transaction**, regenerate and re-hash the **owner, edit, view, and all role-link tokens**, immediately invalidating every previously shared link (PRD §20 — compromise response). Writes an access/rotation event to the revision/audit log (`actor_token_hash`, `change_summary:"tokens_rotated"`). Returns the **new** secrets once.
- **Request body (optional):** `{ "scope": ["edit","view","role"] }` to rotate a subset; default rotates all. The owner token is always rotated unless `scope` explicitly omits it.
- **Response `200`:**

```json
{ "view_slug":"p_NEW…", "version":8,
  "tokens": { "owner_token":"…", "edit_token":"…", "view_slug":"p_NEW…", "recovery_code":"…" } }
```

Rotating the `view_slug` changes the read URL; the response carries the new slug. The client must update `localStorage` and any shared links it controls.
- **Errors:** `403` (edit/view cannot rotate — `owner_required`); `428`/`409`.

### 4.8 Trash lifecycle (soft delete)

Projections are soft-deleted (`status:"trashed"`, `deleted_at` set) and restorable; hard delete is a separate, irreversible step (PRD §19.1).

| Route | Method | Auth | If-Match | Effect |
|---|---|---|---|---|
| `…/{view_slug}/trash` | `POST` | owner | required | `status → trashed`, set `deleted_at`. Hidden from the default list; excluded from non-owner `GET` (returns `404`). |
| `…/{view_slug}/restore` | `POST` | owner | required | `status → active`, clear `deleted_at`. |
| `…/{view_slug}` | `DELETE` | owner | required | **Hard delete** — purge the projection and its revisions/evidence/narratives. Irreversible. Only permitted when already `trashed` (else `409 not_trashed`). |

- **Capability:** owner only for all three (`owner_required` for edit/view).
- **Response:** `trash`/`restore` → `200` with the updated view-model (`status` reflected). `DELETE` → `204 No Content`.
- **Errors:** `428`/`409`; `403`; `DELETE` on an active projection → `409 { "error":"not_trashed" }`.

---

## 5. Revisions & restore

Each settled mutation writes a snapshot (`monthly_json`+`computed_json`+`overrides_json`, `actor_token_hash`, `change_summary`, `created_at` — PRD §24). The revision log is also the **audit/access log** (mutations, rotations, exports, share-link access — §20).

### 5.1 `GET /api/projections/{view_slug}/revisions`

- **Auth:** owner token. **Capability:** owner. (Edit tokens cannot browse history — `owner_required`.)
- **Response `200`:**

```json
{ "revisions": [
  { "id":"r_01J…", "version":7, "change_summary":"labor_pct 0.40→0.45",
    "actor":"user", "created_at":"2026-06-24T17:03:21Z",
    "event":"edit" }
] }
```

`actor` ∈ `user | penny | penny_undo | user_undo` (the stored revision `actor` enum, DATA_MODEL §4 — a Penny edit reads back `"penny"`, a manual edit `"user"`). `event` ∈ `edit | override | rotate | restore | upgrade_model | export | share_access`. Bodies of snapshots are not inlined in the list (fetch via restore preview if needed); the list is metadata + `change_summary`.
- **Errors:** `403` (edit/view); `404`.

### 5.2 `POST /api/projections/{view_slug}/revisions/{id}/restore`

- **Auth:** owner token. **Capability:** owner. **Requires `If-Match: <version>`** (it mutates current state).
- **Behavior:** restore the named snapshot's inputs/assumptions/overrides **as a new forward revision** (it does not rewrite history; it appends). Recomputes under the snapshot's `model_version` (preserving the locked result — restoring does not silently upgrade math).
- **Response `200`:** the restored view-model with an incremented `version`.
- **Errors:** `404` unknown revision; `428`/`409`; `403`.

---

## 6. Engine-backed sub-resources

### 6.1 Narrative (grounded prose)

The Board Packet is the primary trust surface; **narrative prose is generated from `computed_json`'s structured facts** with post-generation numeric grounding (PRD §17). Every figure in the prose must exist in `computed_json`/approved facts or the generation is **rejected server-side** — this is a hard validator, not a prompt nicety ([SECURITY.md](./SECURITY.md)).

| Route | Method | Auth | If-Match | Purpose |
|---|---|---|---|---|
| `…/{view_slug}/narrative` | `GET` | owner/edit/view | — | Fetch the stored narrative + staleness. |
| `…/{view_slug}/narrative` | `PUT` | owner/edit | required | Save user-edited prose (`body_md`). |
| `…/{view_slug}/narrative:regenerate` | `POST` | owner/edit | required | Regenerate from current `computed_json`. |

- **`GET` response `200`:**

```json
{ "body_md":"…sanitized markdown…", "edited":true, "edit_origin":"human",
  "computed_hash":"sha256:…", "stale":true,
  "stale_diff":[ {"field":"capital","was":"$262,400","now":"$277,990"} ],
  "grounded_figures":[ {"raw":277990,"display":"$277,990","variants":["$277,990","$278k"]},
                       {"raw":-41200,"display":"($41,200)","variants":["($41,200)","-$41,200"]} ],
  "ai_disabled":false, "updated_at":"2026-06-24T16:00:00Z" }
```
`stale` is true when the stored `computed_hash` ≠ the current `computed_json` hash; the client shows "Out of date" + Regenerate and **never auto-overwrites** user-edited prose (§17). `edit_origin` ∈ `ai | human | null` records how the stored prose was last produced. **`grounded_figures`** is the **server-built** canonical figure list with display variants ($277,990 / $278k / ($41,200)) derived from `computed_json` — the client never re-derives figures with a regex; the grounding validator checks against the same variant set (epic-N N3).

- **`PUT` request:** `{ "body_md":"…markdown…" }`. The server **sanitizes** `body_md` with an allowlist (`p`/headings/`ul`-`ol`-`li`/`strong`/`em`/`blockquote`/`code`/`a[http|https|mailto]`) before storage — no raw HTML, no inline event handlers (stored-XSS → token-theft defense, [SECURITY.md](./SECURITY.md)) — and applies **numeric grounding fail-closed**: an ungrounded figure in a hand-edit is **rejected** (`409 grounding_failed`) and the prior narrative is left untouched (epic-N N4). Sets `edit_origin:"human"`. Response `200`: `{ "body_md":"…sanitized…", "edited":true, "edit_origin":"human", "computed_hash":"…" }`.

- **`:regenerate` behavior:** low-temperature generation, **Anthropic primary → OpenAI fallback**; the result passes the numeric-grounding validator before it is stored. The `provider` field reflects the **actual** provider used. The prose states rent as an **estimate/range**, never a fact. Query `?confirm=true` is required to regenerate over a hand-edited narrative (confirm-before-discard, N6).
  - Response `200`: `{ "body_md":"…", "edited":false, "edit_origin":"ai", "computed_hash":"…", "provider":"anthropic" }`.
  - **`409 grounding_failed`** (validator rejection): `{ "error":"grounding_failed", "ungrounded_figures":["$310,000"] }` — the prior narrative is **not** overwritten.
  - **`409 edited_confirm_required`** when regenerating over `edit_origin:"human"` without `?confirm=true` — user prose is never silently discarded.
  - **`503 ai_unavailable`** when both providers fail (compute and `.xlsx` still work — §21). Body `{ "error":"ai_unavailable" }`.
- **AI opt-out (§21):** if the projection (or deployment) has AI disabled, `:regenerate` returns `409 { "error":"ai_disabled" }` and `GET` returns `ai_disabled:true`. Compute, save, and `.xlsx` export remain fully functional with **zero AI calls** — verified by a test running the full flow with all AI keys unset (DoD, [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md)).
- **Errors:** `403` read-only attempts to `PUT`/regenerate; `428`/`409`; `429` regeneration cap (§2.3).

### 6.2 `POST /api/projections/{view_slug}/evidence` — attach evidence

- **Auth:** owner or edit (Bearer). **Capability:** owner/edit. **Requires `If-Match: <version>`** (attaching evidence can promote an estimate → "verified (user-provided)" and raises confidence — §15, which changes `computed_json`'s evidence/flags).
- **Request:** `multipart/form-data`: `field` (e.g. `rent`/`households`/`payroll`), `kind` (`user_attached`), `value`, `confidence`, `method`, optional `source_url/source_title/source_date`, and an optional `file`.
- **File-upload hardening ([SECURITY.md](./SECURITY.md)):** allowlist content types (PDF/PNG/JPG/CSV/XLSX); reject SVG-with-script and executables; cap size; store off-origin or serve with `Content-Disposition: attachment` and a non-executable content type. `file_ref` is stored, not the raw blob inline.
- **Response `200`:** the recomputed view-model (§3) with the new `evidence[]` entry and any confidence/flag changes. New `version`.
- **Errors:** `415` disallowed type; `413` too large; `428`/`409`; `403`; `429` upload limit.

### 6.3 `GET /api/projections/{view_slug}/xlsx` — formula-driven workbook

- **Auth:** owner/edit/view. **Capability:** owner/edit/view (read-only users may download — they see nothing beyond the page; whether export is gated is a **business-model toggle**, §3/§20, not an access bug). **Terms acceptance required before export** (§21): if `terms_accepted` is not set, `403 { "error":"terms_required" }`.
- **Behavior:** the engine renders the workbook from the **same resolved node values** as `computed_json` (one math surface). Cell contract (PRD §18, [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md)): inputs = blue hard-coded; computed = live formula; overridden components = orange hard-coded + comment `"Manual override — calc was =<formula> → $X; set to $Y on <date>"`; totals/net/margin/KPIs = **always formulas** over components (foots even with overrides); monthly cash flow on its own tab with the Year-1 P&L tab referencing the monthly roll-up; N/A cells = blank + comment, **never `#DIV/0!`** (`IF(denom=0,"",num/denom)` guards). The current `generate_projection.py` builder violates this (unguarded `=net/totrev`, `=startup/Y1net`, and `=AVERAGE` for Y2 share) and is rewritten in M1 — see [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md).
- **Release gate (CI-blocking, §18):** the exported workbook is recalculated with a pinned LibreOffice via `recalc.py`; every cell must equal saved `computed_json` (<$0.50 / 0.1 pp) with **zero** formula errors, **with and without** overrides. This is a build gate, not a request-time check.
- **Response `200`:** `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `Content-Disposition: attachment; filename="<name> 3-Year Projection.xlsx"`. Generated to a per-request temp dir (server-controlled path — never user-supplied) and streamed, then cleaned up (no path traversal via `org_name`).
- **Errors:** `403 terms_required` / `read_only` (if gated by business model); `404`; `429`.

### 6.4 `GET /api/projections/{view_slug}/packet` — Board/Funder Packet

- **Auth:** owner/edit/view. **Capability:** owner/edit/view (role flag tailors emphasis/CTAs — board/funder/advisor, §6.2/§17). **Terms acceptance required** (`403 terms_required` otherwise).
- **Query:** `?format=pdf|docx` (default `pdf`); `?role=board|funder|advisor` (defaults to the share-link role, else `board`).
- **Behavior:** the packet **leads with evidence** (§15), then decision recommendation, assumptions (verified vs estimated), citations w/ dates+confidence, sensitivity table, risks, cash need + break-even, monthly cash-flow summary, 3-year P&L, KPIs. Prose is the grounded narrative (§6.1); if AI is disabled, the packet omits generated prose but still includes the structured/evidence sections.
- **Response `200`:** `application/pdf` or the `.docx` content type; `Content-Disposition: attachment`.
- **Errors:** `403 terms_required`; `404`; `429`.

### 6.5 `GET /api/projections/{view_slug}/penny/transcript` — Penny conversation (read seam)

- **Auth:** owner/edit Bearer. **Capability:** owner OR this projection's edit token (Spec B §7/§12). A view-only caller (no/invalid token) or a different owner's token → `403 forbidden`; unknown slug → `404`.
- **Behavior:** returns the persisted per-project Penny transcript verbatim (the server is the one shape authority; the client renders turns as-is). Wizard-draft conversations have no projection and are **never persisted** (Spec B §7), so there is nothing to read for them. No cross-owner leakage (the read keys on the slug-resolved `projection_id`).
- **Response `200`:**

```json
{ "view_slug":"…", "transcript_id":"pt_…", "created_at":"…", "updated_at":"…",
  "turns":[
    {"role":"user","content":"Set Year-1 share to 8%.","ts":"…"},
    {"role":"assistant","content":"Done — now 8%.","provider":"anthropic","ts":"…"}
  ] }
```

  An absent transcript returns `200` with `"transcript_id": null` and `"turns": []`. Turn shape + the retention cap are normative in [`DATA_MODEL.md`](./DATA_MODEL.md) §3.9/§4.9.
- **Errors:** `403 forbidden`; `404 not_found`.

### 6.6 `POST /api/projections/{view_slug}/penny` — run the tool-use loop (PE5)

- **Auth:** owner/edit Bearer. **Capability:** owner OR this projection's edit token may **mutate**; a view-only caller (no/invalid token) is **answer-only** (the loop still runs, but every `mutate` tool refuses and nothing is persisted to the owner's transcript). Unknown slug → `404`.
- **Body:** `{ "message": "…", "proposal_ref": "prop_…"? }`. There is **NO top-level `If-Match`** — the loop's internal `PATCH`es each carry the caller's known version (Spec B §12).
- **Behavior:** runs the bounded server-side tool-use loop (Spec B §6.1): system prompt + grounding context (current `computed_json` + editable surface) + user message → the provider replies with prose or tool calls → each tool runs server-side → repeat until a final message or a hard cap. The user message and any proposal text are wrapped as **untrusted DATA** (injection-marker stripped, extract-only framing — SECURITY §6.3). Every `mutate` tool converges on the **same** `apply_projection_patch` write path the manual UI hits, so each applied edit produces `version++` + **one** `actor:penny` revision as a side effect (no parallel writer, no privileged path). Detail-page turns persist to `penny_transcripts` (PE2); a view-only caller's answer-only turns persist **nothing**.
- **Response `200`:**

```json
{ "provider":"anthropic",
  "narration":"Done — I lowered the labor assumption; capital updated.",
  "applied_revisions":[
    {"tool":"set_assumption","version":2,"actor":"penny",
     "changed":[{"label":"Capital required","was":"$277,990","now":"$281,400"}]}
  ],
  "turns_appended":[
    {"role":"user","content":"cut labor to 0.55","ts":"…"},
    {"role":"tool","content":"Applied set_assumption → version 2.","tool_name":"set_assumption","revision_id":2,"ts":"…"},
    {"role":"assistant","content":"Done — …","provider":"anthropic","ts":"…"}
  ] }
```

  `applied_revisions[].changed` is the engine's recomputed view-model diff (`was→now`), so Penny narrates the effect without inventing a figure. `provider` reflects the **actual** provider used.
- **Errors:** `409 ai_disabled` (per-projection opt-out, deployment kill switch, or no provider key — **zero** provider calls); `503 ai_unavailable` (both providers down); `429 rate_limited` with `{ "retry_after_seconds": N }` + a `Retry-After` header (surfaced **before** any provider call — **keyed on the caller's hashed token and the `projection_id`, not the shared proxy IP**, so one owner cannot lock out others, §2.3/SECURITY §10.1, issue #189); `422` relays a rejected edit to the model (e.g. `node_not_pinnable`, `invalid_inputs`) and `input_too_large` when the assembled prompt exceeds the input-token cap; `404 not_found`.

### 6.7 `POST /api/penny/draft` — wizard-draft loop (PE5)

- **Auth:** edit Bearer (any bearer token present; there is no projection yet). Missing token → `403 forbidden`.
- **Body:** `{ "message":"…", "draft_state":{…}, "proposal_ref":"prop_…"? }`.
- **Behavior:** the **same** loop, but every `mutate` tool edits the supplied `draft_state` (the wizard's in-progress inputs/assumptions/overrides/cost-schedule) instead of routing through `apply_projection_patch`. **Persists nothing** — no transcript row, no revision, no projection (the ephemeral wizard transcript stays in client state, Spec B §7). The figure-strip guard still applies (no LLM-computed figure reaches the draft).
- **Response `200`:** `{ "draft":{…mutated…}, "narration":"…", "provider":"anthropic", "applied":[…] }`.
- **Errors:** `403 forbidden`; `409 ai_disabled`; `503 ai_unavailable`; `429 rate_limited`.

### 6.8 `POST /api/penny/proposal` — proposal upload intake (PE5)

- **Auth:** owner/edit Bearer (any bearer token present). Missing token → `403 forbidden`.
- **Body:** either a **raw PDF body** (`Content-Type: application/pdf`, optional `?filename=`) **or** JSON `{ "source_url":"…" }`.
- **Behavior:** accepts the consultant proposal **server-side as untrusted bytes** and returns an opaque `proposal_ref`. The bytes are **never executed or rendered**; they are extracted (text only) lazily by the `parse_proposal` tool inside the Penny loop (PE9, SECURITY §6.3.2), never here. Guards: **type** — a magic-byte sniff (`%PDF-`) is the authority (a forgeable `Content-Type`/filename is advisory only); **size** — capped (`413` over the limit); **SSRF** — a `source_url` is validated with the research fetcher's scheme allowlist + private/loopback/link-local/metadata IP rejection (a blocked host → `422 ssrf_blocked`, fail-closed; remote fetching itself is out of scope, so a clean URL returns `422 remote_intake_unavailable`).
- **Response `201`:** `{ "proposal_ref":"prop_…", "filename":"plan.pdf", "size":1234, "content_type":"application/pdf" }`.
- **Errors:** `403 forbidden`; `413 file_too_large`; `415 unsupported_type`; `422 ssrf_blocked` / `remote_intake_unavailable` / `empty_upload`; `429 rate_limited`.
- **`parse_proposal` result (PE9):** when the loop calls `parse_proposal` with this ref it returns extract-only candidates — `{ extract_only, untrusted, candidates:[{amount_text, amount, category, snippet, tier?}], tiers:[…], needs_tier_choice, phases:[{phase, description, duration_months, month}], phase_month_map:[{phase, month}], opening_month, needs_month_confirm }` — every figure traceable to the document; multiple tiers force disambiguation and the phase→month mapping is confirmed before any row is populated via `edit_cost_schedule` (`provenance.source="ai"`).

---

## 7. Research & external-data proxies

All third-party calls (Places, Census, web fetch, LLM extract) are **server-side**; the browser never holds those API keys (CSP `connect-src` excludes them). Research runs **outside the compute hot path** (§16/§17) — compute must work fully with research/AI disabled (§21).

### 7.1 `GET /api/places/autocomplete` — Places proxy

- **Auth:** none (used by the wizard before a projection exists). Rate-limited per IP.
- **Query:** `?q=<partial location>` (min 3 chars).
- **Behavior:** proxies Google Places Autocomplete server-side with `GOOGLE_PLACES_API_KEY`; returns only the fields the wizard needs (no raw provider payload, no key exposure).
- **Response `200`:**

```json
{ "predictions": [
  { "description":"Longview, TX, USA", "place_id":"ChIJ…", "types":["locality"] }
] }
```
- **Errors:** `400` `q` too short; `502 places_unavailable` (wizard falls back to manual households, §19.4); `429`.

### 7.2 `POST /api/research` — retrieval-grounded market rent (M3.3 slice, #245)

The **rent-research slice** (#60/#62/#64/#65): a representative `$/sq ft` for the resolved location, extracted-only from server-fetched snippets. **Households are not researched here** — they come from `POST /api/places/resolve` (§7.1 derivation), keeping this endpoint a single-purpose rent pre-fill off the compute hot path.

- **Auth:** none required (research happens during the wizard, before a projection exists); rate-limited **per IP + per token** (the token, when present, is SHA-256-hashed before it keys the limiter — no raw secret in memory/logs). **No `If-Match`** (read-only against external data; does not mutate a projection — the user accepts the result into the wizard, which then creates/`PATCH`es).
- **Request body:**

```json
{ "location": { "geography_name":"Longview city", "formatted_address":"Longview, TX, USA" },
  "location_label": "Longview, TX",
  "building_sqft": "10000",
  "basis": "nnn",
  "token": "<optional owner token for the per-token cap>" }
```
`location` is the resolved geo object from `/api/places/resolve` (or pass `location_label` as a plain string). `basis ∈ {nnn, gross}` (defaults `nnn`).

- **Behavior (PRD §16, verifiable retrieval — LLM-GROUNDING):**
  1. **Cache** lookup by normalized `location+size+basis` (TTL ~24h); a hit returns immediately with `"cached": true`.
  2. **Snippets:** `app/research/rent.build_rent_snippets` builds candidate market-rent source URLs from the resolved location and **fetches each through the SSRF-hardened `fetch.py`** (private/link-local/loopback/metadata ranges blocked, every redirect hop re-validated, the validated IP pinned). A blocked/oversized/unreachable candidate is dropped; **zero snippets is valid**.
  3. **Extract-only:** `app/research/extract.extract_rent` (Anthropic-primary → OpenAI-fallback provider seam) extracts only from those snippets. **Unfetched citations are rejected**; injection markers are stripped (web text is untrusted **data**); if nothing grounded survives, confidence is forced to `low`.
  4. **AI-disabled-safe:** with the `AI_DISABLED` kill switch set or no provider key, **no fetch and no model call happen** — the response is the **labeled regional benchmark** (`rent_per_sqft = 12.0`, the `$12/sq ft` golden-parity default) at `confidence:"low"`. A provider outage degrades to the same benchmark (never a 500). The wizard rent field is always editable.
- **Response `200`:**

```json
{
  "rent_per_sqft": 11.0, "estimate": 11.0, "low": 9.0, "high": 13.0,
  "rent_type": "nnn", "opex": 3.0, "basis": "$/sq ft/yr",
  "confidence": "high", "verified": true, "provenance": "verified",
  "sources": [ { "url":"…","title":"…","source_date":"2026-05","source_tier":"listing" } ],
  "ai_enabled": true, "cached": false
}
```
`verified` is `true` only when a server-fetched source survived **and** confidence is not `low` — it drives the wizard's **verified-vs-estimated** badge (icon + text, never color-only). AI-off / ungrounded → `verified:false`, `provenance:"estimated"`, `sources:[]`, `rent_per_sqft:12.0`. No key/secret ever appears in the body or logs.
- **Errors:** `429 rate_limited` (`{ "error":"rate_limited", "retry_after_seconds": N }` + `Retry-After`, surfaced **before** any upstream fetch/provider call); `422` validation (missing `building_sqft`). Research failures **never block** — they degrade to the benchmark, not an error (§19.2).

---

## 8. Feedback (idea fab) & intent

### 8.1 `POST /api/feedback` — bug/idea → GitHub (redacted)

- **Auth:** none (anyone can report). Rate-limited per IP. **No projection link, ever.**
- **Request body:**

```json
{ "type":"bug|idea|other", "title":"…", "body":"…", "email":"optional",
  "context": { "route":"/p_8x…/edit", "app_version":"1.4.0", "model_version":"2.0.0" } }
```

- **`title`:** required for a `bug` (it must stay triageable → `422 {"error":"title_required"}` when absent); **optional for an `idea`** — an Idea Fab suggestion is just a description, so the client omits `title` entirely.

- **Redaction guarantee (PRD §22, CI-tested):** the GitHub-issue payload contains **only** non-sensitive context — `route` (with any slug stripped), `app_version`, `model_version`, the random `support_id`, and the timestamp. It **never** contains `view_slug`, any token, any resolvable projection link, or any financial field. A server-side test asserts none of these ever appear in the outbound payload — this is the product's top data-leak risk and must be impossible to regress.
- **Behavior:** generate a random `support_id`, open a redacted GitHub issue via `GITHUB_TOKEN`/`GITHUB_REPO`, persist to `feedback` (no financial fields, no projection link).
- **Response `201`:** `{ "support_id":"FB-7K3Q9", "github_issue_url":"https://github.com/…/issues/123" }`. Only the `support_id` is shown to the user; staff-only tooling resolves it server-side.
- **Degrade:** if `GITHUB_TOKEN`/`GITHUB_REPO` unset, feedback is still persisted and a `support_id` returned (`github_issue_url:null`) — graceful, never a 500.
- **Errors:** `400` validation; `429`.

### 8.2 `POST /api/intent` — customer intent → CRM

- **Auth:** none. Rate-limited per IP. Distinct from feedback (PRD §6.1).
- **Request body:** `{ "email":"…", "role":"ED|board|volunteer|…", "reason":"…", "opening_timeline":"3-6mo", "request_expert_review":true, "follow_up_consent":true }`.
- **Behavior:** routes to CRM via `CRM_API_KEY` (graceful-degrade if unset — persisted, not sent). No financial fields.
- **Response `201`:** `{ "received":true }`.
- **Errors:** `400`; `429`.

---

## 9. Actuals (post-launch — schema only in v1)

The endpoints exist and the table ships (so it is not a later migration, PRD §24), but **no actuals UI is built in v1** (§6.3). The routes are owner/edit-gated and documented here for completeness.

| Route | Method | Auth | If-Match | Purpose |
|---|---|---|---|---|
| `…/{view_slug}/actuals` | `POST` | owner/edit | required | Upsert a month's actuals (`month, revenue, donations, payroll, rent, other_expense`). |
| `…/{view_slug}/actuals` | `GET` | owner/edit/view | — | List actuals for forecast-vs-actual (post-launch). |

- **Response `200`:** `{ "actuals":[ { "month":"2027-03", "revenue":38000, … } ] }`.
- **v1 status:** wired and tested at the API/schema level; not surfaced in the UI. Opt-in anonymized pooling is **out of scope for v1**.

---

## 10. `GET /api/health`

- **Auth:** none. Not rate-limited. Used by Railway healthcheck (`healthcheckPath = /api/health`, [OPS_RUNBOOK.md](./OPS_RUNBOOK.md)).
- **Response `200`:** `{ "status":"ok", "build_sha":"<git sha>", "model_version":"2.0.0", "db":"connected", "litestream":"replicating" }`.
- A bare `200` is **not** sufficient as deploy proof — the promote step verifies the response shows the **new** `build_sha` ([DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md), DEPLOYMENT runbook).

---

## 10a. `GET /api/config` — price/gate flag (CTA seam)

The **single server config** for the free-vs-paid business-model decision (PRD §3). The SPA reads it to render the correct call-to-action — "Download free" vs "Request expert review — $X" — with **no client-side price math** (PRD §13).

- **Auth:** none (public, like `/api/health`). Not rate-limited.
- **Query:** `cohort` (optional) — addresses an A/B split (`GATE_MODE__<COHORT>`); the M-1 experiment seam. Falls back to the global mode.
- **Response `200`:** `{ "gate_mode": "free" | "paid_review", "price_usd": <number|null> }`. `price_usd` is non-null **only** in `paid_review`; the client renders it, never derives it.
- **Safe default:** an unset/unknown `GATE_MODE` resolves to `free` (the flywheel default). This config is **never** a required boot secret — a missing value defaults to free and does **not** refuse boot ([SECURITY.md](./SECURITY.md) §3/§4). It is re-read every request, so a settings/env change flips it on the **next** request with no deploy ([OPS_RUNBOOK.md](./OPS_RUNBOOK.md) §9a).

**Enforcement boundary — the gate governs the expert-review / sign-off surface ONLY.** The basic `.xlsx` (§6.3) and basic packet (§6.4) stay **free and ungated in every mode** (GTM decision). The gate is **orthogonal** to the terms-acceptance gate (§6.3/§21): terms are always required before export/share regardless of mode, and a paid gate never bypasses terms.

- `POST /api/expert-review` — the gated expert-review **stub** (the only surface behind the gate dependency; real intake lands M6.3 / M2-INTENT). In `free`, returns `201 { "status":"received", "gate": { "gate_mode", "price_usd", "cohort" } }` — the gate state is emitted for conversion **attribution** (A/B seam). In `paid_review`, the gate raises `402 { "error":"payment_required", "gate_mode":"paid_review", "price_usd":<number|null>, "cohort":<string|null> }`. Flipping `GATE_MODE` back to `free` removes the gate. Payment collection (Stripe) is out of v1 scope.

---

## 11. Error response catalogue

All errors share the shape `{ "error":"<code>", "message":"<human>", ... }` (extra fields per error). Generic to clients — no internal IDs, stack traces, or secrets.

| Status | `error` | When |
|---|---|---|
| `400` | `validation` / `if_match_malformed` / `secret_in_url` | Bad request shape; secret leaked into URL. |
| `401` | `auth_required` | Mutation with no `Authorization`. |
| `402` | `payment_required` | Expert-review / sign-off surface while `gate_mode=paid_review` (§10a); carries `price_usd`. A business-model gate, not an access bug — basic export is unaffected. |
| `403` | `forbidden` / `read_only` / `owner_required` / `terms_required` | Capability insufficient; terms not accepted before export/share. |
| `404` | `not_found` | Unknown `view_slug` (or trashed and requester not owner). |
| `409` | `version_conflict` | Stale `If-Match` — body carries `current_version` + `current_state` (§1.4). |
| `409` | `grounding_failed` / `ai_disabled` / `not_trashed` | Narrative figure ungrounded; AI opt-out; hard-delete on an active projection. |
| `413` / `415` | `file_too_large` / `unsupported_media_type` | Evidence upload limits. |
| `422` | `node_not_pinnable` / `unsupported_basis` / `input_out_of_domain` | Pin on a derived node; radius/ZCTA basis; e.g. 0 sq ft. |
| `428` | `if_match_required` | Mutation missing `If-Match`. |
| `429` | `rate_limited` | Per-IP or per-token limit (carries `retry_after_seconds`). |
| `502` | `places_unavailable` / `census_unavailable` / `research_unavailable` | Upstream data provider down — client falls back to manual entry. |
| `503` | `ai_unavailable` | Both AI providers failed — compute and `.xlsx` still work. |

---

## 12. Endpoint → capability → mutation quick reference

| Method · Path | Capability | `If-Match` | Mutates | Rate-limited |
|---|---|---|---|---|
| `GET /api/projections` | owner | — | no | read |
| `POST /api/projections` | (none) | no | create | create |
| `GET …/{slug}` | owner/edit/view | — | no | read |
| `PATCH …/{slug}` | owner/edit | **yes** | yes | autosave |
| `POST …/{slug}/preview` | owner/edit | no | **no (read-only)** | read |
| `POST …/{slug}/duplicate` | owner/edit | no | create | create |
| `POST …/{slug}/upgrade-model` | owner/edit | **yes** | yes | read |
| `POST …/{slug}/rotate-tokens` | owner | **yes** | yes | read |
| `POST …/{slug}/trash` · `…/restore` | owner | **yes** | yes | read |
| `DELETE …/{slug}` | owner | **yes** | yes (purge) | read |
| `GET …/{slug}/revisions` | owner | — | no | read |
| `POST …/{slug}/revisions/{id}/restore` | owner | **yes** | yes | read |
| `GET …/{slug}/narrative` | owner/edit/view | — | no | read |
| `PUT …/{slug}/narrative` | owner/edit | **yes** | yes | read |
| `POST …/{slug}/narrative:regenerate` | owner/edit | **yes** | yes | regenerate |
| `POST …/{slug}/evidence` | owner/edit | **yes** | yes | upload |
| `GET …/{slug}/xlsx` · `…/packet` | owner/edit/view | — | no | export |
| `GET …/{slug}/penny/transcript` | owner/edit | — | no | read |
| `POST …/{slug}/penny` | owner/edit (view = answer-only) | — (loop's internal `PATCH`es carry it) | yes (`actor:penny` via the loop) | penny |
| `POST /api/penny/draft` | edit Bearer | — | no (persists nothing) | penny |
| `POST /api/penny/proposal` | owner/edit Bearer | — | holds bytes (no parse) | upload |
| `GET/POST …/{slug}/actuals` | owner/edit(/view GET) | POST: **yes** | POST yes | read |
| `POST /api/research` | (none) | no | no | research |
| `GET /api/places/autocomplete` | (none) | — | no | read |
| `POST /api/feedback` | (none) | no | persist | feedback |
| `POST /api/intent` | (none) | no | persist | intent |
| `GET /api/health` | (none) | — | no | none |
| `GET /api/config` | (none) | — | no | none |
| `POST /api/expert-review` | (none) | no | no (stub) | — |

---

## 13. Invariants (testable; see [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md))

1. **No client math.** The frontend never computes a financial figure; it renders `display` strings from the compute response (§13/Appendix C #22).
2. **Mutation safety quad** on every `PATCH`/state-changing `POST`: bearer-auth required, owner-scope isolation (no cross-owner, no global list), `If-Match` 409-on-stale, and a negative/rate-limit path — all four tested.
3. **409 carries current state** (§1.4) so the client never needs a follow-up `GET` to recover.
4. **Derived nodes are non-pinnable** server-side (`422`), not just hidden in the UI (§14).
5. **No silent recompute** on read; `upgrade-model` writes a new revision preserving the prior (§13).
6. **Feedback never leaks** a `view_slug`, token, projection link, or financial field — CI-asserted (§22).
7. **AI opt-out works end-to-end** — compute, save, and `.xlsx` export succeed with all AI keys unset (§21).
8. **Secrets only via header/fragment** — never path/query; `Authorization` and fragments never logged (§20).
9. **Excel ↔ computed_json reconcile** (<$0.50 / 0.1 pp, zero formula errors) with and without overrides, CI-blocking (§18) — the only thing keeping "single math authority" true.
10. **`/preview` is provably read-only** (epic-N N12): a dry-run never persists, never bumps `version`, never writes a revision — CI-asserted over repeated calls.
11. **No ungrounded LLM figure reaches a render path** (§6.1, SECURITY §6.3): every currency/percent token in narrative/packet prose must be a display string the engine produced; an ungrounded `$`/`%` token is rejected. Injection markers are stripped from untrusted text. AI opt-out runs the full compute/save/`.xlsx` flow with **all AI keys unset**.
12. **Penny mutates only through the one write path** (§6.6, Spec B §4/§6.2): the `POST …/penny` tool-use loop applies every edit via `apply_projection_patch` — the same merge → recompute → `If-Match` → one revision the manual `PATCH` uses — producing `version++` + an `actor:penny` revision; there is no parallel writer and no privileged Penny path. Capability-gated (a view-only caller is answer-only, mutate tools refuse). `409 ai_disabled` makes **zero** provider calls; both providers down → `503 ai_unavailable`; an LLM-bucket breach → `429 retry_after_seconds`. `POST /api/penny/draft` mutates only the supplied draft and **persists nothing**. `POST /api/penny/proposal` holds the upload as untrusted bytes (type/size/SSRF guarded) and never executes/renders it — all CI-asserted with **stubbed providers**.

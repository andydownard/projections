# Thrift Store Projection Web App — Product Requirements Document

**Owner:** Andy Downard · **Date:** June 24, 2026 · **Status:** Draft **v3.1 (design-aligned)** · **Source model:** `thrift-store-projections` skill · **Design:** `Thrift projection app design.zip` (interactive prototype)

> v3 turned a build plan into a product strategy (ICP, business model, decision outputs, monthly cash-flow, evidence/trust layer, board packet). **v3.1 folds in the completed design** — it locks the Thriftly green brand palette, **autosave (no login)**, a **two-tab detail page** (Projection · Settings & assumptions), and a refined **percentage-based cost structure** (adds a Marketing & outreach line, makes Supplies a % of revenue, and adds an annual rent escalator). See **Appendix C** for the issue changelog and **Appendix D** for the design reference and the view-model contract the prototype establishes.

---

# Part I — Product strategy

## 1. Summary

A web app that helps a nonprofit operator decide whether and how to launch a thrift store, and produce a board/funder-ready case for it. From a few inputs the app researches the local trade area and a market-rent estimate, builds a **monthly launch cash-flow** plus a **3-year projection** with KPIs and **decision outputs** (break-even, startup capital required, first-year cash gap, go/no-go recommendation), and exports a cited **Board Packet** and a formula-driven `.xlsx`. Every number shows its evidence and confidence. The product is a decision and funding tool, not just a calculator.

## 2. Beachhead ICP (v1)

**One customer:** a small nonprofit or church-backed operator planning their **first** thrift store in the next **3–12 months**.

| Dimension | Definition |
|---|---|
| Buyer (pays / approves) | Board / treasurer / executive director |
| User (builds it) | ED, operations lead, or founding volunteer — **not** a finance expert |
| Budget owner | The board or sponsoring church |
| Urgent trigger | Board asked for a pro forma; a lease is on the table; a grant/funder application is due |
| Current alternative | DIY spreadsheets, a paid consultant, or guesswork |
| Must-have output | A credible, board/funder-ready pro forma with **how much cash is needed, when it breaks even, and a clear go/no-go** |

Everything in v1 is judged against this ICP. Multi-store operators, for-profit resellers, and established chains are explicitly out of scope for v1.

## 3. Business model & value capture

**Recommended v1 model: free lead magnet → paid expert-reviewed Board Packet, feeding Thriftly's core services.**

| Element | Decision |
|---|---|
| Free tier | Create, research, compute, edit, save, and download the `.xlsx` and a basic packet. Drives adoption + SEO + Thriftly leads. |
| Paid event | **Expert-reviewed Board/Funder Packet** — a Thriftly advisor validates assumptions and signs off. Conversion event = "Request expert review / generate funder packet." |
| Price | One-time **$199–$499** per reviewed packet (confirm), or bundled free into a Thriftly services engagement. |
| Buyer | Board/ED preparing for a funding or lease decision. |
| Why pay now | The decision is imminent and high-stakes (a lease signature or grant deadline); a credible, reviewed packet de-risks a board vote. |
| Expected volume | Tie to Thriftly's existing pipeline; target *(set with Thriftly sales)* reviewed packets/quarter and lead handoffs/month. |
| Strategic role | Even unpaid use is valuable: it generates qualified Thriftly leads and proprietary benchmark data (§6.3). |

This is a strategic choice to confirm; the app is built so the gate (what's free vs. paid/reviewed) is a config decision, not a rebuild.

## 4. Jobs to be done — decision outputs

The app must help the user make a **decision**, not just see a forecast. Every projection answers: **proceed now · revise assumptions · find cheaper rent · raise more startup cash · delay opening · do not proceed.**

To support that, it computes and surfaces (details in §12):

- **Break-even revenue** (monthly and annual) and **break-even month**.
- **Startup capital required** = startup costs + peak cumulative cash shortfall + a buffer.
- **First-year cash gap** (largest cumulative negative cash position) and **cash runway** (months to cash-positive).
- **Lease-risk** and **staffing-risk** warnings (occupancy and labor ratios vs. benchmark).
- **Sensitivity ranges** (base / downside / upside) on rent and donations.
- A **rules-based recommendation** with the reasons behind it (§12.3).

## 5. Distribution plan

Three launch channels, each with a promise, activation, conversion goal, and metric:

| Channel | Landing promise | Activation step | Conversion goal | Success metric |
|---|---|---|---|---|
| **Thriftly sales outreach** | "Get a board-ready thrift-store pro forma in minutes." | Create first projection | Request expert review / book consult | Reviewed packets + influenced pipeline |
| **SEO content** ("how to start a nonprofit thrift store," "thrift store business plan") | Free planning tool + template | Start from example → create | Email capture + create | Organic signups → created projections |
| **Nonprofit association / consultant partners** | Co-branded planning tool for member orgs | Partner link → create | Partner-attributed reviewed packets | Partner referrals → conversions |

## 6. Learning, sharing, and data compounding

### 6.1 Customer-learning loop
GitHub feedback is for bugs only. Separately capture **customer intent**: optional email, role, reason for use, opening timeline, and a "request expert review" CTA with follow-up permission. Route **intent → CRM**; route **bugs → GitHub** (§16). This is the discovery engine, not a support afterthought.

### 6.2 Role-specific share views
A projection can be shared as a tailored, read-only view:

- **Board view:** decision risks, cash need, go/no-go, sensitivity. CTA: request expert review.
- **Funder view:** funding need, use of funds, payback logic, sustainability. CTA: export funder packet.
- **Advisor view:** full detail with **comments** enabled. CTA: book Thriftly consultation.

Each view is a read-only capability link (§13) with a role flag controlling emphasis and CTAs.

### 6.3 Data-compounding (post-launch)
After a store opens, let the operator **enter or import actual** monthly revenue, donations, payroll, rent, and expenses, and compare **actuals vs. forecast**. With **opt-in, anonymized** pooling, improve default assumptions by store size, region, and operator type — a moat that makes later projections more accurate than any single consultant's intuition.

---

# Part II — The model & outputs

## 7. Inputs

### 7.1 Wizard-requested (ICP-minimal)

| Parameter | Notes |
|---|---|
| Store / organization name | Identifies the projection. |
| Location | Places autocomplete → place/county + lat/lng. |
| Planned opening (month + year) | Anchors the monthly model; Year 1 = first 12 operating months (§10.1). |
| Opening status | Pre-launch vs. operating (controls startup-cost relevance). |
| Building size (total sq ft) | Drives rent. |
| % used as sales floor | Sales-floor sq ft = total × this %. Drives sales/sq ft. |
| Lease type / rent type | Gross vs. **NNN** (NNN adds opex). |
| Average donation value | Resale value per donation → top line. |
| **Donor market share — Year 1, Year 2, Year 3 (all three, explicit)** | No auto-midpoint. Presets pre-fill a ramp the user edits per year. Alternatively expressed as donations/week (the app converts). |
| Source of startup funds (optional) | Cash on hand, grant, loan, campaign — feeds the cash/capital view. |

**Making share understandable (non-finance users).** Each year's share field shows a live helper — "X% of ~N trade-area households → ~D donations/week → ~$R revenue" — plus benchmark presets (*Conservative 5%*, *Moderate 7%*, *Aggressive 10%*; established Longview store ≈ 7%). An "even ramp" helper can pre-fill Year 2 between Year 1 and Year 3, but all three are editable.

### 7.2 Auto-researched, editable (§§8–9, 17–18)
Trade-area household base; market-rent estimate (range + confidence + sources); opex for NNN.

### 7.3 Cost structure & smart defaults (design-aligned; editable on the Settings tab)

The design expresses operating costs primarily as **percentages of revenue** (sliders on the Settings & assumptions tab), which is cleaner and more defensible than fixed dollar lines. Defaults:

| Driver | Default | Notes |
|---|---|---|
| Donations / household / yr | 3 | demand engine |
| Average basket value | $17 | → customers |
| **Labor (payroll) % of revenue** | *confirm* | Prototype shows **40%**; Andy previously set **60%** — **resolve the product default**. Editable slider regardless. |
| **Marketing & outreach % of revenue** | 3.75% | **New line item** introduced by the design. |
| **Supplies & processing % of revenue** | 5.0% | **Reclassified** from the old fixed "Store/office supplies" to a % of revenue. |
| Credit-card fees % of revenue | 2.0% | |
| Payroll tax % of payroll | 7.5% | |
| Salvage % of retail | 0.8% | |
| **Annual rent escalator** | 3.0% | **New** — rent/occupancy grows each year (applies to Y2–Y3). |
| Cash reserve buffer | $25,000 | feeds startup-capital-required (§12.1) |

**Occupancy/rent** can be entered as an **annual occupancy dollar amount** (the prototype shows ~$90,000 Year-1, "verify with a broker quote") or derived from sq ft × rate; the **Gross vs. NNN** toggle and the escalator both apply. Remaining fixed lines (insurance, internet/phones, pest, security, repairs, utilities) and the startup-cost lines stay per the engine. The donation/revenue ramp curve drives the monthly model (§10).

## 8. Trade area & household base (v1 scope locked)

"Donor market share" requires a defined denominator. **v1 ships exactly three bases; radius/ZCTA is deferred** (and the design prompt matches this).

| Basis | v1 |
|---|---|
| **City (place)** | ✅ v1 — ACS households for the place |
| **County** | ✅ v1 — ACS households for the county |
| **Manual** | ✅ v1 — user enters households (always available) |
| Radius / drive-time / ZCTA | ⛔ deferred — when built, spec **ACS vintage year, FIPS handling, margin-of-error display, and partial-tract aggregation rules** |

The chosen basis and resulting household count are stored in `trade_area_json`, shown on the detail page, and named in KPIs/narrative ("share = % of ~31,800 Longview-city households"). The number is always editable.

## 9. Donor-demand modeling

Households × share is the **quick mode**. Because that is thin, v1 adds optional **demand drivers** that adjust confidence (not necessarily the point estimate in v1):

Competition (nearby thrift density), drive-time/convenience, donation drop-off convenience, pickup service offered, store visibility, hours, area income proxy, marketing plan, seasonality.

- **Quick mode** (defaults) is allowed but is labeled **lower confidence**. Supplying drivers **raises the confidence** rating and is reflected in the evidence panel and narrative.
- Seasonality feeds the monthly ramp (§10); other drivers inform confidence and the guardrail commentary (§13). A later version can let drivers scale the estimate.

## 10. Monthly launch cash-flow model (new core)

A 3-year annual P&L hides early-failure risk. The model is **monthly first**; the 3-year P&L is derived from it.

### 10.1 Year 1 definition (locked)
**Year 1 = the first 12 operating months**, starting at the planned opening month. Not a calendar/fiscal year. This label is used consistently across UI, KPIs, Excel, narrative, and exports. (Removed from open questions.)

### 10.2 Monthly model
Months `M0` (pre-open, if pre-launch) through `M12`:

- **Startup outflows** (timed): lease deposit, build-out, fixtures/equipment, opening inventory, legal/permits, consultant — placed in their actual months, not averaged.
- **Donation ramp:** donations build from opening to steady state over a configurable ramp (default S-curve, e.g., ~3–6 months), seasonality-adjusted.
- **Revenue ramp:** retail revenue follows donations (with the donation→revenue lag); salvage follows retail.
- **Costs:** payroll begins at hire dates (may precede opening); fixed costs begin at lease start; variable costs scale with monthly revenue.
- **Cash:** monthly net + cumulative **cash balance**; **minimum cash** (most-negative cumulative position); **break-even month** (first month operating net ≥ 0 and sustained).
- **Year 1 P&L totals derive from the 12 operating months** (so annual figures and the monthly model never disagree).

### 10.3 3-year P&L
Years 2–3 are annual, driven by each year's explicit market share (§7.1) and the steady-state structure. Year 1 comes from the monthly roll-up.

## 11. KPIs

Per period, recomputed live (subject to §12.4 guards): Total revenue · Net profit · Net margin · **Sales per sales-floor sq ft** · Sales per total sq ft · Revenue per donation · Revenue per customer · Annual donations · Customers · Occupancy cost ratio · Labor ratio · Donations per sq ft · **Break-even month** · **Startup capital required** · **First-year cash gap** · Simple payback (yrs) · Revenue CAGR (Y1→Y3).

## 12. Decision metrics, guardrails & recommendation

### 12.1 Capital & cash
- **Startup capital required** = Σ startup costs + |peak cumulative cash shortfall| + **cash reserve buffer** (configurable; design default **$25,000**). The prototype surfaces this prominently (e.g., "$277,990") with a "Why? →" link to the reasons.
- **First-year cash gap** = most-negative cumulative cash position across M0–M12.
- **Cash runway** = months from open until cumulative cash turns positive.
- **Break-even revenue** = fixed + variable structure solved for net = 0 (monthly and annual).

### 12.2 Forecast guardrails & benchmarks
Each driver has a benchmark band; exceeding it triggers a visible warning **and requires the user to write a justification note** that travels into the packet:

| Metric | Typical band (advisory) |
|---|---|
| Donor market share | ≤ ~8% Year 1 for a new store |
| Sales per sq ft | ~$50–$300 |
| Labor ratio | ~25–60% of revenue |
| Occupancy ratio | ≤ ~15–20% of revenue |
| Net margin | flag > ~30% as unusual for a new store |

Add **base / downside / upside sensitivity** on **rent** and **donations** (e.g., ±25%), showing the effect on net profit, break-even month, and capital required.

### 12.3 Recommendation (rules-based, explainable)
Derive a recommendation from the signals, always with the reasons shown:

- **Proceed** — positive Year-1 cash trajectory, capital need ≤ stated funds, ratios in band.
- **Revise assumptions** — outcomes hinge on out-of-band inputs (flagged).
- **Find cheaper rent** — occupancy ratio out of band is the binding constraint.
- **Raise more startup cash** — capital required exceeds stated source of funds.
- **Delay opening** — ramp/seasonality makes the chosen month cash-infeasible.
- **Do not proceed** — break-even not reached within the horizon under base/downside.

### 12.4 Edge-case math
Cents internally; display whole dollars / 0.1%. Guards: revenue = 0 → margins & per-unit KPIs **"N/A"** (null); Year-1 net ≤ 0 → payback **"N/A — no Year 1 profit"**; Year-1 revenue = 0 → CAGR **"N/A"**; negatives in parentheses + error color; 0 sq ft blocked; outliers get advisory badges (§12.2); `.xlsx` renders N/A as blank + comment (never `#DIV/0!`). All N/A are explicit `null` + a `flags` map.

## 13. Compute model — single source of truth

- **Server-side engine is the only math authority.** **No client-side computation in v1** — server compute targets **< 50 ms**, so the app uses **debounced server compute + loading states + reconciliation**, not a second math surface. (Revisit only if measured latency demands it.)
- **Versioned + locked.** `computed_json` is stored with the `model_version` that produced it. **Projections never silently recompute on a new engine.** When a newer model exists, show "New model available" and let the user **upgrade into a new revision** (the prior revision is preserved).
- **Test gate:** golden tests reconcile server compute vs. the verified engine and vs. a LibreOffice recalculation of the exported workbook (< $0.50 / 0.1pp, zero formula errors), with and without overrides.

## 14. Override model, graph & inspector

Cell overrides are **pins** on a DAG; recompute is topological so the statement stays consistent.

```
market_share[y] → donating_households → donations → retail_revenue → customers
retail_revenue → salvage_sales ; retail+salvage → total_revenue
total_revenue → card_fees, payroll → payroll_taxes ; sqft,rate(,opex) → rent
{expense lines} → total_expenses → net_profit → net_margin
```

Rules: pinned nodes use their value; unpinned nodes compute from (possibly pinned) inputs; **no upstream back-solve** (upstream rows that no longer drive a pinned downstream value are flagged); **derived rows + KPIs are never pinnable** so the statement always foots; per-cell and global reset.

**Override Inspector (required):** a panel listing every pin — cell, **calculated value**, override value, note, timestamp, and **affected downstream rows**. The UI **steers users to driver-level edits first** (change an assumption) and explains, in plain language, when an upstream row no longer drives a pinned downstream value.

## 15. Evidence & trust

Trust is a feature, not a footnote.

- **Every researched/estimated number shows:** source, date, **method**, **confidence**, and **"what would change this number."** Verified inputs are visually separated from estimates everywhere — UI, narrative, Excel, packet.
- **User evidence:** users can **attach** rent quotes, broker notes, payroll plans, and comparable-store data. Attaching evidence can promote an estimate to **"verified (user-provided)"** and raises confidence.
- The Board Packet (§17) leads with this evidence, not prose.

## 16. Research subsystem — verifiable retrieval

No loose "LLM browses and cites." A **retrieval layer** grounds research:

1. **Server fetches** candidate sources and stores `url`, `title`, `fetch_date`, `extracted_text`, `source_date`, `source_tier` (broker/listing/aggregator/news/gov/unknown).
2. The **LLM extracts only from provided snippets**; it cannot introduce a citation that was not server-fetched. **Unfetched citations are rejected.**
3. **Prompt-injection rules:** web text is treated as untrusted **data, never instructions**; embedded directives are ignored/stripped; the model is told to extract facts only.
4. **Rent estimate output:** `{estimate, low, high, rent_type, opex, basis, confidence, sources[]}`; weak/no sources → low confidence or labeled benchmark fallback; always editable.
5. **Households** come from the Census API per the locked basis (§8) and show the ACS vintage and geography.
6. **Caching** by normalized location+size key with TTL; manual re-research bypasses cache.

## 17. Board Packet (primary trust surface) + narrative

The **Board/Funder Packet** is the headline export; prose is generated **from** it.

- **Packet contents:** decision recommendation (§12.3); assumptions table (verified vs. estimated); **citations/evidence** with dates and confidence; **sensitivity table**; risks (lease, staffing, ramp); **cash need + break-even**; monthly cash-flow summary; 3-year P&L; KPIs. Role-tailored emphasis (board/funder/advisor).
- **Narrative is demoted** to prose generated from the packet's structured facts. **Numeric grounding:** every figure in the prose must exist in `computed_json`/approved facts (validated post-generation; unverified figures rejected). Low temperature; Anthropic→OpenAI fallback. The prose states rent as an estimate/range, not a fact.
- **Stale handling:** store `computed_hash` at generation; if figures change, show "Out of date" with a diff + Regenerate; never auto-overwrite user-edited prose.
- **Formats:** Board Packet as PDF/`.docx`; narrative editable; `.xlsx` per §18.

## 18. Excel export contract

Server-generated via the engine. Cell rules:

| Cell class | Representation |
|---|---|
| Inputs / assumptions | hard-coded, **blue** |
| Computed, not overridden | **live formula** |
| **Overridden** component | hard-coded, **orange** fill + comment "Manual override — calc was =formula → $X; set to $Y on <date>" |
| Totals / net / margin / KPIs | **always formulas** over components (foots even with overrides) |
| Monthly cash flow | its own tab; Year-1 P&L tab references the monthly roll-up |
| N/A (§12.4) | blank + comment, never `#DIV/0!` |

**Release gate:** after generation, recalc with LibreOffice; assert every cell equals saved `computed_json` (< $0.50 / 0.1pp) and zero formula errors, with and without overrides. CI-blocking.

---

# Part III — Platform

## 19. Pages

### 19.1 Projections list (`/`)
Owner-scoped (§20); no global index. Rows: name, location + basis, updated, **Year-1 revenue, net profit, capital required, recommendation chip**. Actions open/duplicate/trash; Trash with restore. Utilitarian empty state (heading + Create + "start from example"; no marketing illustration).

### 19.2 Create wizard (`/new`) + draft recovery
Steps: Store & location → Building & lease → Trade area (city/county/manual) → Donations & demand (**3 explicit share years**; presets; optional drivers) → Source of funds → Review research (rent estimate w/ confidence + sources + override; Advanced defaults) → Generate.
- **Draft recovery:** save a **local draft after step 1**; offer resume / clear draft; timeout behavior defined. **No server record is created until Generate** (or an explicit "save draft").
- Research failures never block (manual entry).

### 19.3 Projection detail — **two tabs** (as designed)
**Top bar (persistent):** `thriftly · projections` logo, projection name + **version chip** ("v4 · current", with "new model available" upgrade), **autosave state** ("All changes saved"), **Revisions**, **Share**, and the **idea/feedback** button (lightbulb, docked in the bar).

**Tab 1 — Projection** (`/{view_slug}` read-only · `…/edit` editable):
- **Decision banner:** recommendation chip + headline + reasons ("Proceed. The model clears break-even and stays within committed funding."), **Startup capital required** with a **"Why? →"** link, and the case label ("conservative case · city basis").
- **KPI tiles:** Sales per sq ft (Y1), Y1 total revenue (+ customers), Y1 net margin (+ net $), Capital required.
- **Monthly launch cash-flow — Year 1:** bar/line chart with a **break-even marker**, plus rows Revenue / Expenses / Monthly net / Cumulative cash (negatives in red parentheses).
- **3-year table:** legend (Input · Computed · Overridden · Estimated); click an **input** cell to edit a driver or an **expense** cell to override; derived rows read-only; **Override inspector (n)** button → drawer (calculated vs. override, note, **affected downstream rows**, per-pin Reset + Reset all; "prefer driver-level edits" guidance).
- **Evidence & assumptions:** each number shows **source, date, method, confidence**, a **+ Attach evidence** action, and a **"What would change this:"** line.
- **Sensitivity:** rent & donation swings vs. the base case.
- **Export Board Packet** + Download `.xlsx`.

**Tab 2 — Settings & assumptions:** "Edits here flow straight into the projection. **Saved automatically — no login.**" Cost-structure **sliders** (labor %, marketing %, supplies & processing %…), occupancy/rent ($ + Gross/NNN toggle + annual escalator), sales-floor area, and the three per-year shares. A "View projection →" button returns to Tab 1.

**Autosave model:** edits persist automatically (debounced); each settle writes a revision snapshot (§24). No explicit Save button.

### 19.4 Role views & error/degraded states
Board/funder/advisor read-only views (§6.2). Designed states: rent-research-failed (manual), low-confidence rent, location-not-found (manual households), **save conflict (409)** (reload/overwrite/save-as-copy), offline/save failure (retry + local draft), stale narrative, read-only edit attempt.

## 20. Access, sharing & security

- **No login; capability tokens.** Owner **bearer token** (≥256-bit) in `localStorage`, sent as `Authorization: Bearer` (no cookie ⇒ no CSRF for mutations). List is **owner-scoped**, never global.
- **No secrets in URL paths.** Workspace recovery uses a **one-time recovery code** shown once and/or a secret carried only in the **URL fragment** (never sent to the server, never logged) — not a path segment. Recovery secrets are never written to server logs.
- **View vs. edit, with rotate/revoke.** Read-only `view_slug`; editing needs the **edit token** (fragment-delivered). **Rotate/revoke** for view links, edit links, and role links. **On compromise:** rotate invalidates shared links; the revision log shows access events.
- **Read-only users may view and download `.xlsx`/packet** (no information beyond what they can already see). Whether export is gated is a business-model toggle (§3), not an access bug.
- **Hardening:** server-side rich-text **sanitization**; strict **CSP**; **CORS** locked to origin; **`X-Robots-Tag: noindex`** + robots disallow; **rate limits** per IP+token; **audit logs**; token hashing + constant-time compare; HTTPS/HSTS.

## 21. Privacy, AI disclosure & legal

- **AI disclosure:** clearly tell users **when data is sent to AI providers** (rent research, narrative) and to whom. Provide **opt-out**: the app must **compute, save, and export `.xlsx` without any AI feature** (manual rent, no generated narrative).
- **Retention:** define provider data-retention (prefer zero-retention endpoints), app retention, **backup purge limits** (Litestream/object-store lifecycle), and provider-logging settings.
- **Legal/trust language:** projections are **planning estimates — not accounting, tax, legal, investment, lending, or lease advice**. Require **terms acceptance before export/share**. Researched estimates carry **source-date stamps** and **"verify locally"** notes.

## 22. Feedback → GitHub (no data leakage) + intent → CRM

- **Bugs → GitHub**, but **never include `view_slug` or any resolvable projection link.** Generate an internal **support ID** (random) shown to the user; only server-side staff tooling resolves it to a projection. Safe even if the repo is public.
- Auto-context is non-sensitive only (route, app version, `model_version`, support ID, timestamp). Notice: "Don't paste sensitive financial details." No financial fields in the payload.
- **Intent → CRM** (§6.1): email, role, reason, timeline, review request, follow-up consent.

## 23. Architecture

```
[ Frontend (Thriftly standard: React + TS) ] — Authorization: Bearer (owner/edit token; secrets via URL fragment)
        │ REST/JSON (CORS-locked, noindex)
        ▼
[ App API (Python FastAPI) ]
   ├── Engine (reused: compute, monthly cash flow, .xlsx, packet)  ← single math authority, version-locked
   ├── Research (Places, Census, retrieval+fetch store, LLM extract-only, cache)
   ├── Decision/guardrails (capital, cash gap, sensitivity, recommendation)
   ├── Packet/narrative (grounded; numeric check; stale tracking)
   ├── Access (tokens, view/edit/role links, revisions, soft delete, conflict)
   ├── Feedback (GitHub redacted + support IDs) · Intent (CRM)
   └── SQLite (WAL) + Litestream  ·  actuals store (post-launch)
External: Google Places · US Census · Anthropic · OpenAI · GitHub · CRM
```
Secrets server-side only: `GOOGLE_PLACES_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO`, `CENSUS_API_KEY`, `CRM_API_KEY`.

## 24. Data model (SQLite)

**projections:** `id`, `view_slug` (≥128-bit), `owner_token_hash`, `edit_token_hash`, `name`, `status` (active/trashed), `version` (optimistic concurrency), `location_json`, `trade_area_json` (basis, geography, households, ACS vintage), `inputs_json` (incl. opening, lease/rent type, **share_y1/y2/y3**, source-of-funds), `demand_drivers_json`, `assumptions_json`, `overrides_json` (`"{node}#{year}"`→`{value,note,ts}`), `monthly_json` (cash-flow), `computed_json` (resolved P&L+KPIs+decision metrics + `flags`), `model_version`, timestamps, `deleted_at`.

**revisions:** snapshot per save (incl. monthly + computed), `actor_token_hash`, `change_summary`, `created_at`.

**evidence:** `id`, `projection_id`, `field` (rent/households/payroll/…), `kind` (researched/user-attached), `value`, `confidence`, `method`, `source_url`, `source_title`, `source_date`, `fetch_date`, `source_tier`, `file_ref?`.

**narratives:** `body_md` (sanitized), `edited`, `computed_hash` (stale detection), `updated_at`.

**research_cache:** location+size key, households(+basis/vintage), rent (est/low/high/type/opex/confidence), `sources_json`, provider, `fetched_at`.

**feedback:** `support_id`, `type`, `title`, `body`, `email?`, `context_json` (non-sensitive), `github_issue_url`, `status` — **no financial fields, no projection link.**

**actuals (post-launch):** `projection_id`, `month`, `revenue`, `donations`, `payroll`, `rent`, `other_expense` — for forecast-vs-actual and opt-in benchmarks.

Tokens stored hashed; `view_slug` stored plain (lookup key).

## 25. API endpoints (indicative)
Mutations require `Authorization: Bearer` + `If-Match: <version>`.
`GET/POST /api/projections` (list owner-scoped / create) · `GET/PATCH /api/projections/{slug}` (fetch / update+recompute, 409 on stale) · `POST …/duplicate` · `POST …/upgrade-model` · `POST …/rotate-tokens` · `GET …/revisions` + `POST …/revisions/{id}/restore` · `POST …/trash|restore` + `DELETE` · `GET …/xlsx` · `GET …/packet` · `GET/PUT/POST …/narrative(:regenerate)` · `POST …/evidence` (attach) · `POST /api/research` · `GET /api/places/autocomplete` · `POST /api/feedback` (support ID) · `POST /api/intent` (CRM) · `POST/GET …/actuals`.

## 26. Storage & ops
Single long-lived host with a **durable volume** (no ephemeral/edge FS for the DB). **WAL**, `busy_timeout`, serialized writes. **Litestream** continuous replication + snapshots; documented restore drill, RPO/RTO, and **backup purge limits** (§21). Versioned migrations on deploy. Data-access behind an interface; **Postgres path** when concurrency/auth/multi-instance demands. 

## 27. Non-functional
Server compute < 50 ms; research async + cached; correctness gates (§13/§18); cost control (cache research/narrative, cap regenerations); observability (per-provider latency/errors, audit); accessibility (keyboard wizard/table/overrides/modal, labels, AA, reduced-motion, no color-only meaning); responsive incl. honest mobile (§ design prompt).

## 28. Milestones

| Milestone | Scope |
|---|---|
| **M-1 Pre-build validation** *(gate before heavy build)* | **20 ICP interviews · 10 manually produced projections · 5 users who share with a board/funder · 3 paid or sales-qualified conversions** — before building advanced overrides, narrative generation, or full research automation. |
| **M0 Scaffold** | Repo, FastAPI, SQLite(WAL)+Litestream, engine wired, noindex/CORS/CSP, terms gate. |
| **M1 Compute + cash flow** | Server-authoritative compute + **monthly cash-flow** + decision metrics; version lock; golden tests vs Excel. |
| **M2 MVP loop (smallest shippable)** | Minimal inputs (manual/city/county households, manual rent) → compute → **save → reopen → `.xlsx`** + basic packet. No automated research/overrides/narrative. |
| **M3 Research + evidence** | Places + Census + **retrieval-grounded** rent estimate + evidence panel + attachments. |
| **M4 Editing depth** | Assumptions + cell overrides + Override Inspector + revisions + view/edit/role links + 409 conflict + soft delete. |
| **M5 Board Packet + narrative** | Packet export + grounded prose + stale handling + sensitivity. |
| **M6 Feedback + intent** | Redacted GitHub + support IDs; CRM intent loop. |
| **M7 Hardening + actuals** | Security/ops/runbooks, a11y, error states, design QA; post-launch actuals + benchmarks (opt-in). |

## 29. Risks & open questions
Frontend framework (engine-as-service holds regardless); business-model price/gate to confirm with Thriftly; rent-estimate variance (mitigated by retrieval + confidence + override); workspace-key loss = access loss (documented); abuse without accounts (tokens + limits + audit); ramp/seasonality assumptions need calibration against real openings (feeds §6.3). Radius/ZCTA trade area deferred with rules pre-specified (§8).

## Appendix A — formulas
See `reference/methodology.md` in the skill; the app must match it (§13 gate). Adds: monthly ramp/cash-flow, break-even, capital required, sensitivity. Year 1 = first 12 operating months.

## Appendix B — example payload
```json
{
  "name": "House of Hope — Longview, TX",
  "location": { "query": "Longview, Texas", "place_id": "…" },
  "trade_area": { "basis": "city", "households": 31798, "acs_vintage": 2023 },
  "inputs": {
    "opening": "2027-03", "opening_status": "pre_launch",
    "building_sqft": 10000, "salesfloor_pct": 0.70, "lease_type": "NNN",
    "donation_value": 74,
    "demand": { "mode": "market_share", "share_y1": 0.06, "share_y2": 0.08, "share_y3": 0.10 },
    "source_of_funds": { "cash": 150000, "grant": 50000 }
  },
  "demand_drivers": { "competition": "low", "pickup_service": true, "marketing_plan": "launch + ongoing" },
  "assumptions": { "labor_pct": 0.60 },
  "overrides": { "Payroll#2": { "value": 250000, "note": "signed 2 hires" } }
}
```

## Appendix C — adversarial-revision changelog (issue → fix)

**P0 product/decision:** 1 ICP → §2 · 2 business model → §3 · 3 decision outputs → §4/§12 · 4 monthly cash flow → §10 · 5 Year 1 defined → §10.1.
**P0 trust:** 6 evidence & trust → §15 · 7 verifiable retrieval → §16 · 8 forecast guardrails → §12.2 · 9 donor-demand drivers → §9 · 10 board packet (narrative demoted) → §17.
**P0 access/privacy/security:** 11 no secrets in URL → §20 · 12 no projection link in feedback (support IDs) → §22 · 13 privacy & AI disclosure/opt-out → §21 · 14 legal/trust language → §21.
**P1 scope/distribution/learning:** 15 pre-build validation → §28 (M-1) · 16 distribution → §5 · 17 learning loop → §6.1/§22 · 18 role views → §6.2/§19.4 · 19 data-compounding → §6.3/§24.
**P1 execution/UX:** 20 trade-area scope locked → §8 · 21 Override Inspector → §14 · 22 remove optimistic client math → §13 · 23 wizard draft recovery → §19.2 · 24 lock model versions → §13 · 25 honest mobile scope → §19/design prompt.
**Model change:** donor market share is an explicit input for **Year 1, Year 2, and Year 3** (no midpoint) → §7.1, §14, §24, Appendix B, design prompt.
**P2 design:** 26–29 in the companion Design Prompt (sample data, startup/capital UI, brand placeholder, QA criteria).

**v3.1 (design-aligned):** committed brand palette (Appendix D) · **autosave / no login** (§19.3, §20) · **two-tab detail page** (§19.3) · **percentage cost structure** + new **Marketing & outreach** line + **Supplies & processing** as % + **annual rent escalator** + **$25k reserve buffer** (§7.3, §12.1) · top-bar/version chip and view-model contract (Appendix D).

## Appendix D — Design reference & view-model contract

**Artifact:** `Thrift projection app design.zip` — an interactive prototype (`House of Hope Projection.dc.html`), `assets/thriftly-logo.svg`, and screenshots (`cashflow`, `cashflow2`, `drawer`, `thanks`). Open the `.dc.html` in a browser to interact (override a cell → cash-flow + metrics update; open the inspector; switch tabs; trigger feedback).

**Designed:** detail page (Projection tab) — decision banner, KPI tiles, monthly cash-flow, 3-year table with override; Settings & assumptions tab (sliders, occupancy, escalator, shares); Override inspector drawer; Evidence & assumptions panel; Sensitivity; feedback success; list + wizard navigation scaffold.
**Still to design (not in the prototype):** Board Packet document layout; board/funder/advisor role views; mobile 375 (per-year stacked editor); the full error/degraded state set (rent-research-failed, low-confidence, location-not-found, save-conflict 409, offline, stale narrative, AI opt-out); list and wizard at full fidelity.

**Brand tokens (committed by the design — Thriftly green + warm neutrals):**

| Role | Hex |
|---|---|
| Brand primary (green) | `#35644f` |
| Brand deep / hover | `#1d4733` |
| Text near-black (green-black) | `#0b1b14` · slate `#313335` |
| Positive / success | `#257648` (tints `#89cc9f` `#b8e2c4` `#daf1df` `#f0f9f3` `#f8faf8`) |
| Body gray / muted | `#5b5f61` · `#989fa4` |
| Borders / lines | `#cacbc2` · `#ededed` |
| Surfaces (warm off-white) | `#faf9f6` · `#f6f5f2` · `#efede9` · panel `#f3f4f6` · white `#ffffff` |
| Error / negative | `#dc2626` (tints `#fee2e2` `#fef2f2`) |
| Warning / low-confidence | `#b45309` (tints `#fef3c7` `#fffbeb`) |
| Override accent (tan) | `#cbb7a9` |

Font: system sans stack (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, …`).

**View-model contract (field names the prototype establishes — build the compute API to emit these):**

- **`reco`** `{ tag, headline, sub, color, bg, icon }` — the recommendation banner.
- **`metrics`** `{ capital, cashGap, breakeven }` + **reasons** `{ reasonCapital, reasonGap, reasonBreakeven }`.
- **`kpis[]`** `{ label, value, sub, color }` — KPI tiles.
- **`monthly[]`** per month `{ revenue, expenses, net, cumulativeCash }` + `breakevenMonth` — drives the cash-flow chart/table.
- **`rows[]`** (3-year table) per line `{ label, group, y1, y2, y3, class: input|computed|overridden|estimated, editable }`.
- **`overrides[]`** (inspector) `{ node, year, calculated, value, note, pinnedDate, affected[] }`.
- **`evidence[]`** `{ label, value, method, badge (confidence), change ("what would change this"), meta (source+date) }`.
- **`settings`** `{ laborPct, marketingPct, suppliesPct, cardPct, payrollTaxPct, salvagePct, escalator, basket, donationsPerHh, shareY1, shareY2, shareY3, occupancyAnnual, leaseType (gross|nnn), salesfloorSqft, reserveBuffer }`.
- **Views:** `isList | isWizard | isDetail | isSettings`; nav `goList / goDetail / goSettings`; `saveLabel` (autosave state); `version` ("v4 · current").

Prototype sample (conservative default): shares 6% → 8% → 10%; basket $17.08; labor 40%; marketing 3.75%; supplies 5%; escalator 3%; reserve $25k; Y1 revenue ~$426,911; Y1 net margin ~11%; capital required ~$277,990; break-even ~month 5.

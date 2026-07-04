# Thrift Projection App — Engineering Handoff

**For:** the build (ticket planning + a terminal coding session). **Date:** June 24, 2026.
**Read order:** this doc → PRD v3.1 (`Thrift Projection App — PRD.md`, the source of truth) → design prototype (`Thrift projection app design.zip`).

This is a planning aid, not a replacement for the PRD. It pulls the build-relevant decisions, the model deltas, the view-model contract, and a ready-to-file ticket backlog into one place.

---

## 0. Inputs you already have

| Artifact | What it is | Use |
|---|---|---|
| `Thrift Projection App — PRD.md` (v3.1) | Full spec | Source of truth |
| `Thrift Projection App — Design Prompt.md` | Design brief | Background / intent |
| `Thrift projection app design.zip` | Interactive prototype + screenshots + logo | UI reference + view-model contract |
| `thrift-store-projections.skill` | The **existing, verified Python engine** (`scripts/generate_projection.py`) | **Lift this as the starting math engine** — unzip it; it already does bottom-up compute + formula `.xlsx` + Word |

Open the prototype: unzip and open `House of Hope Projection.dc.html` in a browser. Override a cell → cash-flow and decision metrics recompute; open the override inspector; switch Projection / Settings tabs; trigger the feedback modal.

## 1. Locked decisions (don't re-litigate)

- **Storage:** SQLite (WAL) on a host with a **durable volume** + Litestream backups; data-access behind an interface so Postgres is a later swap. No edge/ephemeral FS.
- **Access (no login):** owner **bearer token** (localStorage, `Authorization: Bearer`); per-projection **view slug** (read-only) + **edit token**; recovery secret only in the **URL fragment**, never in a path or logs; **rotate/revoke** supported.
- **Persistence UX:** **autosave** ("Saved automatically — no login"); each settle writes a revision snapshot. No Save button.
- **Compute:** **server-side engine is the only math authority**; no client math; versioned + **version-locked** (old projections never silently recompute).
- **Cost model:** percentage-of-revenue drivers (labor %, **marketing & outreach %**, **supplies & processing %**, card %, payroll-tax %, salvage %), **annual rent escalator**, **$25k cash reserve** in capital math.
- **Trade area v1:** City / County / Manual only (radius/ZCTA deferred).
- **Year 1 = first 12 operating months.** Donor market share is **three explicit years** (no midpoint).
- **Brand:** Thriftly green palette (tokens in §6).

## 2. Open decisions — resolve these first (some are blockers)

| # | Decision | Why it matters | Blocker? |
|---|---|---|---|
| 1 | **Frontend framework** (Thriftly's standard) | Can't scaffold the UI without it | **Yes — M0** |
| 2 | **Labor default: 40% (design) vs 60% (your earlier call)** | Changes every projection's margin | Yes — engine defaults |
| 3 | Business-model **gate** (free vs paid/reviewed packet) | Decides whether export is gated | Before M5/launch |
| 4 | API keys/accounts: Anthropic, OpenAI, Google Places, Census, **GitHub repo (public vs private)**, CRM | Research, narrative, feedback, intent | Per epic |
| 5 | Ramp curve + seasonality + reserve calibration | Affects cash-flow realism | Before M1 sign-off |
| 6 | Hosting target (single VM/container w/ volume) | Ops/Litestream setup | M0 |

## 3. Engine deltas (math work on top of the existing Python engine)

The current engine computes an annual 3-year P&L from `share_y1`/`share_y3` (midpoint Y2) with fixed-dollar cost lines. To match v3.1 it needs:

1. **Per-year shares** `share_y1/y2/y3` (drop the midpoint convenience).
2. **Cost structure as % of revenue:** `laborPct`, **`marketingPct` (new line "Marketing & outreach")**, **`suppliesPct` (was fixed "Store/office supplies")**, plus `cardPct`, `payrollTaxPct`, `salvagePct`.
3. **Occupancy/rent:** accept an **annual occupancy $** OR sq ft × rate; **Gross vs NNN** (+opex); **annual escalator** applied to Y2–Y3.
4. **Monthly model (M0–M12):** timed startup outflows; donation ramp (S-curve + seasonality) → revenue ramp (with lag) → salvage; payroll from hire dates; monthly net + **cumulative cash**; **minimum cash**; **break-even month**. **Year-1 annual totals = sum of the 12 operating months.**
5. **Decision metrics:** `capital = Σ startup + |peak cash shortfall| + reserve($25k)`; `cashGap` (most-negative cumulative); `runway`; break-even revenue; **rules-based recommendation** (proceed / revise / cheaper rent / raise cash / delay / do not proceed) with reason strings.
6. **Sensitivity:** base/down/up (±25%) on rent and donations → net, break-even, capital.
7. **Edge-case guards:** N/A for payback (Y1 net ≤ 0), CAGR (Y1 rev = 0), margins (rev = 0); negatives in parens; outlier advisory flags.
8. **Override resolution:** topological DAG; pins use their value; downstream recomputes; **no upstream back-solve**; derived rows + KPIs never pinnable.
9. **Emit the view-model JSON** (§5) so the API response maps 1:1 to the prototype.
10. **Excel export contract:** add Marketing/Supplies/escalator + a **monthly cash-flow tab**; overridden cells become **hard-coded + orange + comment**; totals stay formulas; **LibreOffice recalc test asserts every cell == `computed_json`, zero errors**.

**Guardrail for the build:** keep a **golden test** that reproduces the existing House of Hope numbers (and the prototype's conservative sample: shares 6/8/10%, basket $17.08, labor 40%, marketing 3.75%, supplies 5%, escalator 3%, reserve $25k → Y1 revenue ≈ $426,911, Y1 margin ≈ 11%, capital ≈ $277,990, break-even ≈ month 5).

## 4. Proposed backlog (epics → tickets, ready to file)

Ordered to match PRD milestones. Each ticket has a one-line acceptance criterion (AC).

### EPIC M-1 — Validation (non-eng, track anyway)
- 20 ICP interviews · 10 manual projections · 5 board/funder shares · 3 paid/SQL conversions. **AC:** documented before heavy build (advanced overrides, narrative, full research automation).

### EPIC A — Scaffold & infra (M0)
- A1 Repo + chosen frontend framework + FastAPI service. **AC:** hello-world deploys to the host.
- A2 SQLite WAL + migrations tool + Litestream replication. **AC:** restore drill passes.
- A3 Security baseline: `noindex` header, CORS lock, CSP, HTTPS/HSTS, secrets via env. **AC:** headers verified.
- A4 Lift the Python engine into the service. **AC:** existing engine importable; current House of Hope numbers reproduced in a test.

### EPIC B — Compute engine v2 (M1)
- B1 Per-year shares + % cost structure (labor/marketing/supplies). **AC:** golden test vs House of Hope passes.
- B2 Occupancy ($ or sq ft×rate), Gross/NNN, escalator. **AC:** Y2/Y3 rent grows by escalator.
- B3 Monthly model + break-even + cumulative cash; Year-1 = 12-month roll-up. **AC:** annual totals == sum of months.
- B4 Decision metrics + recommendation rules. **AC:** sample yields "Proceed", capital ≈ $277,990.
- B5 Sensitivity engine. **AC:** base/down/up returned for rent & donations.
- B6 Edge-case guards + `flags`. **AC:** zero-revenue and Y1-loss cases return N/A, never errors.
- B7 Emit view-model JSON (§5). **AC:** response renders the prototype without transformation.
- B8 Versioned + locked compute. **AC:** stored `model_version`; no silent recompute.

### EPIC C — Persistence & access (M2 + M4)
- C1 `projections` schema + owner token + view slug + edit token (hashed). **AC:** list is owner-scoped; no global index.
- C2 Create/read/update (autosave PATCH) + `If-Match` version + 409 conflict. **AC:** stale edit returns 409 with latest.
- C3 Revisions (snapshot on save) + restore. **AC:** restore creates a new revision.
- C4 Soft delete + trash/restore + purge window. **AC:** delete is recoverable for N days.
- C5 Recovery link via fragment + rotate/revoke tokens. **AC:** rotated link invalidates old edit access; secret never logged.

### EPIC D — MVP loop UI (M2)
- D1 List page (owner-scoped, recommendation chips, empty state, trash). **AC:** matches prototype list scaffold.
- D2 Wizard (store/location → building/lease → trade area city/county/manual → 3 shares → funds → review) + **draft recovery after step 1**. **AC:** no server record until Generate.
- D3 Detail **Projection tab** render from view-model (banner, KPIs, monthly, 3-year table). **AC:** pixel-parity with prototype on the conservative sample.
- D4 Detail **Settings tab** (sliders, occupancy, escalator, shares) with autosave. **AC:** edits recompute and persist automatically.
- D5 `.xlsx` download. **AC:** LibreOffice recalc test passes (zero errors; cells == computed_json).

### EPIC E — Research & evidence (M3)
- E1 Places autocomplete proxy. **AC:** resolves to place/county + lat/lng.
- E2 Census households for city/county + manual. **AC:** basis + ACS vintage stored and shown.
- E3 Retrieval-grounded rent estimate (server-fetch → snippet store → extract-only → reject unfetched citations → injection rules). **AC:** estimate carries range, confidence, ≥1 fetched source.
- E4 Evidence panel + attach evidence (promote to "verified"). **AC:** each researched number shows source/date/method/confidence/"what would change this".

### EPIC F — Editing depth (M4)
- F1 Cell override (pin) + topological recompute. **AC:** override updates downstream; statement foots.
- F2 Override inspector drawer (calc vs override, note, affected rows, reset/reset-all). **AC:** matches prototype drawer.
- F3 "Prefer driver-level edits" guidance + upstream-decoupling flag. **AC:** shown when an upstream row no longer drives a pinned downstream value.

### EPIC G — Board packet + narrative (M5)
- G1 Board Packet export (assumptions verified/estimated, citations, sensitivity, risks, cash need, recommendation). **AC:** PDF/docx generated from `computed_json`.
- G2 Grounded narrative (computed-JSON-only facts + numeric grounding check + stale warning, no auto-overwrite). **AC:** hallucinated figures rejected; stale banner on change.
- G3 Role views (board/funder/advisor) + AI opt-out path. **AC:** compute + `.xlsx` work with narrative disabled.

### EPIC H — Feedback + intent (M6)
- H1 Feedback → GitHub with **support ID**, no projection link, redacted context. **AC:** issue contains no financials/links.
- H2 Intent capture (role, reason, timeline, review request) → CRM. **AC:** routed separately from bugs.

### EPIC I — Hardening + actuals (M7)
- I1 Rate limits + audit logs + token entropy review. **AC:** abuse caps enforced.
- I2 Error/degraded states (rent-failed, low-confidence, location-not-found, 409, offline, stale, opt-out). **AC:** each designed + handled.
- I3 Mobile 375 (review-first; per-year stacked editor; no hover). **AC:** QA screenshots pass.
- I4 Post-launch actuals import + forecast-vs-actual + opt-in benchmarks. **AC:** actuals stored per month and compared.

## 5. View-model contract (build the API to emit this)

From the prototype (PRD Appendix D):

```
reco      { tag, headline, sub, color, bg, icon }
metrics   { capital, cashGap, breakeven }  + { reasonCapital, reasonGap, reasonBreakeven }
kpis[]    { label, value, sub, color }
monthly[] { month, revenue, expenses, net, cumulativeCash }  + breakevenMonth
rows[]    { label, group, y1, y2, y3, class: input|computed|overridden|estimated, editable }
overrides[] { node, year, calculated, value, note, pinnedDate, affected[] }
evidence[]  { label, value, method, badge(confidence), change("what would change this"), meta(source+date) }
settings  { laborPct, marketingPct, suppliesPct, cardPct, payrollTaxPct, salvagePct,
            escalator, basket, donationsPerHh, shareY1, shareY2, shareY3,
            occupancyAnnual, leaseType(gross|nnn), salesfloorSqft, reserveBuffer }
meta      { version, saveLabel, modelVersion }
```

Data model + endpoints: PRD §24–§25. Mutations require `Authorization: Bearer` + `If-Match: <version>`.

## 6. Brand tokens (committed by the design)

`brand #35644f` · `brand-deep #1d4733` · `text #0b1b14 / #313335` · `success #257648` · `gray #5b5f61 / #989fa4` · `border #cacbc2 / #ededed` · `surface #faf9f6 / #f6f5f2 / #efede9 / #f3f4f6 / #ffffff` · `error #dc2626 (#fee2e2)` · `warning #b45309 (#fef3c7)` · `override #cbb7a9`. Font: system sans stack. Logo: `assets/thriftly-logo.svg` in the zip.

## 7. Definition of done / quality gates (every relevant ticket)

- Compute golden test (server == engine == LibreOffice-recalc'd `.xlsx`, < $0.50 / 0.1pp, zero formula errors), with and without overrides.
- No projection data in feedback/GitHub; secrets server-side; `noindex`/CSP/CORS enforced.
- A11y: keyboard table editing, visible focus, AA contrast, no color-only meaning.
- Design QA screenshots at 1440 / 768 / 375 on stress data (long name, negative profit, low-confidence estimate, overridden cell).

## 8. Suggested first terminal session

1. Resolve open decisions #1 (framework) and #2 (labor default).
2. Scaffold repo (A1–A3); stand up SQLite + Litestream.
3. Unzip `thrift-store-projections.skill`; import `generate_projection.py`; write the **golden test** reproducing House of Hope (A4).
4. Implement engine deltas B1–B3 (per-year shares, % cost structure, monthly model) behind the golden test.
5. Add B4 decision metrics + B7 view-model JSON; verify it matches the prototype's conservative sample.
6. Stand up C1–C2 (create/read/list, owner token, autosave) and D3 (render the Projection tab from the view-model).

That gets a real end-to-end slice — create → compute → save → reopen → render — against the verified math, before layering research, overrides, narrative, and packet.

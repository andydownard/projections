# Design Prompt — Thrift Store Projection Web App (v3)

*Paste into Claude design. This is a finance-grade **launch-decision and funding tool**, not a marketing site or a plain calculator. Design **desktop-first (1440px)** with required **tablet (768)** and **mobile (375)** behavior. No login; access is capability-based (read-only view link vs. edit link). The headline outputs are a **decision** (go/no-go, cash needed, break-even) and a cited **Board Packet** — not just a projection table.*

---

## Product in one paragraph

A nonprofit operator enters a few inputs (store name, location, building size, % sales floor, lease type, average donation value, and **donor market share for each of Year 1, 2, and 3**). The app researches a trade-area household count and a market-rent **estimate**, then produces a **monthly launch cash-flow**, a **3-year projection** with KPIs (incl. **sales per sq ft**), and **decision outputs** (break-even month, startup capital required, first-year cash gap, and a go/no-go recommendation). Every number shows its evidence and confidence. Users edit assumptions or override cells, save without a login, share role-specific read-only views, export a **Board Packet** and a formula-driven `.xlsx`.

## Audience & tone

Nonprofit operators/founders and their boards — **not finance experts**. Trustworthy, precise, efficient; closer to a clean financial tool than a consumer app. Plain-language guidance; the numbers and the decision are the product.

## Visual direction — table-first, decision-forward, dense

- **Numbers and the decision lead.** Top of the detail page is a **decision banner** (recommendation + capital required + break-even month). Below it, a compact **monthly cash-flow** visual and a dense **3-year table**. Cards are minimal; KPIs are a tight stat strip.
- **Tabular/lining figures**, right-aligned, consistent decimals. Money `$#,##0`; percent 0.1%; negatives in parentheses + error color.
- Restrained chrome: hairline rules, grouped row bands, minimal shadow. Comfortable dense rows (~13–14px).
- Clearly distinguish **input** cells, **computed** cells, **overridden** cells, and **estimated vs. verified** values (badges + icon, never color alone).

## Color tokens — brand vs. meaning, brand UNCONFIRMED

- **Do not invent Thriftly brand colors.** Use a clearly labeled **placeholder palette** and mark brand tokens **"UNCONFIRMED — placeholder."**
- Keep **semantic colors independent of brand:** success/positive, **warning/low-confidence**, error/negative, info, and a distinct **override** accent. Negative profit = error color regardless of brand; low-confidence estimate = warning; overridden cell = override accent. Provide the neutral ramp + token list with placeholder hexes.

## Global elements

- **Top bar:** logo (placeholder), and on detail: Share (view/edit/role links), save state, version/"new model available" control. **Create** primary on the list.
- **Feedback button:** small, **collapsed**, docked in the top bar (or low-profile bottom-right that auto-hides on scroll and never overlaps the table scrollbar or primary actions). **Keyboard-accessible** (focusable, Enter opens, Esc closes). On mobile it sits above any bottom nav, out of the data area.

## Sample data (use these; default is MODEST, outliers are flagged)

Design with realistic content and stress cases. **Make the default case conservative**; visibly flag high-share/high-margin outcomes as unusual.

- **Default — "House of Hope — Longview, TX" (conservative):** city basis, ~31,800 households; **market share 6% → 8% → 10%** (three explicit years). Y1: donations ~5,700 · customers ~25,000 · total revenue ~**$427,000** · net profit modest · **net margin ~8–12%** · sales/sq ft ~**$61** (7,000 sq ft sales floor). Decision banner: capital required ~$250–300k, break-even ~month 7, recommendation **"Proceed — within funding."**
- **Moderate case:** share 8% → 11% → 14%; healthy but in-band.
- **Aggressive case (flagged):** share 15% → 20% → 25%, net margin ~39% → show an **"Unusually high — verify assumptions"** advisory badge and a required justification note.
- **Loss / edge case — "Grace Mission Community Thrift & Donation Center" (long-name test):** Y1 net **($12,400)** (parentheses + error color); payback **"N/A — no Year 1 profit"**; rent estimate **$14/sq ft · low confidence** badge; one **overridden** Payroll cell (Y2 $250,000, calc was $190,000).

Show real expense line items, monthly cash-flow with a negative early trough, and a startup-cost list.

## Screens to design

### 1) Projections list (home) — owner-scoped
Dense list: name, location + **trade-area basis**, updated, Y1 revenue, Y1 net profit, **capital required**, and a **recommendation chip** (Proceed / Revise / etc.). Actions open/duplicate/trash; Trash + restore. **Utilitarian empty state** (heading + Create + "Start from example"); **no decorative illustration.**

### 2) Create wizard (`/new`)
Steps: **Store & location** → **Building & lease** (sq ft, sales-floor % slider, gross vs **NNN**) → **Trade area** (**v1 basis = City / County / Manual only — no radius/ZIP**; shows researched households, editable, names the geography) → **Donations & demand** (donation value; **three explicit market-share fields Y1/Y2/Y3** with an "even ramp" pre-fill helper and benchmark presets; optional demand drivers that show a **confidence** effect) → **Source of funds** → **Review research** (rent **estimate + range + confidence badge + sources**, editable; Advanced defaults). 
- **Draft recovery:** after step 1, show a "draft saved" indicator; on return, **Resume / Clear draft**. No server projection until **Generate**.
- Design states: location step; donations step (with the 3 share fields + helper); review in **researching / results / research-failed (manual entry)**.

### 3) Projection detail — core screen (`/{view_slug}` read-only · `…/edit`)
Top to bottom:
- **Decision banner:** recommendation + **startup capital required** + **break-even month** + **first-year cash gap**, each tappable to the reasons.
- **Monthly launch cash-flow:** chart + table (startup outflows, donation/revenue ramp, cumulative cash, minimum-cash trough, break-even month).
- **3-year table:** Operating drivers, Revenue, Expenses, Totals. Assumption-driven and overridable cells editable; derived rows read-only.
- **KPI strip:** sales/sq ft + decision metrics (capital, cash gap, payback, occupancy/labor ratios) featured.
- **Evidence panel:** verified vs. estimated, each with **source, date, method, confidence, "what would change this,"** and **attach evidence** (rent quote, broker note, payroll plan, comps).
- **Sensitivity:** base / downside / upside on rent and donations → effect on net, break-even, capital.
- **Narrative** (secondary) + **Export Board Packet** (primary) + **Download .xlsx**, Save, Duplicate.
- **Header:** inline name, location + basis, save state, **revision menu** + "new model available" upgrade, Share.

### 4) Override Inspector
A panel/drawer listing every pin: cell, **calculated value**, override value, note, timestamp, **affected downstream rows**. Steer users to **driver-level edits first**; explain in plain language when an upstream row no longer drives a pinned downstream value. Per-cell reset + reset-all. In the table, show a cell in **calculated / editing / overridden** states (override = accent left-border + dot; tap/click popover comparing calculated vs override with the audit note; **reachable reset on touch**, not hover-only).

### 5) Board Packet (primary trust artifact)
A clean, exportable document layout: decision recommendation, assumptions (verified vs. estimated), **citations/evidence with dates + confidence**, sensitivity table, risks (lease/staffing/ramp), **cash need + break-even**, monthly summary, 3-year P&L, KPIs. Provide **board / funder / advisor** variants (advisor shows comments). Design the on-screen export preview.

### 6) Role share views
Read-only **Board** (decision risks, cash need, go/no-go), **Funder** (funding need, use of funds, payback), **Advisor** (full detail + comments). Each with appropriate CTA: request expert review · export funder packet · book Thriftly consultation.

### 7) Feedback modal
Type (Idea/Bug/Other), title, description, optional email; notice "Don't include sensitive financial details." Shows a **support ID** on success (no projection link). Success state with confirmation. Separately, an **intent capture** (role, reason, opening timeline, "request expert review," follow-up consent) — distinct from bug reports.

### 8) Error & degraded states
Rent-research-failed (manual entry) · low-confidence rent (warning + verify) · location-not-found (manual households) · **save conflict 409** (Reload latest / Overwrite / Save as copy) · offline/save-failure (retry + local draft) · stale narrative (banner + Regenerate) · read-only edit attempt (needs edit link) · **AI opt-out** state (compute + `.xlsx` work, narrative disabled).

## Responsive & honest mobile scope

- **Desktop-first (1440).** **Tablet (768):** wizard single-column; detail stacks; table scrolls with **sticky first column**.
- **Mobile (375) — review-first.** Mobile supports **viewing, light assumption edits, and decision review**; heavy cell-override work is desktop/tablet. The 3-year table uses a **per-year stacked editor** (one year at a time) with **touch-safe override controls and tap popovers — no hover tooltips**. KPI strip and cash-flow scroll horizontally; modal full-screen; feedback button above bottom nav.

## Accessibility

Keyboard-navigable wizard, **table cell editing**, override controls, inspector, and modal; visible focus; labels and badges (confidence/override/estimate) conveyed by **icon + text, not color alone**; WCAG **AA** contrast; respect reduced-motion.

## Design QA — acceptance criteria (must pass)

Deliver **1440, 768, and 375** screenshots populated with the **stress data** above (long org name, negative profit, low-confidence estimate, overridden cell, aggressive-case flag). Each must show: **no overlapping text, no clipped/truncated currency values**, **keyboard-operable table editing**, **visible focus states**, **AA contrast**, and a **reachable override-reset control** (including on touch). Provide the **placeholder brand tokens (marked unconfirmed)** + semantic tokens + type scale.

## Deliverables

High-fidelity screens: (1) list — populated (with recommendation chips) + empty + trash; (2) wizard — location, donations (3 share fields), review in researching/results/failed; (3) detail — decision banner + monthly cash-flow + 3-year table, an **overridden-cell** state, the **Override Inspector**, the **evidence panel**, and the **save-conflict** state; (4) Board Packet preview (board/funder/advisor); (5) feedback + intent; (6) error/degraded set incl. AI opt-out; (7) mobile (375) list, a wizard step, and the per-year stacked table editor. Include tokens and type scale.

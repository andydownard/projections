# Design: Create-Projection Wizard, Shell Polish & Pre-Opening Cost Schedule

**Date:** 2026-06-27 · **Status:** Approved design (pre-plan) · **Spec:** A of 2 (Penny assistant is Spec B — see `2026-06-27-penny-assistant-design.md`)

## Summary

Overhaul the create-projection experience and the app shell, and extend the engine to model a **multi-month pre-opening period** driven by a **user-entered timed cost schedule** (consultant, build-out, equipment, etc.). This lets months before grand opening — and post-opening support — appear in the projection's cash flow, startup-capital, and break-even numbers.

This spec is **manual-entry and deterministic** (no AI). The AI layer (Penny) that parses an uploaded proposal into the schedule and makes agentic edits is **Spec B** and builds on the data model + engine defined here.

## Goals

1. A single, consistent app header on every route: `thriftly` wordmark │ "Store Projections", with the Idea Fab lightbulb.
2. The Idea Fab feedback path present per the designs (docked lightbulb → existing feedback modal). Intent tab deferred.
3. Fix Google Places address autocomplete (currently returns no results).
4. A full-page, step-by-step **"Create Projection"** wizard.
5. Trade-area households start empty and populate only after Places→Census resolves; overwritable.
6. A **timed cost schedule** (category + month # + amount) replacing the fixed startup lump, anchored to a target opening date + opening month #.
7. An engine **pre-opening period** so scheduled costs before/after opening flow into the projection.

## Non-Goals (this spec)

- Penny / any AI (proposal parsing, agentic edits, chat) — Spec B.
- The "request expert review" intent tab — later.
- Spreading *operating* expenses across pre-opening (only the explicit cost schedule is timed; operating expenses begin at opening).

---

## 1. Shell & header

A single shared `TopBar` renders on every route (home/list, wizard, detail, role view). Left cluster, identical everywhere: the `ThriftlyLogo` wordmark, a thin divider, and the text **"Store Projections"** (replaces "Thrift Store Projection"). Right cluster: the Idea Fab lightbulb (always present); the model-version / save-state chips remain detail-page-only.

**Idea Fab (feedback-only):** a keyboard-accessible docked lightbulb button in the `TopBar` (focusable, Enter opens, Esc closes) opens the existing `FeedbackModal` (already styled; posts redacted feedback to GitHub via `POST /api/feedback`). The "request expert review" intent tab is out of scope here. Because the lightbulb lives in the shared `TopBar`, it is present on every page automatically.

## 2. Places autocomplete fix

**Root cause:** `app/geo/client.py` calls the **legacy** Places API (`https://maps.googleapis.com/maps/api/place/autocomplete/json` and `/details/json`). Google denies legacy endpoints for newer keys (`REQUEST_DENIED`), and `places_autocomplete` swallows the exception into `{"predictions": []}` — so the user sees nothing.

**Fix:**
- Migrate the autocomplete + place-details calls in `app/geo/client.py` to **Places API (New) v1** (`https://places.googleapis.com/v1/places:autocomplete` and `/v1/places/{id}`), keeping the response shaped to the existing `Prediction` / details contract the rest of the code expects. Keys stay server-side (CLAUDE.md rule 7).
- Add a **dev-visible error path**: when not in production, surface the upstream status (e.g., log `REQUEST_DENIED`/HTTP status) instead of silently returning `[]`, so this class of failure can't regress unnoticed. Production still fails closed (no key in logs).
- Keep the static-map + Census legs unchanged unless they share the denied surface.

**Acceptance:** the live `/api/places/autocomplete` returns predictions for a real query; the wizard address field shows them.

## 3. Create-Projection wizard (full page, step-by-step)

A full-page route titled **"Create Projection"** (not a modal — chosen so Spec B's left-slide Penny drawer composes cleanly). One step visible at a time, with a step indicator, Back/Next, and Generate on the final step. "Start from example" remains available. The route is `/wizard` (deep-link + back/forward already work via the SPA fallback).

Steps:
1. **Store** — name + address (Places autocomplete).
2. **Trade area** — households (see §4) + city/county basis toggle + evidence.
3. **Donor market** — Year 1 / 2 / 3 share % + benchmark note.
4. **Cost schedule** — target opening date, opening month #, and the timed cost rows (see §5).
5. **Review → Generate.**

Each step is its own focused component with a shared wizard-state hook and validation gating Next. Built so a future step (or Penny drawer) inserts without rework.

## 4. Households empty-until-resolved

The households field is **empty and disabled** until an address is selected and the Census resolve returns. On resolve it is populated with the Census count (with `households_source: census_acs`, MOE, basis toggle, evidence). The user may **overwrite** it (→ `households_source: user_edited`). If Places/Census fails, the field becomes manually editable (existing fallback) with `households_source: manual`. Generate is blocked until households has a value.

## 5. Timed cost schedule (manual)

Replaces the fixed `STARTUP` lump (`Thrift Store Consultant 100000`, `Equipment & Fixtures 45000`, `Build-out 50000`, `Legal/Permits 13500`) with a **schedule of timed line items**.

- **Row shape:** `{ category: string, month: int >= 1, amount: dollars }`. `category` is a label (e.g., "Consultant", "Build-out / Renovations", "Equipment & Fixtures", "Legal / Permits"); the user can add rows and pick a month as they enter.
- **Anchor:** the user sets a **target opening date** and an **opening month #** — the project month on which grand opening falls (a **milestone**, general: it can be month 1, or month 6, or any month). Months `1 .. opening#-1` are pre-opening; `opening# .. opening#+11` are operating Year 1; rows may fall on any month, before or after opening (e.g., post-open support).  Calendar labels are derived from `target_opening_date` + `opening_month#`.
- **Default behavior (no special synthesis):** the natural default reduces to today's behavior simply by the user putting startup costs in **month 1** and setting **grand opening = month 1** — then there are no pre-opening months and the costs are a single lump at opening. There is no separate "grouped" default mode; grouping vs. spreading is entirely the user's choice via where they place the rows and the opening month.
- **Validation:** server-side — `month >= 1`, amount ≥ 0, opening_month# ≥ 1; totals derived server-side (no client math).

## 6. Engine — multi-month pre-opening period

Today `engine/monthly.py` builds one pre-open `M0` (entire startup lump) + `M1–M12`. New model — a **uniform monthly timeline** where pre-opening months are first-class P&L months (NOT excluded, NOT merged into month 1):

- The timeline is **project months `1..N`**; `opening_month#` (= `G`) is a **milestone marker**. Every month has a P&L line. Months `1..G-1` (pre-opening) have **no operating revenue** and no operating expenses (the store isn't open) — their P&L is the **scheduled costs landing that month** (a real monthly loss). Months `G..N` carry operating revenue/expense **plus** any scheduled costs on those months. `N` covers pre-opening + the 12 operating months (`N = G + 11`).
- **Pre-opening months feed the P&L and cash flow as real months** — they appear in the monthly income statement / cash-flow with their costs and a negative net, and contribute to cumulative cash. The user may *choose* to place all costs in month 1 (= grouping), but the engine never forces grouping or exclusion.
- **Scheduled costs** from §5 are placed on their month #s (replacing the single startup lump). Total startup = sum of the schedule.
- **Decision metrics recomputed** from the new cumulative-cash curve: `startup_capital_required` = peak cumulative cash deficit across the whole timeline (begins accumulating in pre-opening); `break_even_month` = first sustained operating month (≥ `G`) with net ≥ 0, numbered in project months with the opening milestone marked; `first_year_cash_gap` per the operating Year-1 window (`G..G+11`).
- **View-model + chart** include all months `1..N` (x-axis starts at month 1; the grand-opening milestone is marked). The 3-year **annual** operating P&L is measured from the opening milestone (Year 1 = `G..G+11`); pre-opening months are shown in the monthly view and as a pre-opening period that rolls into the income statement/startup — exact annual-table presentation finalized in plan review, but pre-opening is never dropped or forced into month 1.
- **Three milestones computed precisely** on the new timeline (see §8): `grand_opening_month` (= `G`, the input), `break_even_month` (first sustained operating month with ongoing revenue ≥ ongoing expenses — already computed), and a true `payback_month` (first month where cumulative operating profit since opening ≥ total startup costs — i.e., the investment is recovered). The crude `simple_payback_years` (startup ÷ Year-1 net) is replaced by this exact payback period.
- **`.xlsx` export** and the **three-way golden gate** (server == computed_json == LibreOffice recalc) extend to the pre-opening months; golden fixtures regenerated. `model_version` bumps (math/shape change); reads of older snapshots still return the stored snapshot + "new model available" (existing behavior).

## 7. Data model

`projection.inputs` gains (additive migration, no DROP):
- `target_opening_date` (string, ISO month or date)
- `opening_month_number` (int ≥ 1)
- `cost_schedule`: `[{ category, month, amount }]`

The fixed startup constant is superseded by `cost_schedule`. **Migration default for projections without a schedule** (legacy rows + the seeded example): place the legacy `STARTUP` category amounts at **month 1** with `opening_month_number = 1` — i.e., a single lump at opening, reproducing today's numbers exactly (this is the same result a user gets by entering costs in month 1 + opening month 1, not a special engine mode). Schedule is server-validated; the engine consumes it. Provenance for AI-populated schedules is added later (Spec B).

## 8. Projection detail-page milestones

The detail page calls out **three milestones** explicitly, both as labeled markers on the monthly cash-flow chart and as named callouts (with their plain-language definitions surfaced as help text/tooltips, server-formatted display strings — no client math):

1. **Grand Opening** — month `G`, the milestone when the store opens (the wizard input). Marked on the timeline.
2. **Breakeven Point** — the milestone where ongoing revenue matches ongoing expenses; crossing it means day-to-day operations are officially profitable. (= `break_even_month`.)
3. **Payback Period** — the length of time for accumulated profits to equal the initial startup costs; reaching the end means the investment has officially been recovered. (= `payback_month` / the period from opening to it.)

All three come from the engine view-model as `{raw, display}` (e.g., "Month 6", "Month 14", "Month 31" / "25 months"). The cash-flow chart marks Grand Opening, Breakeven, and Payback distinctly; the decision banner / KPI strip surfaces Breakeven and Payback with their definitions on hover/tap. When a milestone is not reached within the horizon, show an explicit N/A with the reason (existing flag pattern), never a misleading 0.

## Components & files (anticipated)

- Frontend: `TopBar.tsx` (brand text + lightbulb + all-routes), new `web/src/pages/CreateProjectionPage.tsx` (full-page wizard shell) with step components (`StepStore`, `StepTradeArea`, `StepDonorMarket`, `StepCostSchedule`, `StepReview`) + a wizard-state hook + step indicator; `PlacesAutocomplete.tsx` (verify rendering); a `CostScheduleEditor` component; `shareHelper.ts`/`buildCreatePayload` extended for the new inputs.
- Backend: `app/geo/client.py` (Places API New); `app/routers/projections.py` (`InputsIn` + create/patch accept the schedule + opening anchor; default-schedule synthesis); migration for the new inputs.
- Engine: `engine/monthly.py` (pre-opening months + scheduled costs), `engine/compute.py` / `engine/decision.py` (metrics from new curve), `engine/viewmodel.py` (pre-opening in the cash-flow view-model), `engine/xlsx.py` (workbook rows), `engine/model.py` (default schedule, `MODEL_VERSION` bump).

## Testing

- **Engine:** golden three-way reconcile **including** pre-opening months (with and without a custom schedule); decision-metric tests for the deeper trough / opening-anchored break-even; **milestone tests** — grand-opening = `G`, breakeven = first sustained operating net ≥ 0, payback = first month cumulative profit ≥ startup total (and N/A-with-reason when unreached); migration default == legacy-lump value parity test.
- **Backend:** schedule validation, create/patch round-trip of the new inputs, additive migration test, Places-API-New client against the mocked network seam.
- **Frontend:** wizard step flow (gating, Back/Next, Generate), households-empty-until-resolved, cost-schedule editor (add/remove rows, opening anchor), `TopBar` lightbulb opens feedback on every route, Places predictions render.
- **E2E:** create-projection happy path through all steps with a manual multi-month cost schedule; existing flows still green.

## Risks / open considerations

- **Golden-gate churn:** the pre-opening change touches the correctness spine; fixtures must be regenerated carefully and the LibreOffice `.xlsx` leg kept in lockstep.
- **Backward compatibility:** the migration default (costs at month 1, opening month 1) + a parity test guard that existing projections' numbers don't move.
- **Annual roll-up semantics:** pre-opening months ARE first-class P&L months (monthly view + income statement); the only open detail is how the *annual* 3-year table presents the pre-opening period (its own column/period vs. rolled into the operating Year-1 window) — decided in plan review. They are never excluded or forced into month 1.

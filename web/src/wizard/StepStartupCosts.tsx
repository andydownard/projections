// web/src/wizard/StepStartupCosts.tsx — wizard step 5 (last): set startup costs.
//
// The home for RENT (owner Decision 10): the #245 research-prefilled, editable
// $/sq ft rate with its verified-vs-estimated badge + sources sits ABOVE the cost
// grid. Utilities & fixtures auto-seed the cost rows behind the scenes (set on the
// square-footage step), so only rent is surfaced here. The opening DATE field is gone
// (owner Decision 13 — `targetOpeningDate` dropped); the grand-opening MONTH is set on
// the grid's draggable column (#34).
//
// The cost editor is the ROWS × MONTHS grid (Epic D #263, decision #31): line-items as
// rows, months 1–12 as columns, a Total column. The schema stays flat — the grid is a
// frontend pivot. Totals come from POST /api/cost-schedule/preview as `{raw, display}`
// (decision #15) — NO client math (the client renders, never sums).
//
// #32: a contextual "Upload consultant proposal" affordance hands the PDF to Penny,
// who reads it and sets the consultant pay schedule + grand-opening month (server-side
// parse_proposal + edit_cost_schedule). A descriptive spinner runs while she reads.
// The manual grid + drag stay fully working if AI is unavailable (graceful degradation).
//
// Task 2.4 (Wave 2) adds: (a) an ALWAYS-VISIBLE "Source of funds" fieldset (cash/
// grant/loan) — no client-computed total is shown (NO-CLIENT-MATH, PRD §13; the
// server sums after Generate); (b) three AdvancedOptions groups (closed by
// default) from the shared paramGroups.ts taxonomy — "Rent & lease" (escalator),
// "Operating cost structure" (5 cost %s + 5 fixed-annual $/yr lines), and
// "Funding & capital" (reserve buffer, sensitivity stress %); (c) a "Timing"
// section-label heading above the opening-month + cost-schedule grid (both stay
// primary/always-visible — only the heading is new).
import { useEffect, useRef, useState } from "react";

import { previewCostSchedule, type CostSchedulePreview } from "../api/costSchedule";
import { AdvancedOptions } from "../components/AdvancedOptions";
import { CostScheduleEditor } from "../components/CostScheduleEditor";
import { NumberField } from "../components/NumberField";
import { groupsForStep } from "./paramGroups";
import { DEFAULT_OPENING_MONTH_NUMBER, type CostScheduleRow } from "./shareHelper";
import { advancedKey } from "./useWizardState";
import type { WizardState } from "./useWizardState";

const STEP_KEY = "startup-costs" as const;

// The five fixed-annual operating-cost line labels — exact WizardDraft.fixedAnnual
// keys (task brief), in display order.
const FIXED_ANNUAL_LINES = [
  "Insurance liability",
  "Internet, Phones",
  "Pest control",
  "Repairs/maintenance",
  "Security system",
] as const;

/** A stable DOM id from a fixedAnnual label ("Internet, Phones" → "internet-phones"). */
function fixedAnnualId(label: string): string {
  return `wizard-fixed-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
}

export interface StepStartupCostsProps {
  state: WizardState;
  /** Hand a chosen proposal PDF to Penny (upload → parse_proposal → edit_cost_schedule).
   *  Omitted when AI is off — the manual grid stays the path. */
  onUploadProposal?: (file: File) => void | Promise<void>;
  /** True while Penny is reading the proposal (drives the descriptive spinner). */
  proposalBusy?: boolean;
  /** A plain-language message if the proposal couldn't be read (never a crash). */
  proposalError?: string | null;
}

/** The contextual proposal affordance (#32): pick a PDF → Penny lays out the schedule.
 *  Shown only when AI is available (onUploadProposal present). */
function ProposalAffordance({
  onUploadProposal,
  busy,
  error,
}: {
  onUploadProposal: (file: File) => void | Promise<void>;
  busy: boolean;
  error?: string | null;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="cost-proposal" data-testid="proposal-affordance">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        data-testid="proposal-file-input"
        aria-label="Upload consultant proposal PDF"
        style={{ display: "none" }}
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onUploadProposal(file);
          if (inputRef.current) inputRef.current.value = "";
        }}
      />
      <button
        type="button"
        className="cost-proposal__btn"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        data-testid="proposal-upload-btn"
      >
        <span aria-hidden="true">📄</span> Upload consultant proposal
      </button>
      <span className="cost-proposal__caption">
        Penny reads it and lays out the consultant schedule + grand-opening month.
      </span>
      {busy && (
        <p className="cost-proposal__spinner" role="status" data-testid="proposal-spinner">
          <span className="wizard-spinner__dot" aria-hidden="true" /> Penny is reading your
          proposal…
        </p>
      )}
      {error && !busy && (
        <p className="cost-proposal__error" role="alert" data-testid="proposal-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function StepStartupCosts({
  state,
  onUploadProposal,
  proposalBusy = false,
  proposalError = null,
}: StepStartupCostsProps) {
  const { draft } = state;

  const groups = groupsForStep(STEP_KEY);
  const rentLeaseGroup = groups.find((g) => g.id === "rent-lease")!;
  const costStructureGroup = groups.find((g) => g.id === "cost-structure")!;
  const fundingGroup = groups.find((g) => g.id === "funding")!;
  const timingGroup = groups.find((g) => g.id === "timing")!;
  const fixedAnnual = draft.fixedAnnual ?? {};

  // Server totals for the grid (decision #15): the client never sums. Debounced + abort
  // so rapid cell edits coalesce; a failure keeps the last good totals (presentation,
  // never a gate). Keyed on a stable serialization of the rows + the sqft fallback.
  const [totals, setTotals] = useState<CostSchedulePreview | null>(null);
  const rows = state.costSchedule;
  const rowsKey = JSON.stringify(rows);
  const buildingSqft = draft.buildingSqft;
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewCostSchedule({ rows, buildingSqft, signal: controller.signal })
        .then(setTotals)
        .catch(() => {
          /* keep prior totals — totals are presentation, never a gate */
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey, buildingSqft]);

  return (
    <section className="wizard-step" aria-labelledby="step-cost-heading">
      <h2 id="step-cost-heading" className="wizard-step__heading sr-only">
        Set startup costs
      </h2>
      <p className="wizard-step__lede">
        Rent and the timed startup costs for your launch. Each cost lands on the
        project month it’s spent.
      </p>

      {/* ---- Rent — editable $/sq ft (#245) ---- */}
      <div className="assumption" data-testid="assumption-rent">
        <label className="wizard__field" htmlFor="wizard-rent-per-sqft">
          Rent
          <NumberField
            id="wizard-rent-per-sqft"
            value={draft.rentPerSqft || null}
            onChange={(v) => state.setRentPerSqft(v ?? 0)}
            unit="$/sq ft/yr"
            unitPosition="suffix"
            decimals={2}
            min={0}
            aria-label="Rent per square foot per year"
          />
        </label>
        <p className="assumption__provenance" data-testid="rent-provenance">
          Enter your local $/sq ft (prefilled with a regional benchmark)
        </p>
      </div>

      {/* ---- Source of funds — ALWAYS visible; no client-computed total (Task 2.4) ---- */}
      <fieldset className="source-of-funds" data-testid="source-of-funds">
        <legend className="wizard-step__section-label">Source of funds</legend>

        <label className="wizard__field" htmlFor="wizard-cash">
          Cash
          <NumberField
            id="wizard-cash"
            value={draft.cash ?? null}
            onChange={(v) => state.set("cash", v ?? 0)}
            unit="$"
            unitPosition="prefix"
            decimals={0}
            min={0}
            aria-label="Cash on hand in dollars"
          />
        </label>

        <label className="wizard__field" htmlFor="wizard-grant">
          Grant
          <NumberField
            id="wizard-grant"
            value={draft.grant ?? null}
            onChange={(v) => state.set("grant", v ?? 0)}
            unit="$"
            unitPosition="prefix"
            decimals={0}
            min={0}
            aria-label="Grant funding in dollars"
          />
        </label>

        <label className="wizard__field" htmlFor="wizard-loan">
          Loan
          <NumberField
            id="wizard-loan"
            value={draft.loan ?? null}
            onChange={(v) => state.set("loan", v ?? 0)}
            unit="$"
            unitPosition="prefix"
            decimals={0}
            min={0}
            aria-label="Loan funding in dollars"
          />
        </label>

        <p className="source-of-funds__note">Totals are computed after Generate.</p>
      </fieldset>

      {/* ---- Rent & lease (Task 2.4) ---- */}
      <AdvancedOptions
        label={rentLeaseGroup.label}
        open={!!state.advancedOpen[advancedKey(STEP_KEY, rentLeaseGroup.id)]}
        onToggle={(open) => state.toggleAdvanced(STEP_KEY, rentLeaseGroup.id, open)}
      >
        <label className="wizard__field" htmlFor="wizard-escalator-pct">
          Rent escalator
          <NumberField
            id="wizard-escalator-pct"
            value={draft.escalatorPct ?? null}
            onChange={(v) => state.set("escalatorPct", v ?? 0)}
            unit="%"
            unitPosition="suffix"
            decimals={2}
            min={0}
            aria-label="Rent escalator percentage"
          />
        </label>
      </AdvancedOptions>

      {/* ---- Operating cost structure (Task 2.4) ---- */}
      <AdvancedOptions
        label={costStructureGroup.label}
        open={!!state.advancedOpen[advancedKey(STEP_KEY, costStructureGroup.id)]}
        onToggle={(open) => state.toggleAdvanced(STEP_KEY, costStructureGroup.id, open)}
      >
        <label className="wizard__field" htmlFor="wizard-labor-pct">
          Labor
          <NumberField
            id="wizard-labor-pct"
            value={draft.laborPct ?? null}
            onChange={(v) => state.set("laborPct", v ?? 0)}
            unit="%"
            unitPosition="suffix"
            decimals={2}
            min={0}
            aria-label="Labor percentage of revenue"
          />
        </label>

        <label className="wizard__field" htmlFor="wizard-marketing-pct">
          Marketing
          <NumberField
            id="wizard-marketing-pct"
            value={draft.marketingPct ?? null}
            onChange={(v) => state.set("marketingPct", v ?? 0)}
            unit="%"
            unitPosition="suffix"
            decimals={2}
            min={0}
            aria-label="Marketing percentage of revenue"
          />
        </label>

        <label className="wizard__field" htmlFor="wizard-supplies-pct">
          Supplies
          <NumberField
            id="wizard-supplies-pct"
            value={draft.suppliesPct ?? null}
            onChange={(v) => state.set("suppliesPct", v ?? 0)}
            unit="%"
            unitPosition="suffix"
            decimals={2}
            min={0}
            aria-label="Supplies percentage of revenue"
          />
        </label>

        <label className="wizard__field" htmlFor="wizard-card-pct">
          Card fees
          <NumberField
            id="wizard-card-pct"
            value={draft.cardPct ?? null}
            onChange={(v) => state.set("cardPct", v ?? 0)}
            unit="%"
            unitPosition="suffix"
            decimals={2}
            min={0}
            aria-label="Card fee percentage"
          />
        </label>

        <label className="wizard__field" htmlFor="wizard-payroll-tax-pct">
          Payroll tax
          <NumberField
            id="wizard-payroll-tax-pct"
            value={draft.payrollTaxPct ?? null}
            onChange={(v) => state.set("payrollTaxPct", v ?? 0)}
            unit="%"
            unitPosition="suffix"
            decimals={2}
            min={0}
            aria-label="Payroll tax percentage"
          />
        </label>

        {FIXED_ANNUAL_LINES.map((label) => (
          <label key={label} className="wizard__field" htmlFor={fixedAnnualId(label)}>
            {label}
            <NumberField
              id={fixedAnnualId(label)}
              value={fixedAnnual[label] ?? null}
              onChange={(v) =>
                state.set("fixedAnnual", { ...fixedAnnual, [label]: v ?? 0 })
              }
              unit="$/yr"
              unitPosition="suffix"
              decimals={0}
              min={0}
              aria-label={`${label} dollars per year`}
            />
          </label>
        ))}
      </AdvancedOptions>

      {/* ---- Funding & capital (Task 2.4) ---- */}
      <AdvancedOptions
        label={fundingGroup.label}
        open={!!state.advancedOpen[advancedKey(STEP_KEY, fundingGroup.id)]}
        onToggle={(open) => state.toggleAdvanced(STEP_KEY, fundingGroup.id, open)}
      >
        <label className="wizard__field" htmlFor="wizard-reserve-buffer">
          Reserve buffer
          <NumberField
            id="wizard-reserve-buffer"
            value={draft.reserveBuffer ?? null}
            onChange={(v) => state.set("reserveBuffer", v ?? 0)}
            unit="$"
            unitPosition="prefix"
            decimals={0}
            min={0}
            aria-label="Cash reserve buffer in dollars"
          />
        </label>

        <label className="wizard__field" htmlFor="wizard-sensitivity-delta-pct">
          Sensitivity stress
          <NumberField
            id="wizard-sensitivity-delta-pct"
            value={draft.sensitivityDeltaPct ?? null}
            onChange={(v) => state.set("sensitivityDeltaPct", v ?? 0)}
            unit="%"
            unitPosition="suffix"
            decimals={2}
            min={0}
            aria-label="Sensitivity stress percentage"
          />
        </label>
      </AdvancedOptions>

      {/* #32 — contextual "Upload consultant proposal" → Penny (graceful when AI off). */}
      {onUploadProposal && (
        <ProposalAffordance
          onUploadProposal={onUploadProposal}
          busy={proposalBusy}
          error={proposalError}
        />
      )}

      <h3 className="wizard-step__section-label">{timingGroup.label}</h3>
      <CostScheduleEditor
        rows={rows}
        openingMonthNumber={draft.openingMonthNumber ?? DEFAULT_OPENING_MONTH_NUMBER}
        totals={totals}
        onChangeRows={(next: CostScheduleRow[]) => state.set("costSchedule", next)}
        onChangeOpeningMonth={(v) => state.set("openingMonthNumber", v)}
      />

      {/* Task 2.5 (audit P1): the planning-estimates notice, above the Generate
          button that CreateProjectionPage renders right after this step (terms
          acceptance stays IMPLICIT — owner Decision 5 — this is a content notice,
          not the W8 terms checkbox). */}
      <p className="wizard__disclaimer">
        These figures are planning estimates, not financial advice.
      </p>
    </section>
  );
}

export default StepStartupCosts;

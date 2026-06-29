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
import { useEffect, useRef, useState } from "react";

import { previewCostSchedule, type CostSchedulePreview } from "../api/costSchedule";
import { CostScheduleEditor } from "../components/CostScheduleEditor";
import { assumptionSourceLabel } from "../components/displayLabels";
import { NumberField } from "../components/NumberField";
import { DEFAULT_OPENING_MONTH_NUMBER, type CostScheduleRow } from "./shareHelper";
import type { AssumptionSource, WizardState } from "./useWizardState";

/** The verified-vs-estimated badge for a RESEARCH-sourced rent (icon + text, never
 *  color-only). `verified` is the server's flag (fetched source survived AND
 *  confidence != low). */
function RentBadge({ verified }: { verified: boolean }) {
  return (
    <span
      className={`assumption__badge assumption__badge--${verified ? "verified" : "estimated"}`}
      data-testid="rent-badge"
      data-verified={verified ? "true" : "false"}
    >
      <span aria-hidden="true">{verified ? "✓" : "≈"}</span>{" "}
      {verified ? "Verified — local market sources" : "Estimated — regional benchmark"}
    </span>
  );
}

function provenanceText(source: AssumptionSource): string {
  return assumptionSourceLabel(source);
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
  const { draft, rentSource, rentResearch, rentResearchLoading, rentResearchError } = state;

  const lowConfidence = rentSource === "research" && rentResearch?.confidence === "low";
  const showManualNote = rentResearchError || rentResearch?.ai_enabled === false;

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

      {/* ---- Rent — research pre-filled, editable (#245) ---- */}
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
          {rentResearchLoading ? null : (
            <>
              <span className="assumption__source">{provenanceText(rentSource)}</span>
              {rentSource === "research" && rentResearch && (
                <>
                  {" · "}
                  <RentBadge verified={rentResearch.verified} />
                  {rentResearch.low != null && rentResearch.high != null && (
                    <span className="assumption__range">
                      {" · "}Range ${rentResearch.low}–${rentResearch.high}/sq ft
                    </span>
                  )}
                </>
              )}
            </>
          )}
        </p>

        {lowConfidence && (
          <p className="assumption__warn" data-testid="rent-low-confidence" role="note">
            <span aria-hidden="true">⚠</span> Low confidence — confirm this against a
            local quote before relying on it.
          </p>
        )}

        {showManualNote && (
          <p
            className="assumption__provenance assumption__provenance--manual"
            data-testid="rent-manual-note"
          >
            Couldn’t research local rent automatically — enter your own $/sq ft.
          </p>
        )}

        {rentSource === "research" &&
          rentResearch &&
          (rentResearch.sources?.length ?? 0) > 0 && (
            <details className="assumption__sources" data-testid="rent-sources">
              <summary>{rentResearch.sources.length} source(s)</summary>
              <ul>
                {rentResearch.sources.map((s, i) => (
                  <li key={`${s.url}-${i}`}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer">
                      {s.title || s.url}
                    </a>
                    {s.source_date ? <span> · {s.source_date}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          )}

      </div>

      {/* #32 — contextual "Upload consultant proposal" → Penny (graceful when AI off). */}
      {onUploadProposal && (
        <ProposalAffordance
          onUploadProposal={onUploadProposal}
          busy={proposalBusy}
          error={proposalError}
        />
      )}

      <CostScheduleEditor
        rows={rows}
        openingMonthNumber={draft.openingMonthNumber ?? DEFAULT_OPENING_MONTH_NUMBER}
        totals={totals}
        onChangeRows={(next: CostScheduleRow[]) => state.set("costSchedule", next)}
        onChangeOpeningMonth={(v) => state.set("openingMonthNumber", v)}
      />
    </section>
  );
}

export default StepStartupCosts;

// web/src/wizard/StepStartupCosts.tsx — wizard step 5 (last): set startup costs.
//
// The home for RENT (owner Decision 10): the #245 research-prefilled, editable
// $/sq ft rate with its verified-vs-estimated badge + sources sits ABOVE today's
// timed cost editor. Utilities & fixtures auto-seed the cost rows behind the scenes
// (set on the square-footage step), so only rent is surfaced here. The opening DATE
// field is gone (owner Decision 13 — `targetOpeningDate` dropped); the grand-opening
// month stays. The editor only COLLECTS rows; totals are derived SERVER-side — no
// client math (PRD §13 / Spec §5). The last-step primary button ("Generate
// projections") lives in CreateProjectionPage.
import { CostScheduleEditor } from "../components/CostScheduleEditor";
import { assumptionSourceLabel } from "../components/displayLabels";
import type { AssumptionSource, WizardState } from "./useWizardState";

/** A short "what would change this" hint shown under the rent estimate. */
const WHAT_CHANGES_RENT =
  "A signed lease or a local broker quote replaces this estimate — edit the field to use your real rate.";

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

export function StepStartupCosts({ state }: { state: WizardState }) {
  const { draft, rentSource, rentResearch, rentResearchLoading, rentResearchError } = state;

  const lowConfidence = rentSource === "research" && rentResearch?.confidence === "low";
  const showManualNote = rentResearchError || rentResearch?.ai_enabled === false;

  return (
    <section className="wizard-step" aria-labelledby="step-cost-heading">
      <h2 id="step-cost-heading" className="wizard-step__heading">
        Set startup costs
      </h2>
      <p className="wizard-step__lede">
        Rent and the timed startup costs for your launch. Each cost lands on the
        project month it’s spent.
      </p>

      {/* ---- Rent ($/sq ft/yr) — research pre-filled, editable (#245) ---- */}
      <div className="assumption" data-testid="assumption-rent">
        <label className="wizard__field" htmlFor="wizard-rent-per-sqft">
          Rent ($/sq ft/yr)
          <input
            id="wizard-rent-per-sqft"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={draft.rentPerSqft}
            onChange={(e) => state.setRentPerSqft(Number(e.target.value))}
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

        <p className="assumption__hint">{WHAT_CHANGES_RENT}</p>
      </div>

      <CostScheduleEditor
        rows={state.costSchedule}
        openingMonthNumber={state.draft.openingMonthNumber ?? 1}
        onAddRow={state.addCostRow}
        onUpdateRow={state.updateCostRow}
        onRemoveRow={state.removeCostRow}
        onChangeOpeningMonth={(v) => state.set("openingMonthNumber", v)}
      />
    </section>
  );
}

export default StepStartupCosts;

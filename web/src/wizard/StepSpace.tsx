// web/src/wizard/StepSpace.tsx — wizard step 3: Size & rent your space (#245).
//
// Collects building size + sales-floor fraction (entered as a percent, stored /100
// downstream), and the three sq-ft-scaled cost ASSUMPTIONS — rent, utilities, and
// fixtures ($/sq ft) — each STATED with its provenance (research|user|default, the
// same language as households_source) and each ADJUSTABLE. Rent is PRE-FILLED by a
// server /api/research call on the resolved location with a verified-vs-estimated
// badge + sources; with AI disabled / on failure it degrades to the regional
// benchmark and plain manual entry. NO client math — occupancy = sq ft × rent and
// the utilities line are derived by the engine; the client only collects inputs and
// renders the server's research result verbatim (PRD §13 / CLAUDE.md LLM-GROUNDING).
import { assumptionSourceLabel } from "../components/displayLabels";
import type { AssumptionSource, WizardState } from "./useWizardState";

/** A short "what would change this" hint shown under the rent estimate. */
const WHAT_CHANGES_RENT =
  "A signed lease or a local broker quote replaces this estimate — edit the field to use your real rate.";

function provenanceText(source: AssumptionSource): string {
  return assumptionSourceLabel(source);
}

/** The verified-vs-estimated badge for a RESEARCH-sourced rent (icon + text, never
 *  color-only). `verified` is the server's flag (fetched source survived AND
 *  confidence != low). */
function RentBadge({
  verified,
  confidence,
}: {
  verified: boolean;
  confidence: string;
}) {
  return (
    <span
      className={`assumption__badge assumption__badge--${verified ? "verified" : "estimated"}`}
      data-testid="rent-badge"
      data-verified={verified ? "true" : "false"}
    >
      <span aria-hidden="true">{verified ? "✓" : "≈"}</span>{" "}
      {verified
        ? "Verified — local market sources"
        : `Estimated — regional benchmark${confidence === "low" ? "" : ""}`}
    </span>
  );
}

export function StepSpace({ state }: { state: WizardState }) {
  const {
    draft,
    rentSource,
    utilitiesSource,
    fixturesSource,
    rentResearch,
    rentResearchLoading,
    rentResearchError,
  } = state;

  const lowConfidence =
    rentSource === "research" && rentResearch?.confidence === "low";
  const showManualNote = rentResearchError || rentResearch?.ai_enabled === false;

  return (
    <section className="wizard-step" aria-labelledby="step-space-heading">
      <h2 id="step-space-heading" className="wizard-step__heading">
        Size &amp; rent your space
      </h2>
      <p className="wizard-step__lede">
        Your store’s size drives occupancy, utilities, and build-out. We look up a
        representative market rent for your location — you can adjust every figure
        below, and each shows where the number came from.
      </p>

      {/* ---- Space ---- */}
      <label className="wizard__field" htmlFor="wizard-building-sqft">
        Building size (sq ft)
        <input
          id="wizard-building-sqft"
          type="number"
          inputMode="numeric"
          min={1}
          value={draft.buildingSqft || ""}
          onChange={(e) => state.setBuildingSqft(Number(e.target.value))}
        />
      </label>

      <label className="wizard__field" htmlFor="wizard-salesfloor-pct">
        Sales-floor area (% of building)
        <input
          id="wizard-salesfloor-pct"
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          value={draft.salesfloorPct || ""}
          onChange={(e) => state.setSalesfloorPct(Number(e.target.value))}
        />
        <span className="wizard__field-hint">
          The rest is back-of-house (sorting, storage, office).
        </span>
      </label>

      {/* ---- Sq-ft cost assumptions (research-derived, adjustable, provenance) ---- */}
      <fieldset className="space-assumptions" data-testid="space-assumptions">
        <legend>Space costs — adjustable, with their source</legend>

        {/* Rent ($/sq ft/yr) — research pre-filled */}
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
            {rentResearchLoading ? (
              <span>Looking up local market rent…</span>
            ) : (
              <>
                <span className="assumption__source">{provenanceText(rentSource)}</span>
                {rentSource === "research" && rentResearch && (
                  <>
                    {" · "}
                    <RentBadge
                      verified={rentResearch.verified}
                      confidence={rentResearch.confidence}
                    />
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
            <p
              className="assumption__warn"
              data-testid="rent-low-confidence"
              role="note"
            >
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

        {/* Utilities ($/sq ft/yr) */}
        <div className="assumption" data-testid="assumption-utilities">
          <label className="wizard__field" htmlFor="wizard-utilities-per-sqft">
            Utilities &amp; trash ($/sq ft/yr)
            <input
              id="wizard-utilities-per-sqft"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={draft.utilitiesPerSqft}
              onChange={(e) => state.setUtilitiesPerSqft(Number(e.target.value))}
            />
          </label>
          <p className="assumption__provenance" data-testid="utilities-provenance">
            <span className="assumption__source">{provenanceText(utilitiesSource)}</span>
          </p>
        </div>

        {/* Fixtures ($/sq ft, one-time) */}
        <div className="assumption" data-testid="assumption-fixtures">
          <label className="wizard__field" htmlFor="wizard-fixtures-per-sqft">
            Fixtures &amp; equipment ($/sq ft, one-time)
            <input
              id="wizard-fixtures-per-sqft"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={draft.fixturesPerSqft}
              onChange={(e) => state.setFixturesPerSqft(Number(e.target.value))}
            />
          </label>
          <p className="assumption__provenance" data-testid="fixtures-provenance">
            <span className="assumption__source">{provenanceText(fixturesSource)}</span>
            <span className="assumption__hint">
              {" "}
              · seeds the Equipment &amp; Fixtures / Build-out cost lines (editable on
              the next step).
            </span>
          </p>
        </div>
      </fieldset>
    </section>
  );
}

export default StepSpace;

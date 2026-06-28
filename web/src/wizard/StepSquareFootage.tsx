// web/src/wizard/StepSquareFootage.tsx — wizard step 2: set the square footage.
//
// Building size + sales-floor fraction ONLY (owner Decision 10). Defaults are
// 12,500 sq ft / 80%. These seed the startup-cost values on load behind the scenes
// (the #245 per-sq-ft mirror scales Equipment & Fixtures + Build-out; utilities are
// derived server-side from sq ft). Rent lives on the startup-costs step now; this
// step never shows the rent/utilities/fixtures rates. NO client math — the engine
// derives occupancy, the utilities line, and the cost-schedule seed (PRD §13).
import type { WizardState } from "./useWizardState";

export function StepSquareFootage({ state }: { state: WizardState }) {
  const { draft } = state;

  return (
    <section className="wizard-step" aria-labelledby="step-sqft-heading">
      <h2 id="step-sqft-heading" className="wizard-step__heading">
        Set square footage
      </h2>
      <p className="wizard-step__lede">
        Your store’s size drives occupancy, utilities, and build-out.
      </p>

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
    </section>
  );
}

export default StepSquareFootage;

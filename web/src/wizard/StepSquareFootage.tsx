// web/src/wizard/StepSquareFootage.tsx — wizard step 2: set the square footage.
//
// Building size + sales-floor fraction ONLY (owner Decision 10). Defaults are
// 12,500 sq ft / 80%. These seed the startup-cost values on load behind the scenes
// (the #245 per-sq-ft mirror scales Equipment & Fixtures + Build-out; utilities are
// derived server-side from sq ft). Rent lives on the startup-costs step now; this
// step never shows the rent/utilities/fixtures rates. NO client math — the engine
// derives occupancy, the utilities line, and the cost-schedule seed (PRD §13).
import { NumberField } from "../components/NumberField";
import type { WizardState } from "./useWizardState";

export function StepSquareFootage({ state }: { state: WizardState }) {
  const { draft } = state;

  return (
    <section className="wizard-step" aria-labelledby="step-sqft-heading">
      <h2 id="step-sqft-heading" className="wizard-step__heading sr-only">
        Set square footage
      </h2>
      <p className="wizard-step__lede">
        Your store's size drives occupancy, utilities, and build-out.
      </p>

      <label className="wizard__field" htmlFor="wizard-building-sqft">
        Building size
        <NumberField
          id="wizard-building-sqft"
          value={draft.buildingSqft || null}
          onChange={(n) => state.setBuildingSqft(n ?? 0)}
          unit="sqft"
          unitPosition="suffix"
          thousands
          min={1}
          decimals={0}
          aria-label="Building size in square feet"
        />
      </label>

      <label className="wizard__field" htmlFor="wizard-salesfloor-pct">
        Sales-floor area
        <NumberField
          id="wizard-salesfloor-pct"
          value={draft.salesfloorPct || null}
          onChange={(n) => state.setSalesfloorPct(n ?? 0)}
          unit="%"
          unitPosition="suffix"
          min={1}
          decimals={0}
          aria-label="Sales-floor area as percentage of building"
        />
        <span className="wizard__field-hint">
          The rest is back-of-house (sorting, storage, office).
        </span>
      </label>
    </section>
  );
}

export default StepSquareFootage;

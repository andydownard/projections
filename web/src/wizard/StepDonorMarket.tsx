// web/src/wizard/StepDonorMarket.tsx — wizard step 3: donor-market share.
//
// Three EXPLICIT Year-1/2/3 donor-market shares (PRD §7.1 — never an
// auto-midpoint) with a benchmark note. The shares are sent as inputs; the
// resulting donations/revenue are computed server-side (PRD §13).
import type { WizardState } from "./useWizardState";

type ShareKey = "shareY1" | "shareY2" | "shareY3";
const SHARES: ReadonlyArray<{ key: ShareKey; label: string }> = [
  { key: "shareY1", label: "Year 1 share (%)" },
  { key: "shareY2", label: "Year 2 share (%)" },
  { key: "shareY3", label: "Year 3 share (%)" },
];

export function StepDonorMarket({ state }: { state: WizardState }) {
  return (
    <section className="wizard-step" aria-labelledby="step-donor-heading">
      <h2 id="step-donor-heading" className="wizard-step__heading">
        Donor market
      </h2>
      <p className="wizard-step__lede">
        What share of trade-area households donate each year? Set three explicit
        annual shares — they ramp as awareness grows.
      </p>

      {SHARES.map((f) => (
        <label key={f.key} className="wizard__field">
          {f.label}
          <input
            type="number"
            value={state.draft[f.key]}
            onChange={(e) => state.set(f.key, Number(e.target.value))}
          />
        </label>
      ))}

      <p className="wizard-step__note" data-testid="donor-benchmark">
        Benchmark: a new store typically captures ~6–8% of trade-area households
        in Year 1, climbing toward ~10% by Year 3 as it becomes established.
      </p>
    </section>
  );
}

export default StepDonorMarket;

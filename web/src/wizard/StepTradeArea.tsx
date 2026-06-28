// web/src/wizard/StepTradeArea.tsx — wizard step 2: trade-area households.
//
// Households is EMPTY + DISABLED until an address resolves (§4). On resolve it
// fills with the Census count + a City/County basis toggle + provenance; the
// user may overwrite it (-> user_edited). A Places/Census failure makes the
// field manually editable (-> manual). No client math — the count is the
// server-derived Census value, editable by the operator (PRD §13).
import type { WizardState } from "./useWizardState";

const BASES = ["city", "county"] as const;

export function StepTradeArea({ state }: { state: WizardState }) {
  const { resolved, basis, householdsValue, householdsDisabled, householdsSource } = state;

  return (
    <section className="wizard-step" aria-labelledby="step-trade-heading">
      <h2 id="step-trade-heading" className="wizard-step__heading">
        Find your trade area
      </h2>
      <p className="wizard-step__lede">
        The number of households in the store’s trade area drives donations and
        sales. It’s filled from the U.S. Census once an address resolves — you
        can switch the basis or overwrite it.
      </p>

      <div className="wizard__field places__households">
        <label className="places__households-label" htmlFor="wizard-households">
          Households (trade area)
        </label>

        {resolved && (
          <div className="places__basis" role="group" aria-label="Trade-area basis">
            {BASES.map((b) =>
              resolved.trade_area.alternatives[b] ? (
                <button
                  key={b}
                  type="button"
                  className={
                    basis === b
                      ? "places__basis-btn places__basis-btn--on"
                      : "places__basis-btn"
                  }
                  aria-pressed={basis === b}
                  onClick={() => state.applyBasis(b)}
                >
                  {b === "city" ? "City" : "County"}
                </button>
              ) : null,
            )}
          </div>
        )}

        <input
          id="wizard-households"
          type="number"
          inputMode="numeric"
          disabled={householdsDisabled}
          aria-disabled={householdsDisabled}
          placeholder={
            householdsDisabled ? "Select an address to look up households…" : ""
          }
          value={householdsValue ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") return;
            state.setHouseholds(Number(v));
          }}
        />

        {resolved && householdsSource === "census_acs" && householdsValue !== null && (
          <p className="places__provenance">
            {householdsValue} households · {resolved.trade_area.geography_name} · U.S.
            Census ACS {resolved.trade_area.acs_vintage}
            {resolved.trade_area.moe !== null ? ` · ±${resolved.trade_area.moe} (MOE)` : ""} ·
            estimate
          </p>
        )}
        {householdsSource === "user_edited" && (
          <p className="places__provenance places__provenance--edited">
            Edited — overrides the Census estimate.
          </p>
        )}
        {householdsSource === "manual" && (
          <p className="places__provenance places__provenance--error">
            Couldn’t look up that location automatically — enter households manually.
          </p>
        )}
      </div>
    </section>
  );
}

export default StepTradeArea;

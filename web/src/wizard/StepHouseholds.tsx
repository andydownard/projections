// web/src/wizard/StepHouseholds.tsx — wizard step 3: confirm the # of households.
//
// The household count resolves from the address on step 1 (§4); here the operator
// just CONFIRMS it. On load the resolved number renders as static text with a pencil
// EDIT icon (owner Decision 25) — not an input field — and clicking the pencil reveals
// the editable input. A Places/Census failure (manual fallback) shows the input
// directly. The words "trade area" never appear in UI (owner Decision 8/16 — the
// `trade_area` code identifier is unchanged). No client math — the count is the
// server-derived Census value, editable by the operator (PRD §13).
import { useState } from "react";

import { formatCount } from "../format";
import type { WizardState } from "./useWizardState";

const BASES = ["city", "county"] as const;

export function StepHouseholds({ state }: { state: WizardState }) {
  const { resolved, basis, householdsValue, householdsDisabled, householdsSource } = state;
  const [editing, setEditing] = useState(false);

  // Show the input when the operator is editing, or when there is no resolved
  // number yet (the manual-fallback path enters the count by hand).
  const showInput = editing || householdsValue == null;

  return (
    <section className="wizard-step" aria-labelledby="step-households-heading">
      <h2 id="step-households-heading" className="wizard-step__heading">
        Confirm # of households
      </h2>
      <p className="wizard-step__lede">
        This is how many households are near your store. We pulled it from the U.S.
        Census — edit it if you have a better number.
      </p>

      <div className="wizard__field places__households">
        {!showInput && householdsValue != null ? (
          <div className="households-confirm" data-testid="households-confirm">
            <span className="households-confirm__value">
              {formatCount(householdsValue)} households
            </span>
            <button
              type="button"
              className="wizard-edit-btn"
              aria-label="Edit households"
              onClick={() => setEditing(true)}
            >
              <span aria-hidden="true">✎</span>
            </button>
          </div>
        ) : (
          <>
            <label className="places__households-label" htmlFor="wizard-households">
              Households
            </label>

            {resolved && (
              <div className="places__basis" role="group" aria-label="Household geography">
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
              type="text"
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
          </>
        )}

        {householdsSource === "census_acs" && householdsValue !== null && resolved && (
          <p className="places__provenance">
            {formatCount(householdsValue)} households · {resolved.trade_area.geography_name} ·
            U.S. Census ACS {resolved.trade_area.acs_vintage}
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

export default StepHouseholds;

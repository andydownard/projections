// web/src/wizard/StepDonorMarket.tsx — wizard step 4: set the donor market share.
//
// Three EXPLICIT Year-1/2/3 donor-market shares (PRD §7.1 — never an auto-midpoint),
// shown as three SMALL side-by-side fields with the "%" glued to the number, not the
// label (owner Decision 26/27/28). On load the values render as static "6% / 8% / 10%"
// with a pencil EDIT icon; the pencil reveals the editable inputs (no leading zero
// when typing — a plain numeric input never keeps one). The shares are sent as inputs;
// the resulting donations/revenue are computed server-side (PRD §13).
import { useState } from "react";

import type { WizardState } from "./useWizardState";

type ShareKey = "shareY1" | "shareY2" | "shareY3";
const SHARES: ReadonlyArray<{ key: ShareKey; label: string }> = [
  { key: "shareY1", label: "Year 1" },
  { key: "shareY2", label: "Year 2" },
  { key: "shareY3", label: "Year 3" },
];

export function StepDonorMarket({ state }: { state: WizardState }) {
  const [editing, setEditing] = useState(false);

  return (
    <section className="wizard-step" aria-labelledby="step-donor-heading">
      <h2 id="step-donor-heading" className="wizard-step__heading">
        Set donor market share
      </h2>
      <p className="wizard-step__lede">The fraction of donations captured each year.</p>

      <div className="donor-shares" data-testid="donor-shares">
        {SHARES.map((f) => (
          <div key={f.key} className="donor-share">
            <span className="donor-share__label" id={`donor-${f.key}-label`}>
              {f.label}
            </span>
            {editing ? (
              <span className="donor-share__field">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  className="donor-share__input"
                  aria-labelledby={`donor-${f.key}-label`}
                  value={state.draft[f.key]}
                  onChange={(e) => state.set(f.key, Number(e.target.value))}
                />
                <span className="donor-share__suffix" aria-hidden="true">
                  %
                </span>
              </span>
            ) : (
              <span className="donor-share__value">{state.draft[f.key]}%</span>
            )}
          </div>
        ))}

        {!editing && (
          <button
            type="button"
            className="wizard-edit-btn"
            aria-label="Edit donor market share"
            onClick={() => setEditing(true)}
          >
            <span aria-hidden="true">✎</span>
          </button>
        )}
      </div>
    </section>
  );
}

export default StepDonorMarket;

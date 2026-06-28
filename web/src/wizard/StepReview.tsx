// web/src/wizard/StepReview.tsx — wizard step 5: review → Generate.
//
// A read-back of the collected inputs before Generate. It shows NO computed
// projection numbers (those come from the server compute on Generate, PRD §13)
// — only the raw inputs the operator entered, plus the terms acceptance gate.
//
// Trade-area `basis` and the households `source` are internal enum codes; they are
// humanized for display (basisLabel / householdsSourceLabel) so a non-finance ED
// reads "County" / "U.S. Census" on the confirm screen, never "county"/"census_acs"
// (#151 — keep raw enum codes off-screen).
import {
  assumptionSourceLabel,
  basisLabel,
  householdsSourceLabel,
} from "../components/displayLabels";
import { formatCount } from "../format";
import type { WizardState } from "./useWizardState";

export function StepReview({ state }: { state: WizardState }) {
  const { draft, householdsValue, householdsSource, rentSource } = state;

  return (
    <section className="wizard-step" aria-labelledby="step-review-heading">
      <h2 id="step-review-heading" className="wizard-step__heading">
        Review &amp; generate
      </h2>
      <p className="wizard-step__lede">
        Confirm the inputs below, then generate the projection. The numbers are
        computed on the server and shown on the next screen.
      </p>

      <dl className="wizard-review">
        <div className="wizard-review__row">
          <dt>Store</dt>
          <dd>{draft.name || "—"}</dd>
        </div>
        <div className="wizard-review__row">
          <dt>Location</dt>
          <dd>{draft.city || "—"}</dd>
        </div>
        <div className="wizard-review__row">
          <dt>Households ({basisLabel(draft.basis)})</dt>
          <dd>
            {householdsValue != null ? formatCount(householdsValue) : "—"}
            {householdsSource ? ` (${householdsSourceLabel(householdsSource)})` : ""}
          </dd>
        </div>
        <div className="wizard-review__row">
          <dt>Space (building / sales floor)</dt>
          <dd>
            {formatCount(draft.buildingSqft)} sq ft · {draft.salesfloorPct}% sales floor
          </dd>
        </div>
        <div className="wizard-review__row">
          <dt>Rent ($/sq ft/yr)</dt>
          <dd>
            ${draft.rentPerSqft}
            {rentSource ? ` (${assumptionSourceLabel(rentSource)})` : ""}
          </dd>
        </div>
        <div className="wizard-review__row">
          <dt>Donor-market share (Y1 / Y2 / Y3)</dt>
          <dd>
            {draft.shareY1}% / {draft.shareY2}% / {draft.shareY3}%
          </dd>
        </div>
        <div className="wizard-review__row">
          <dt>Grand-opening month #</dt>
          <dd>{draft.openingMonthNumber ?? 1}</dd>
        </div>
        <div className="wizard-review__row">
          <dt>Cost schedule rows</dt>
          <dd>{state.costSchedule.length}</dd>
        </div>
      </dl>

      <label className="wizard__field wizard__terms">
        <input
          type="checkbox"
          checked={draft.termsAccepted}
          onChange={(e) => state.set("termsAccepted", e.target.checked)}
        />
        I understand these are planning estimates, not financial advice.
      </label>
    </section>
  );
}

export default StepReview;

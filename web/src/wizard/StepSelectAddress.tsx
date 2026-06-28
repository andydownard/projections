// web/src/wizard/StepSelectAddress.tsx — wizard step 1: select the store address.
//
// The ADDRESS is mandatory (owner Decision 14/24): a Places autocomplete combobox;
// picking a prediction kicks off the SERVER-side Places->Census resolve (the key
// never reaches the client), which populates the household count confirmed on a
// later step (§4). The STORE NAME is OPTIONAL and sits BENEATH the address — it
// defaults to the address server-side, and duplicate names are fine (a projection's
// identity is its view_slug, never its name).
import { PlacesAutocomplete } from "../components/PlacesAutocomplete";
import type { WizardState } from "./useWizardState";

export function StepSelectAddress({ state }: { state: WizardState }) {
  return (
    <section className="wizard-step" aria-labelledby="step-address-heading">
      <h2 id="step-address-heading" className="wizard-step__heading">
        Select address
      </h2>
      <p className="wizard-step__lede">Pick a city or a street address.</p>

      <PlacesAutocomplete
        label="Address"
        basis={state.basis}
        onResolved={state.onResolved}
        onError={state.onResolveError}
      />

      <label className="wizard__field wizard__field--optional">
        Store name (optional)
        <input
          type="text"
          value={state.draft.name}
          placeholder="Defaults to the address"
          onChange={(e) => state.set("name", e.target.value)}
        />
      </label>
    </section>
  );
}

export default StepSelectAddress;

// web/src/wizard/StepStore.tsx — wizard step 1: store name + address.
//
// The address is the Places autocomplete combobox; picking a prediction kicks
// off the SERVER-side Places->Census resolve (the key never reaches the client)
// which populates the trade-area households on the next step (§4).
import { PlacesAutocomplete } from "../components/PlacesAutocomplete";
import type { WizardState } from "./useWizardState";

export function StepStore({ state }: { state: WizardState }) {
  return (
    <section className="wizard-step" aria-labelledby="step-store-heading">
      <h2 id="step-store-heading" className="wizard-step__heading">
        Name your store
      </h2>
      <p className="wizard-step__lede">
        Name the store and find its address — we pull the trade-area households
        from the U.S. Census once an address resolves.
      </p>

      <label className="wizard__field">
        Store name
        <input
          type="text"
          value={state.draft.name}
          onChange={(e) => state.set("name", e.target.value)}
        />
      </label>

      <PlacesAutocomplete
        label="Store address"
        basis={state.basis}
        onResolved={state.onResolved}
        onError={state.onResolveError}
      />
    </section>
  );
}

export default StepStore;

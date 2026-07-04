// web/src/wizard/StepSquareFootage.tsx — wizard step 2: set the square footage.
//
// Building size + sales-floor fraction ONLY (owner Decision 10). Defaults are
// 12,500 sq ft / 80%. These seed the startup-cost values on load behind the scenes
// (the #245 per-sq-ft mirror scales Equipment & Fixtures + Build-out; utilities are
// derived server-side from sq ft). Rent lives on the startup-costs step now; this
// step never shows the rent/utilities/fixtures rates ABOVE the fold. NO client math
// — the engine derives occupancy, the utilities line, and the cost-schedule seed
// (PRD §13).
//
// Task 2.2 (Wave 2): an Advanced Options group ("Space & occupancy rates", the
// shared paramGroups.ts "space-rates" taxonomy entry, closed by default) surfaces
// the utilities/fixtures/build-out $/sq ft rates, lease type, and — only when
// leaseType is "nnn" — the NNN operating-expense $/yr line. Utilities/fixtures
// each show their AssumptionSource provenance, the same pattern StepStartupCosts
// uses for the rent field.
import { AdvancedOptions } from "../components/AdvancedOptions";
import { assumptionSourceLabel } from "../components/displayLabels";
import { NumberField } from "../components/NumberField";
import type { LeaseType } from "./shareHelper";
import { groupsForStep } from "./paramGroups";
import { advancedKey } from "./useWizardState";
import type { WizardState } from "./useWizardState";

const STEP_KEY = "square-footage" as const;

export function StepSquareFootage({ state }: { state: WizardState }) {
  const { draft } = state;
  const [spaceRatesGroup] = groupsForStep(STEP_KEY);

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

      <AdvancedOptions
        label={spaceRatesGroup.label}
        open={!!state.advancedOpen[advancedKey(STEP_KEY, spaceRatesGroup.id)]}
        onToggle={(open) => state.toggleAdvanced(STEP_KEY, spaceRatesGroup.id, open)}
      >
        <label className="wizard__field" htmlFor="wizard-utilities-per-sqft">
          Utilities
          <NumberField
            id="wizard-utilities-per-sqft"
            value={draft.utilitiesPerSqft ?? null}
            onChange={(n) => state.setUtilitiesPerSqft(n ?? 0)}
            unit="$/sqft/yr"
            unitPosition="suffix"
            decimals={2}
            min={0}
            aria-label="Utilities per square foot per year"
          />
          <p className="assumption__provenance" data-testid="utilities-provenance">
            <span className="assumption__source">
              {assumptionSourceLabel(state.utilitiesSource)}
            </span>
          </p>
        </label>

        <label className="wizard__field" htmlFor="wizard-fixtures-per-sqft">
          Fixtures
          <NumberField
            id="wizard-fixtures-per-sqft"
            value={draft.fixturesPerSqft ?? null}
            onChange={(n) => state.setFixturesPerSqft(n ?? 0)}
            unit="$/sqft"
            unitPosition="suffix"
            decimals={2}
            min={0}
            aria-label="Fixtures per square foot"
          />
          <p className="assumption__provenance" data-testid="fixtures-provenance">
            <span className="assumption__source">
              {assumptionSourceLabel(state.fixturesSource)}
            </span>
          </p>
        </label>

        <label className="wizard__field" htmlFor="wizard-buildout-per-sqft">
          Build-out
          <NumberField
            id="wizard-buildout-per-sqft"
            value={draft.buildoutPerSqft ?? null}
            onChange={(n) => state.setBuildoutPerSqft(n ?? 0)}
            unit="$/sqft"
            unitPosition="suffix"
            decimals={2}
            min={0}
            aria-label="Build-out per square foot"
          />
        </label>

        <label className="wizard__field" htmlFor="wizard-lease-type">
          Lease type
          <select
            id="wizard-lease-type"
            value={draft.leaseType}
            onChange={(e) => state.set("leaseType", e.target.value as LeaseType)}
          >
            <option value="gross">Gross</option>
            <option value="nnn">NNN (triple net)</option>
          </select>
        </label>

        {draft.leaseType === "nnn" && (
          <label className="wizard__field" htmlFor="wizard-nnn-opex-annual">
            NNN operating expenses
            <NumberField
              id="wizard-nnn-opex-annual"
              value={draft.nnnOpexAnnual ?? null}
              onChange={(n) => state.set("nnnOpexAnnual", n ?? 0)}
              unit="$/yr"
              unitPosition="suffix"
              decimals={0}
              min={0}
              aria-label="NNN operating expenses per year"
            />
          </label>
        )}
      </AdvancedOptions>
    </section>
  );
}

export default StepSquareFootage;

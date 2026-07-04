// web/src/wizard/StepConfigureDonations.tsx — wizard "Configure donations" step (W15).
//
// Merges the former Confirm-households and Donor-market-share steps into one step and
// adds a $/donation field (owner Decision 4 / E2). Three sub-sections:
// (a) confirm # households (Census-resolved count, pencil to edit),
// (b) donor market share for each of the 5 years (compact NumberField unit="%"),
// (c) $/donation (default $50, NumberField with decimals=2).
// No client math — inputs only (PRD §13).
//
// Task 2.3 (Wave 2): an Advanced Options group ("Donation economics", the shared
// paramGroups.ts "donation-econ" taxonomy entry, closed by default) surfaces the
// average basket value (previously a dead field — now real), donations/household/yr,
// and salvage % of retail.
import { useState } from "react";

import { AdvancedOptions } from "../components/AdvancedOptions";
import { NumberField } from "../components/NumberField";
import { formatCount } from "../format";
import { groupsForStep } from "./paramGroups";
import { advancedKey } from "./useWizardState";
import type { WizardState } from "./useWizardState";

const STEP_KEY = "configure-donations" as const;

const BASES = ["city", "county"] as const;

type ShareKey = "shareY1" | "shareY2" | "shareY3" | "shareY4" | "shareY5";
const SHARES: ReadonlyArray<{ key: ShareKey; label: string; id: string }> = [
  { key: "shareY1", label: "Year 1", id: "donor-y1" },
  { key: "shareY2", label: "Year 2", id: "donor-y2" },
  { key: "shareY3", label: "Year 3", id: "donor-y3" },
  { key: "shareY4", label: "Year 4", id: "donor-y4" },
  { key: "shareY5", label: "Year 5", id: "donor-y5" },
];

export function StepConfigureDonations({ state }: { state: WizardState }) {
  const { draft, resolved, basis, householdsValue, householdsDisabled, householdsSource } = state;
  const [editingHouseholds, setEditingHouseholds] = useState(false);
  const [donationEconGroup] = groupsForStep(STEP_KEY);

  const showHouseholdsInput = editingHouseholds || householdsValue == null;

  return (
    <section className="wizard-step" aria-labelledby="step-donations-heading">
      <h2 id="step-donations-heading" className="wizard-step__heading sr-only">
        Configure donations
      </h2>

      {/* (a) Confirm households */}
      <div className="wizard__field places__households">
        <span className="wizard-step__section-label">Nearby households</span>
        {!showHouseholdsInput && householdsValue != null ? (
          <div className="households-confirm" data-testid="households-confirm">
            <span className="households-confirm__value">
              {formatCount(householdsValue)} households
            </span>
            <button
              type="button"
              className="wizard-edit-btn"
              aria-label="Edit households"
              onClick={() => setEditingHouseholds(true)}
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
            Couldn't look up that location automatically — enter households manually.
          </p>
        )}
      </div>

      {/* (b) Donor market share — 5 years */}
      <fieldset className="donor-shares" data-testid="donor-shares">
        <legend className="wizard-step__section-label">Donor market share</legend>
        {SHARES.map((f) => (
          <div key={f.key} className="donor-share">
            <label className="donor-share__label" htmlFor={f.id}>
              {f.label}
            </label>
            <NumberField
              id={f.id}
              value={state.draft[f.key]}
              onChange={(v) => state.set(f.key, v ?? 0)}
              unit="%"
              unitPosition="suffix"
              decimals={0}
              min={0}
              aria-label={`${f.label} donor market share`}
            />
          </div>
        ))}
      </fieldset>

      {/* (c) $/donation */}
      <label className="wizard__field" htmlFor="wizard-donation-value">
        $ per donation
        <NumberField
          id="wizard-donation-value"
          value={state.draft.donationValue}
          onChange={(v) => state.set("donationValue", v ?? 0)}
          unit="$"
          unitPosition="prefix"
          decimals={2}
          min={0}
          aria-label="Dollars per donation"
        />
      </label>

      <AdvancedOptions
        label={donationEconGroup.label}
        open={!!state.advancedOpen[advancedKey(STEP_KEY, donationEconGroup.id)]}
        onToggle={(open) => state.toggleAdvanced(STEP_KEY, donationEconGroup.id, open)}
      >
        <label className="wizard__field" htmlFor="wizard-basket">
          Average basket
          <NumberField
            id="wizard-basket"
            value={draft.basket ?? null}
            onChange={(v) => state.set("basket", v ?? 0)}
            unit="$"
            unitPosition="prefix"
            decimals={2}
            min={0}
            aria-label="Average basket value in dollars"
          />
        </label>

        <label className="wizard__field" htmlFor="wizard-donations-per-hh">
          Donations per household
          <NumberField
            id="wizard-donations-per-hh"
            value={draft.donationsPerHh ?? null}
            onChange={(v) => state.set("donationsPerHh", v ?? 0)}
            unit="/yr"
            unitPosition="suffix"
            decimals={0}
            min={0}
            aria-label="Donations per household per year"
          />
        </label>

        <label className="wizard__field" htmlFor="wizard-salvage-pct">
          Salvage
          <NumberField
            id="wizard-salvage-pct"
            value={draft.salvagePct ?? null}
            onChange={(v) => state.set("salvagePct", v ?? 0)}
            unit="%"
            unitPosition="suffix"
            decimals={2}
            min={0}
            aria-label="Salvage percentage of retail"
          />
        </label>
      </AdvancedOptions>
    </section>
  );
}

export default StepConfigureDonations;

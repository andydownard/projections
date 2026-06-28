// web/src/wizard/StepReview.test.tsx — the wizard's final confirm screen.
//
// The Review step is the last thing a non-finance ED reads before Generate, so it
// must NOT surface internal enum codes: the trade-area `basis` and households
// `source` are humanized (basisLabel / householdsSourceLabel), never shown raw
// ("county" / "census_acs") (#151 — keep raw enum codes off-screen).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StepReview } from "./StepReview";
import { DEFAULT_DRAFT, type HouseholdsSource, type WizardState } from "./useWizardState";

/** A minimal WizardState carrying only what StepReview reads. */
function makeState(over: {
  basis?: string;
  householdsValue?: number | null;
  householdsSource?: HouseholdsSource | null;
}): WizardState {
  return {
    draft: { ...DEFAULT_DRAFT, name: "House of Hope", basis: (over.basis ?? "city") as never },
    householdsValue: over.householdsValue ?? 512000,
    householdsSource: over.householdsSource ?? "census_acs",
    costSchedule: DEFAULT_DRAFT.costSchedule ?? [],
    set: () => {},
  } as unknown as WizardState;
}

describe("StepReview — humanizes enum codes for a non-finance ED (#151)", () => {
  it("renders the basis as a human label, never the raw enum code", () => {
    render(<StepReview state={makeState({ basis: "county" })} />);
    expect(screen.getByText(/Households \(County\)/)).toBeInTheDocument();
    expect(screen.queryByText(/\(county\)/)).not.toBeInTheDocument();
  });

  it("renders the households source as a friendly label (census_acs → U.S. Census)", () => {
    render(<StepReview state={makeState({ householdsSource: "census_acs" })} />);
    expect(screen.getByText(/U\.S\. Census/)).toBeInTheDocument();
    expect(screen.queryByText(/census_acs/)).not.toBeInTheDocument();
  });

  it("labels an edited households value as 'Edited', not the raw enum", () => {
    render(<StepReview state={makeState({ householdsSource: "user_edited" })} />);
    expect(screen.getByText(/Edited/)).toBeInTheDocument();
    expect(screen.queryByText(/user_edited/)).not.toBeInTheDocument();
  });

  it("labels a manually entered households value as 'Entered manually'", () => {
    render(<StepReview state={makeState({ householdsSource: "manual" })} />);
    expect(screen.getByText(/Entered manually/)).toBeInTheDocument();
  });
});

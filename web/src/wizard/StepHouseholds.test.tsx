import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { StepHouseholds } from "./StepHouseholds";
import type { WizardState } from "./useWizardState";
import type { TradeAreaResolved } from "../api/places";

// owner Decisions 8/16/25: the resolved count renders as static text + a pencil edit
// icon (not an input on load); the words "trade area" never appear; a manual fallback
// shows the input directly.
const RESOLVED = {
  location: { place_id: "PID", lat: 0, lng: 0, formatted_address: "Dallas, TX, USA" },
  trade_area: {
    basis: "city", households: 31798, geography_name: "Dallas city",
    geography_fips: "1", acs_vintage: "2022", households_source: "census_acs", moe: 412,
    alternatives: { city: { geography_name: "Dallas city", fips: "1", households: 31798, moe: 412 } },
  },
  evidence: {} as TradeAreaResolved["evidence"],
} as unknown as TradeAreaResolved;

function mockState(over: Partial<WizardState> = {}): WizardState {
  return {
    resolved: RESOLVED,
    basis: "city",
    householdsValue: 31798,
    householdsDisabled: false,
    householdsSource: "census_acs",
    applyBasis: vi.fn(),
    setHouseholds: vi.fn(),
    ...over,
  } as unknown as WizardState;
}

describe("StepHouseholds", () => {
  it("renders the count as static text + a pencil edit icon (not an input on load)", async () => {
    const user = userEvent.setup();
    render(<StepHouseholds state={mockState()} />);
    expect(screen.getByTestId("households-confirm")).toHaveTextContent(/31,798 households/i);
    expect(screen.queryByLabelText(/^households$/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: /edit households/i }));
    expect(screen.getByLabelText(/^households$/i)).toBeInTheDocument();
  });

  it("never says 'trade area' anywhere in the UI", () => {
    const { container } = render(<StepHouseholds state={mockState()} />);
    expect(container.textContent?.toLowerCase()).not.toContain("trade area");
  });

  it("shows the input directly on the manual-fallback path", () => {
    render(
      <StepHouseholds
        state={mockState({ resolved: null, householdsValue: null, householdsSource: "manual" })}
      />,
    );
    expect(screen.getByLabelText(/^households$/i)).toBeInTheDocument();
    expect(screen.getByText(/enter households manually/i)).toBeInTheDocument();
  });
});

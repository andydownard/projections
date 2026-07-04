import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { StepConfigureDonations } from "./StepConfigureDonations";
import { advancedKey } from "./useWizardState";
import type { WizardState } from "./useWizardState";
import type { WizardDraft } from "./shareHelper";
import type { TradeAreaResolved } from "../api/places";

const RESOLVED = {
  location: { place_id: "PID", lat: 0, lng: 0, formatted_address: "Dallas, TX, USA" },
  trade_area: {
    basis: "city", households: 31798, geography_name: "Dallas city",
    geography_fips: "1", acs_vintage: "2022", households_source: "census_acs", moe: 412,
    alternatives: { city: { geography_name: "Dallas city", fips: "1", households: 31798, moe: 412 } },
  },
  evidence: {} as TradeAreaResolved["evidence"],
} as unknown as TradeAreaResolved;

const BASE_DRAFT: Partial<WizardDraft> = {
  shareY1: 6, shareY2: 8, shareY3: 10,
  shareY4: 11, shareY5: 12,
  donationValue: 50,
  basket: 17.08,
  donationsPerHh: 3,
  salvagePct: 0.8,
};

interface MockOverrides extends Partial<Omit<WizardState, "draft">> {
  draft?: Partial<WizardDraft>;
}

function mockState(over: MockOverrides = {}): WizardState {
  const { draft: draftOverride, ...rest } = over;
  return {
    draft: { ...BASE_DRAFT, ...draftOverride },
    set: vi.fn(),
    resolved: RESOLVED,
    basis: "city",
    householdsValue: 31798,
    householdsDisabled: false,
    householdsSource: "census_acs",
    applyBasis: vi.fn(),
    setHouseholds: vi.fn(),
    advancedOpen: {},
    toggleAdvanced: vi.fn(),
    ...rest,
  } as unknown as WizardState;
}

describe("StepConfigureDonations — W15", () => {
  it("shows all 5 year shares as editable fields", () => {
    render(<StepConfigureDonations state={mockState()} />);
    expect(screen.getByLabelText(/year 1 donor market share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 2 donor market share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 3 donor market share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 4 donor market share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 5 donor market share/i)).toBeInTheDocument();
  });

  it("Y4 defaults to 11% and Y5 defaults to 12%", () => {
    render(<StepConfigureDonations state={mockState()} />);
    const y4 = screen.getByLabelText(/year 4 donor market share/i) as HTMLInputElement;
    const y5 = screen.getByLabelText(/year 5 donor market share/i) as HTMLInputElement;
    expect(y4.value).toBe("11");
    expect(y5.value).toBe("12");
  });

  it("$/donation defaults to $50", () => {
    render(<StepConfigureDonations state={mockState()} />);
    const donationField = screen.getByLabelText(/dollars per donation/i) as HTMLInputElement;
    expect(donationField.value).toBe("50.00");
  });

  it("shows the resolved household count as static text + pencil-edit icon", () => {
    render(<StepConfigureDonations state={mockState()} />);
    expect(screen.getByTestId("households-confirm")).toHaveTextContent(/31,798 households/i);
    expect(screen.queryByLabelText(/^households$/i)).toBeNull();
  });

  it("pencil reveals the household input", async () => {
    const user = userEvent.setup();
    render(<StepConfigureDonations state={mockState()} />);
    await user.click(screen.getByRole("button", { name: /edit households/i }));
    expect(screen.getByLabelText(/^households$/i)).toBeInTheDocument();
  });

  it("share changes call state.set", async () => {
    const set = vi.fn();
    const user = userEvent.setup();
    render(<StepConfigureDonations state={mockState({ set })} />);
    const y1 = screen.getByLabelText(/year 1 donor market share/i);
    await user.clear(y1);
    await user.type(y1, "7");
    expect(set).toHaveBeenCalledWith("shareY1", expect.any(Number));
  });

  it("never says 'trade area' in the UI", () => {
    const { container } = render(<StepConfigureDonations state={mockState()} />);
    expect(container.textContent?.toLowerCase()).not.toContain("trade area");
  });
});

describe("StepConfigureDonations — Advanced options (Task 2.3)", () => {
  it("renders the 'Donation economics' advanced group closed by default", () => {
    render(<StepConfigureDonations state={mockState()} />);
    expect(screen.getByText("Donation economics")).toBeInTheDocument();
    expect(screen.queryByLabelText(/average basket/i)).toBeNull();
    expect(screen.queryByLabelText(/donations per household/i)).toBeNull();
    expect(screen.queryByLabelText(/salvage/i)).toBeNull();
  });

  it("open shows basket ($17.08), donations/yr (3), and salvage % (0.80) with units", () => {
    const state = mockState({
      advancedOpen: { [advancedKey("configure-donations", "donation-econ")]: true },
    });
    render(<StepConfigureDonations state={state} />);
    const basket = screen.getByLabelText(/average basket/i) as HTMLInputElement;
    const donationsPerHh = screen.getByLabelText(/donations per household/i) as HTMLInputElement;
    const salvage = screen.getByLabelText(/salvage/i) as HTMLInputElement;
    expect(basket.value).toBe("17.08");
    expect(donationsPerHh.value).toBe("3");
    expect(salvage.value).toBe("0.80");
  });

  it("editing basket/donationsPerHh/salvagePct writes the matching draft key", () => {
    const set = vi.fn();
    const state = mockState({
      set,
      advancedOpen: { [advancedKey("configure-donations", "donation-econ")]: true },
    });
    render(<StepConfigureDonations state={state} />);

    fireEvent.change(screen.getByLabelText(/average basket/i), { target: { value: "20.50" } });
    expect(set).toHaveBeenLastCalledWith("basket", 20.5);

    fireEvent.change(screen.getByLabelText(/donations per household/i), {
      target: { value: "4" },
    });
    expect(set).toHaveBeenLastCalledWith("donationsPerHh", 4);

    fireEvent.change(screen.getByLabelText(/salvage/i), { target: { value: "1.25" } });
    expect(set).toHaveBeenLastCalledWith("salvagePct", 1.25);
  });
});

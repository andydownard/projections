import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StepSquareFootage } from "./StepSquareFootage";
import { advancedKey } from "./useWizardState";
import type { WizardState } from "./useWizardState";
import type { WizardDraft } from "./shareHelper";

// owner Decision 10: the square-footage step collects sq ft + % sales floor ONLY —
// rent/utilities/fixtures rates moved off this step (rent → startup costs; utilities/
// fixtures auto-seed the cost grid behind the scenes). Task 2.2 adds an Advanced
// Options group ("Space & occupancy rates") with utilities/fixtures/buildout rates,
// lease type, and (nnn-only) NNN opex — closed by default, unmounted when closed.
const BASE_DRAFT: Partial<WizardDraft> = {
  buildingSqft: 12500,
  salesfloorPct: 80,
  utilitiesPerSqft: 2.23,
  fixturesPerSqft: 4.5,
  buildoutPerSqft: 5.0,
  leaseType: "nnn",
  nnnOpexAnnual: 0,
};

interface MockOverrides extends Partial<Omit<WizardState, "draft">> {
  draft?: Partial<WizardDraft>;
}

function mockState(over: MockOverrides = {}): WizardState {
  const { draft: draftOverride, ...rest } = over;
  return {
    draft: { ...BASE_DRAFT, ...draftOverride },
    setBuildingSqft: vi.fn(),
    setSalesfloorPct: vi.fn(),
    setUtilitiesPerSqft: vi.fn(),
    setFixturesPerSqft: vi.fn(),
    setBuildoutPerSqft: vi.fn(),
    set: vi.fn(),
    utilitiesSource: "default",
    fixturesSource: "default",
    advancedOpen: {},
    toggleAdvanced: vi.fn(),
    ...rest,
  } as unknown as WizardState;
}

describe("StepSquareFootage", () => {
  it("asks for building size + sales-floor area only (no rent/utilities/fixtures) above the fold", () => {
    render(<StepSquareFootage state={mockState()} />);
    expect(screen.getByLabelText(/building size/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/sales-floor area/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/rent \(\$\/sq ft/i)).toBeNull();
    expect(screen.queryByLabelText(/utilities/i)).toBeNull();
    expect(screen.queryByLabelText(/fixtures/i)).toBeNull();
  });

  it("collects the building size via setBuildingSqft", () => {
    const setBuildingSqft = vi.fn();
    render(<StepSquareFootage state={mockState({ setBuildingSqft })} />);
    fireEvent.change(screen.getByLabelText(/building size/i), { target: { value: "8000" } });
    expect(setBuildingSqft).toHaveBeenCalledWith(8000);
  });
});

describe("StepSquareFootage — Advanced options (Task 2.2)", () => {
  it("renders the 'Space & occupancy rates' advanced group closed by default", () => {
    render(<StepSquareFootage state={mockState()} />);
    expect(screen.getByText("Space & occupancy rates")).toBeInTheDocument();
    expect(screen.queryByLabelText(/utilities per square foot per year/i)).toBeNull();
    expect(screen.queryByLabelText(/build-out per square foot/i)).toBeNull();
    expect(screen.queryByLabelText(/lease type/i)).toBeNull();
  });

  it("open reveals all five fields with correct units/aria-labels", () => {
    const state = mockState({
      advancedOpen: { [advancedKey("square-footage", "space-rates")]: true },
    });
    render(<StepSquareFootage state={state} />);
    expect(screen.getByLabelText(/utilities per square foot per year/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/fixtures per square foot/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/build-out per square foot/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/lease type/i)).toBeInTheDocument();
    // default draft leaseType is "nnn" → the NNN opex field shows
    expect(screen.getByLabelText(/nnn operating expenses/i)).toBeInTheDocument();
  });

  it("editing utilities calls setUtilitiesPerSqft", () => {
    const setUtilitiesPerSqft = vi.fn();
    const state = mockState({
      setUtilitiesPerSqft,
      advancedOpen: { [advancedKey("square-footage", "space-rates")]: true },
    });
    render(<StepSquareFootage state={state} />);
    fireEvent.change(screen.getByLabelText(/utilities per square foot per year/i), {
      target: { value: "3" },
    });
    expect(setUtilitiesPerSqft).toHaveBeenCalledWith(3);
  });

  it("changing buildout calls setBuildoutPerSqft (the hook owns the cost-row reseed)", () => {
    const setBuildoutPerSqft = vi.fn();
    const state = mockState({
      setBuildoutPerSqft,
      advancedOpen: { [advancedKey("square-footage", "space-rates")]: true },
    });
    render(<StepSquareFootage state={state} />);
    fireEvent.change(screen.getByLabelText(/build-out per square foot/i), {
      target: { value: "6" },
    });
    expect(setBuildoutPerSqft).toHaveBeenCalledWith(6);
  });

  it("shows the AssumptionSource provenance for utilities + fixtures (StepStartupCosts rent pattern)", () => {
    const state = mockState({
      utilitiesSource: "default",
      fixturesSource: "user",
      advancedOpen: { [advancedKey("square-footage", "space-rates")]: true },
    });
    render(<StepSquareFootage state={state} />);
    expect(screen.getByTestId("utilities-provenance")).toHaveTextContent("Regional default");
    expect(screen.getByTestId("fixtures-provenance")).toHaveTextContent("Adjusted by you");
  });

  it("leaseType select switches NNN opex field visibility, and edits call state.set", () => {
    const set = vi.fn();
    const state = mockState({
      set,
      draft: { leaseType: "gross" },
      advancedOpen: { [advancedKey("square-footage", "space-rates")]: true },
    });
    render(<StepSquareFootage state={state} />);
    // gross → no NNN opex field
    expect(screen.queryByLabelText(/nnn operating expenses/i)).toBeNull();

    fireEvent.change(screen.getByLabelText(/lease type/i), { target: { value: "nnn" } });
    expect(set).toHaveBeenCalledWith("leaseType", "nnn");
  });

  it("shows the NNN opex field only when leaseType is 'nnn'", () => {
    const state = mockState({
      advancedOpen: { [advancedKey("square-footage", "space-rates")]: true },
    });
    render(<StepSquareFootage state={state} />); // default mock draft.leaseType === "nnn"
    expect(screen.getByLabelText(/nnn operating expenses/i)).toBeInTheDocument();
  });
});

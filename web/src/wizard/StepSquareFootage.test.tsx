import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StepSquareFootage } from "./StepSquareFootage";
import type { WizardState } from "./useWizardState";

// owner Decision 10: the square-footage step collects sq ft + % sales floor ONLY —
// rent/utilities/fixtures rates moved off this step (rent → startup costs; utilities/
// fixtures auto-seed the cost grid behind the scenes).
function mockState(over: Partial<WizardState> = {}): WizardState {
  return {
    draft: { buildingSqft: 12500, salesfloorPct: 80 },
    setBuildingSqft: vi.fn(),
    setSalesfloorPct: vi.fn(),
    ...over,
  } as unknown as WizardState;
}

describe("StepSquareFootage", () => {
  it("asks for building size + sales-floor area only (no rent/utilities/fixtures)", () => {
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

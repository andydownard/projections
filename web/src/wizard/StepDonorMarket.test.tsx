import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { StepDonorMarket } from "./StepDonorMarket";
import type { WizardState } from "./useWizardState";

// owner Decisions 26/27/28: three SMALL side-by-side Year 1/2/3 fields with "%" glued
// to the number (not the label); on load they read as static values behind a pencil
// edit icon; the benchmark paragraph is gone and the explanation is just "the fraction
// of donations captured".
function mockState(over: Partial<WizardState> = {}): WizardState {
  return {
    draft: { shareY1: 6, shareY2: 8, shareY3: 10 },
    set: vi.fn(),
    ...over,
  } as unknown as WizardState;
}

describe("StepDonorMarket", () => {
  it("shows the three shares with the % glued to the number (display mode)", () => {
    render(<StepDonorMarket state={mockState()} />);
    expect(screen.getByText("6%")).toBeInTheDocument();
    expect(screen.getByText("8%")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
  });

  it("explains plainly and drops the benchmark copy", () => {
    render(<StepDonorMarket state={mockState()} />);
    expect(screen.getByText(/fraction of donations captured/i)).toBeInTheDocument();
    expect(screen.queryByText(/benchmark/i)).toBeNull();
  });

  it("reveals editable Year 1/2/3 inputs behind the pencil edit icon", async () => {
    const set = vi.fn();
    const user = userEvent.setup();
    render(<StepDonorMarket state={mockState({ set })} />);
    expect(screen.queryByLabelText(/year 1/i)).toBeNull(); // static until edited
    await user.click(screen.getByRole("button", { name: /edit donor market share/i }));
    const y1 = screen.getByLabelText(/year 1/i);
    expect(y1).toBeInTheDocument();
    await user.type(y1, "7");
    expect(set).toHaveBeenCalledWith("shareY1", expect.any(Number));
  });
});

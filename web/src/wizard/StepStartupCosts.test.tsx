import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StepStartupCosts } from "./StepStartupCosts";
import type { CostScheduleRow, WizardDraft } from "./shareHelper";
import type { WizardState } from "./useWizardState";

const PREVIEW = {
  rowTotals: [{ category: "Consultant", total: { raw: 100000, display: "$100,000" } }],
  columnTotals: [{ month: 1, total: { raw: 100000, display: "$100,000" } }],
  grandTotal: { raw: 100000, display: "$100,000" },
  modelVersion: "2.5.0",
  computeSchemaVersion: "1.3.0",
};

const previewSpy = vi.fn().mockResolvedValue(PREVIEW);
vi.mock("./costMatrix", async (importOriginal) => importOriginal());
vi.mock("../api/costSchedule", () => ({
  previewCostSchedule: (...args: unknown[]) => previewSpy(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
  previewSpy.mockResolvedValue(PREVIEW);
});

function makeState(overrides?: {
  costSchedule?: CostScheduleRow[];
  openingMonthNumber?: number;
}): WizardState {
  const draft: Partial<WizardDraft> = {
    rentPerSqft: 12,
    buildingSqft: 12500,
    openingMonthNumber: overrides?.openingMonthNumber ?? 1,
  };
  const costSchedule = overrides?.costSchedule ?? [
    { category: "Consultant", month: 1, amount: 100000 },
  ];
  return {
    draft: draft as WizardDraft,
    costSchedule,
    rentSource: "default",
    setRentPerSqft: vi.fn(),
    set: vi.fn(),
  } as unknown as WizardState;
}

describe("StepStartupCosts — grid + server totals (#31/#15)", () => {
  it("renders the rows×months grid and the rent field", () => {
    render(<StepStartupCosts state={makeState()} />);
    expect(screen.getByTestId("cost-schedule-editor")).toBeInTheDocument();
    expect(screen.getByLabelText(/rent/i)).toBeInTheDocument();
  });

  it("fetches the server preview and renders the grand total verbatim (no client sum)", async () => {
    render(<StepStartupCosts state={makeState()} />);
    await waitFor(() => expect(previewSpy).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId("cost-grand-total")).toHaveTextContent("$100,000"),
    );
  });

  it("editing a grid cell pushes the new flat schedule up via state.set", () => {
    const state = makeState();
    render(<StepStartupCosts state={state} />);
    fireEvent.change(screen.getByLabelText("Line item 1 month 1 cost"), {
      target: { value: "120000" },
    });
    expect(state.set).toHaveBeenLastCalledWith("costSchedule", [
      { category: "Consultant", month: 1, amount: 120000 },
    ]);
  });

  it("dragging the grand-opening handle to a column sets the opening month", () => {
    const state = makeState();
    render(<StepStartupCosts state={state} />);
    fireEvent.dragStart(screen.getByTestId("grand-opening-handle"));
    fireEvent.drop(screen.getByTestId("cost-col-5"));
    expect(state.set).toHaveBeenLastCalledWith("openingMonthNumber", 5);
  });
});

describe("StepStartupCosts — proposal → Penny (#32)", () => {
  it("hides the proposal affordance when AI is off (manual grid is the path)", () => {
    render(<StepStartupCosts state={makeState()} />);
    expect(screen.queryByTestId("proposal-affordance")).not.toBeInTheDocument();
  });

  it("hands a chosen PDF to the upload handler", async () => {
    const user = userEvent.setup();
    const onUploadProposal = vi.fn();
    render(<StepStartupCosts state={makeState()} onUploadProposal={onUploadProposal} />);
    const file = new File([new Uint8Array([1, 2, 3])], "proposal.pdf", {
      type: "application/pdf",
    });
    await user.upload(screen.getByTestId("proposal-file-input"), file);
    expect(onUploadProposal).toHaveBeenCalledWith(file);
  });

  it('shows the descriptive "Penny is reading your proposal…" spinner while busy', () => {
    render(
      <StepStartupCosts state={makeState()} onUploadProposal={vi.fn()} proposalBusy />,
    );
    expect(screen.getByTestId("proposal-spinner")).toHaveTextContent(/reading your proposal/i);
  });

  it("surfaces a plain-language error without crashing the grid", () => {
    render(
      <StepStartupCosts
        state={makeState()}
        onUploadProposal={vi.fn()}
        proposalError="Couldn’t read that proposal — set the schedule out by hand below."
      />,
    );
    expect(screen.getByTestId("proposal-error")).toBeInTheDocument();
    expect(screen.getByTestId("cost-schedule-editor")).toBeInTheDocument();
  });
});

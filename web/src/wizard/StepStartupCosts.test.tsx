import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StepStartupCosts } from "./StepStartupCosts";
import type { CostScheduleRow, WizardDraft } from "./shareHelper";
import { advancedKey } from "./useWizardState";
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

// Task 2.4's owner-decided v1 resolved defaults (CLAUDE.md "Resolved defaults" table)
// — matches DEFAULT_DRAFT in useWizardState.ts so the mock reflects real seed values.
const BASE_DRAFT: Partial<WizardDraft> = {
  rentPerSqft: 12,
  buildingSqft: 12500,
  openingMonthNumber: 1,
  cash: 300000,
  grant: 0,
  loan: 0,
  escalatorPct: 3,
  laborPct: 60,
  marketingPct: 3.75,
  suppliesPct: 5,
  cardPct: 2,
  payrollTaxPct: 7.5,
  reserveBuffer: 25000,
  sensitivityDeltaPct: 25,
  fixedAnnual: {
    "Insurance liability": 2000,
    "Internet, Phones": 3000,
    "Pest control": 300,
    "Repairs/maintenance": 1600,
    "Security system": 900,
  },
};

function makeState(overrides?: {
  costSchedule?: CostScheduleRow[];
  openingMonthNumber?: number;
  draft?: Partial<WizardDraft>;
  set?: WizardState["set"];
  advancedOpen?: Partial<Record<string, boolean>>;
}): WizardState {
  const draft: Partial<WizardDraft> = {
    ...BASE_DRAFT,
    openingMonthNumber: overrides?.openingMonthNumber ?? BASE_DRAFT.openingMonthNumber,
    ...overrides?.draft,
  };
  const costSchedule = overrides?.costSchedule ?? [
    { category: "Consultant", month: 1, amount: 100000 },
  ];
  return {
    draft: draft as WizardDraft,
    costSchedule,
    rentSource: "default",
    rentResearch: null,
    rentResearchLoading: false,
    rentResearchError: false,
    setRentPerSqft: vi.fn(),
    set: overrides?.set ?? vi.fn(),
    advancedOpen: overrides?.advancedOpen ?? {},
    toggleAdvanced: vi.fn(),
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

describe("StepStartupCosts — Source of funds (always visible, Task 2.4)", () => {
  it("shows the Source of funds fieldset with cash/grant/loan defaulting 300000/0/0", () => {
    render(<StepStartupCosts state={makeState()} />);
    expect(screen.getByTestId("source-of-funds")).toBeInTheDocument();
    expect((screen.getByLabelText(/cash on hand/i) as HTMLInputElement).value).toBe("300,000");
    expect((screen.getByLabelText(/grant funding/i) as HTMLInputElement).value).toBe("0");
    expect((screen.getByLabelText(/loan funding/i) as HTMLInputElement).value).toBe("0");
  });

  it("shows the no-client-sum note instead of a computed total", () => {
    render(<StepStartupCosts state={makeState()} />);
    expect(screen.getByText(/totals are computed after generate/i)).toBeInTheDocument();
  });

  it("editing cash/grant/loan writes the matching draft key", () => {
    const set = vi.fn();
    render(<StepStartupCosts state={makeState({ set })} />);
    fireEvent.change(screen.getByLabelText(/cash on hand/i), { target: { value: "250000" } });
    expect(set).toHaveBeenLastCalledWith("cash", 250000);
    fireEvent.change(screen.getByLabelText(/grant funding/i), { target: { value: "10000" } });
    expect(set).toHaveBeenLastCalledWith("grant", 10000);
    fireEvent.change(screen.getByLabelText(/loan funding/i), { target: { value: "5000" } });
    expect(set).toHaveBeenLastCalledWith("loan", 5000);
  });
});

describe("StepStartupCosts — Rent & lease / Operating cost structure / Funding & capital (Task 2.4)", () => {
  it("renders all three advanced group headings, closed by default", () => {
    render(<StepStartupCosts state={makeState()} />);
    expect(screen.getByText("Rent & lease")).toBeInTheDocument();
    expect(screen.getByText("Operating cost structure")).toBeInTheDocument();
    expect(screen.getByText("Funding & capital")).toBeInTheDocument();
    expect(screen.queryByLabelText(/rent escalator/i)).toBeNull();
    expect(screen.queryByLabelText(/labor percentage/i)).toBeNull();
    expect(screen.queryByLabelText(/reserve buffer/i)).toBeNull();
  });

  it("opening a single group reveals only its own fields", () => {
    const state = makeState({
      advancedOpen: { [advancedKey("startup-costs", "funding")]: true },
    });
    render(<StepStartupCosts state={state} />);
    expect(screen.getByLabelText(/reserve buffer/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/sensitivity/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/rent escalator/i)).toBeNull();
    expect(screen.queryByLabelText(/labor percentage/i)).toBeNull();
  });

  it("opens each group independently (no cross-talk)", () => {
    const state = makeState({
      advancedOpen: { [advancedKey("startup-costs", "rent-lease")]: true },
    });
    render(<StepStartupCosts state={state} />);
    expect(screen.getByLabelText(/rent escalator/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/labor percentage/i)).toBeNull();
    expect(screen.queryByLabelText(/reserve buffer/i)).toBeNull();
  });

  it("all 13 advanced fields render with correct units + aria-labels when every group is open", () => {
    const state = makeState({
      advancedOpen: {
        [advancedKey("startup-costs", "rent-lease")]: true,
        [advancedKey("startup-costs", "cost-structure")]: true,
        [advancedKey("startup-costs", "funding")]: true,
      },
    });
    render(<StepStartupCosts state={state} />);

    // Rent & lease (1)
    expect((screen.getByLabelText(/rent escalator/i) as HTMLInputElement).value).toBe("3.00");

    // Operating cost structure — 5 cost %s (5)
    expect((screen.getByLabelText(/labor percentage/i) as HTMLInputElement).value).toBe("60.00");
    expect((screen.getByLabelText(/marketing percentage/i) as HTMLInputElement).value).toBe(
      "3.75",
    );
    expect((screen.getByLabelText(/supplies percentage/i) as HTMLInputElement).value).toBe(
      "5.00",
    );
    expect((screen.getByLabelText(/card fee percentage/i) as HTMLInputElement).value).toBe(
      "2.00",
    );
    expect((screen.getByLabelText(/payroll tax percentage/i) as HTMLInputElement).value).toBe(
      "7.50",
    );

    // Operating cost structure — 5 fixed annual lines (5)
    expect((screen.getByLabelText(/insurance liability/i) as HTMLInputElement).value).toBe(
      "2,000",
    );
    expect((screen.getByLabelText(/internet, phones/i) as HTMLInputElement).value).toBe("3,000");
    expect((screen.getByLabelText(/pest control/i) as HTMLInputElement).value).toBe("300");
    expect((screen.getByLabelText(/repairs\/maintenance/i) as HTMLInputElement).value).toBe(
      "1,600",
    );
    expect((screen.getByLabelText(/security system/i) as HTMLInputElement).value).toBe("900");

    // Funding & capital (2)
    expect((screen.getByLabelText(/reserve buffer/i) as HTMLInputElement).value).toBe("25,000");
    expect((screen.getByLabelText(/sensitivity/i) as HTMLInputElement).value).toBe("25.00");
  });

  it("editing a cost-structure driver writes the matching draft key", () => {
    const set = vi.fn();
    const state = makeState({
      set,
      advancedOpen: { [advancedKey("startup-costs", "cost-structure")]: true },
    });
    render(<StepStartupCosts state={state} />);
    fireEvent.change(screen.getByLabelText(/labor percentage/i), { target: { value: "55" } });
    expect(set).toHaveBeenLastCalledWith("laborPct", 55);

    fireEvent.change(screen.getByLabelText(/insurance liability/i), {
      target: { value: "2500" },
    });
    expect(set).toHaveBeenLastCalledWith("fixedAnnual", {
      ...BASE_DRAFT.fixedAnnual,
      "Insurance liability": 2500,
    });
  });

  it("editing a funding driver writes the matching draft key", () => {
    const set = vi.fn();
    const state = makeState({
      set,
      advancedOpen: { [advancedKey("startup-costs", "funding")]: true },
    });
    render(<StepStartupCosts state={state} />);
    fireEvent.change(screen.getByLabelText(/reserve buffer/i), { target: { value: "30000" } });
    expect(set).toHaveBeenLastCalledWith("reserveBuffer", 30000);
  });

  it("adds a 'Timing' heading above the opening-month + cost-schedule grid", () => {
    render(<StepStartupCosts state={makeState()} />);
    expect(screen.getByText("Timing")).toBeInTheDocument();
  });
});

// Task 2.5 (audit P1): the planning-estimates disclaimer, rendered by this (the
// last) step so it sits directly above the Generate button that CreateProjectionPage
// renders immediately after it.
describe("StepStartupCosts — planning-estimates disclaimer (audit P1, Task 2.5)", () => {
  it("renders the disclaimer text", () => {
    render(<StepStartupCosts state={makeState()} />);
    expect(
      screen.getByText("These figures are planning estimates, not financial advice."),
    ).toBeInTheDocument();
  });

  it("uses the styled .wizard__disclaimer class", () => {
    render(<StepStartupCosts state={makeState()} />);
    expect(
      screen.getByText("These figures are planning estimates, not financial advice."),
    ).toHaveClass("wizard__disclaimer");
  });
});

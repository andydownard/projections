import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CostScheduleEditor } from "./CostScheduleEditor";
import type { CostScheduleRow } from "../wizard/shareHelper";

function setup(overrides?: {
  rows?: CostScheduleRow[];
  openingMonthNumber?: number;
  targetOpeningDate?: string;
}) {
  const handlers = {
    onAddRow: vi.fn(),
    onUpdateRow: vi.fn(),
    onRemoveRow: vi.fn(),
    onChangeOpeningMonth: vi.fn(),
    onChangeTargetDate: vi.fn(),
  };
  const rows = overrides?.rows ?? [{ category: "Consultant", month: 1, amount: 100000 }];
  render(
    <CostScheduleEditor
      rows={rows}
      openingMonthNumber={overrides?.openingMonthNumber ?? 1}
      targetOpeningDate={overrides?.targetOpeningDate ?? "2026-06"}
      {...handlers}
    />,
  );
  return handlers;
}

describe("CostScheduleEditor", () => {
  it("renders the opening anchor (target date + opening month #) editable", () => {
    setup();
    expect(screen.getByTestId("opening-date")).toHaveValue("2026-06");
    expect(screen.getByTestId("opening-month")).toHaveValue(1);
  });

  it("edits the opening anchor", () => {
    const h = setup();
    fireEvent.change(screen.getByTestId("opening-month"), { target: { value: "6" } });
    expect(h.onChangeOpeningMonth).toHaveBeenLastCalledWith(6);
    fireEvent.change(screen.getByTestId("opening-date"), { target: { value: "2027-01" } });
    expect(h.onChangeTargetDate).toHaveBeenLastCalledWith("2027-01");
  });

  it("adds a row", async () => {
    const user = userEvent.setup();
    const h = setup();
    await user.click(screen.getByTestId("add-cost-row"));
    expect(h.onAddRow).toHaveBeenCalledTimes(1);
  });

  it("removes a row", async () => {
    const user = userEvent.setup();
    const h = setup({
      rows: [
        { category: "Consultant", month: 1, amount: 100000 },
        { category: "Build-out", month: 2, amount: 50000 },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Remove cost row 2" }));
    expect(h.onRemoveRow).toHaveBeenCalledWith(1);
  });

  it("updates a row's category/month/amount", () => {
    const h = setup();
    fireEvent.change(screen.getByLabelText("Cost row 1 category"), {
      target: { value: "Renovation" },
    });
    expect(h.onUpdateRow).toHaveBeenLastCalledWith(0, { category: "Renovation" });

    fireEvent.change(screen.getByLabelText("Cost row 1 month"), { target: { value: "3" } });
    expect(h.onUpdateRow).toHaveBeenLastCalledWith(0, { month: 3 });

    fireEvent.change(screen.getByLabelText("Cost row 1 amount"), { target: { value: "5000" } });
    expect(h.onUpdateRow).toHaveBeenLastCalledWith(0, { amount: 5000 });
  });

  it("supports month-1 + opening-month-1 (legacy single-lump parity)", () => {
    setup({
      rows: [
        { category: "Consultant", month: 1, amount: 100000 },
        { category: "Equipment & Fixtures", month: 1, amount: 45000 },
      ],
      openingMonthNumber: 1,
    });
    expect(screen.getByTestId("opening-month")).toHaveValue(1);
    expect(screen.getAllByTestId("cost-row")).toHaveLength(2);
  });

  it("supports rows before and after the opening month", () => {
    setup({
      rows: [
        { category: "Pre-open build-out", month: 1, amount: 50000 },
        { category: "Post-open support", month: 8, amount: 10000 },
      ],
      openingMonthNumber: 6,
    });
    const rows = screen.getAllByTestId("cost-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByDisplayValue("Pre-open build-out")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Post-open support")).toBeInTheDocument();
  });

  it("gates validation: invalid opening month surfaces an inline error", () => {
    setup({ openingMonthNumber: 0 });
    expect(screen.getByTestId("opening-month-error")).toBeInTheDocument();
  });

  it("gates validation: invalid row month/amount surfaces inline errors", () => {
    setup({ rows: [{ category: "Bad", month: 0, amount: -5 }] });
    expect(screen.getByTestId("cost-row-error")).toHaveTextContent("Month must be 1 or greater.");
  });

  it("does not surface row errors for valid rows", () => {
    setup({ rows: [{ category: "Good", month: 1, amount: 0 }] });
    expect(screen.queryByTestId("cost-row-error")).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no rows", () => {
    setup({ rows: [] });
    expect(screen.getByTestId("cost-schedule-empty")).toBeInTheDocument();
    expect(screen.queryAllByTestId("cost-row")).toHaveLength(0);
  });

  it("renders server-formatted totals verbatim (no client math)", () => {
    const handlers = {
      onAddRow: vi.fn(),
      onUpdateRow: vi.fn(),
      onRemoveRow: vi.fn(),
      onChangeOpeningMonth: vi.fn(),
      onChangeTargetDate: vi.fn(),
    };
    render(
      <CostScheduleEditor
        rows={[{ category: "Consultant", month: 1, amount: 100000 }]}
        openingMonthNumber={1}
        targetOpeningDate="2026-06"
        totals={[{ label: "Total startup", value: { raw: 208500, display: "$208,500" } }]}
        {...handlers}
      />,
    );
    expect(screen.getByTestId("cost-schedule-totals")).toHaveTextContent("$208,500");
  });
});

describe("CostScheduleEditor — per-field change affordance (PE7, #126)", () => {
  const noopHandlers = () => ({
    onAddRow: vi.fn(),
    onUpdateRow: vi.fn(),
    onRemoveRow: vi.fn(),
    onChangeOpeningMonth: vi.fn(),
    onChangeTargetDate: vi.fn(),
  });

  it("shows the recent-change badge + subtle 'was X' on a row field Penny just changed", () => {
    render(
      <CostScheduleEditor
        rows={[{ category: "Consultant", month: 1, amount: 100000 }]}
        openingMonthNumber={1}
        targetOpeningDate="2026-06"
        changes={{ "0:amount": { previous: "$45,000", by: "penny" } }}
        {...noopHandlers()}
      />,
    );
    const fc = screen.getByTestId("field-change");
    expect(within(fc).getByTestId("field-change-badge")).toHaveTextContent(/changed by penny/i);
    expect(within(fc).getByTestId("field-change-was")).toHaveTextContent("was $45,000");
  });

  it("per-field undo reverts THAT row field — calls onUndoChange(index, field)", async () => {
    const user = userEvent.setup();
    const onUndoChange = vi.fn();
    render(
      <CostScheduleEditor
        rows={[{ category: "Consultant", month: 1, amount: 100000 }]}
        openingMonthNumber={1}
        targetOpeningDate="2026-06"
        changes={{ "0:amount": { previous: "$45,000", by: "penny" } }}
        onUndoChange={onUndoChange}
        {...noopHandlers()}
      />,
    );
    await user.click(screen.getByTestId("field-change-undo"));
    expect(onUndoChange).toHaveBeenCalledWith(0, "amount");
  });

  it("renders no affordance for fields without a recent change", () => {
    render(
      <CostScheduleEditor
        rows={[{ category: "Consultant", month: 1, amount: 100000 }]}
        openingMonthNumber={1}
        targetOpeningDate="2026-06"
        {...noopHandlers()}
      />,
    );
    expect(screen.queryByTestId("field-change")).not.toBeInTheDocument();
  });
});

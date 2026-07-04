import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CostScheduleEditor } from "./CostScheduleEditor";
import type { CostSchedulePreview } from "../api/costSchedule";
import type { CostScheduleRow } from "../wizard/shareHelper";

function setup(overrides?: {
  rows?: CostScheduleRow[];
  openingMonthNumber?: number;
  monthCount?: number;
  totals?: CostSchedulePreview | null;
}) {
  const handlers = {
    onChangeRows: vi.fn(),
    onChangeOpeningMonth: vi.fn(),
  };
  const rows = overrides?.rows ?? [
    { category: "Consultant", month: 1, amount: 100000 },
    { category: "Equipment", month: 1, amount: 45000 },
  ];
  render(
    <CostScheduleEditor
      rows={rows}
      openingMonthNumber={overrides?.openingMonthNumber ?? 1}
      monthCount={overrides?.monthCount ?? 12}
      totals={overrides?.totals ?? null}
      {...handlers}
    />,
  );
  return { ...handlers, rows };
}

describe("CostScheduleEditor — rows × months grid (#31)", () => {
  it("renders months 1–12 as column headers plus a Total column", () => {
    setup();
    for (let m = 1; m <= 12; m++) {
      expect(screen.getByTestId(`cost-col-${m}`)).toBeInTheDocument();
    }
    expect(screen.getByRole("columnheader", { name: /total/i })).toBeInTheDocument();
  });

  it("renders each line-item as a row, pivoting flat entries into month cells", () => {
    setup({
      rows: [
        { category: "Consultant", month: 1, amount: 100000 },
        { category: "Consultant", month: 6, amount: 20000 },
      ],
    });
    const rows = screen.getAllByTestId("cost-row");
    expect(rows).toHaveLength(1); // both flat entries collapse onto ONE Consultant row
    // The two entries land in their month columns (NumberField renders type=text).
    expect(screen.getByLabelText("Line item 1 month 1 cost")).toHaveValue("100,000.00");
    expect(screen.getByLabelText("Line item 1 month 6 cost")).toHaveValue("20,000.00");
    // A month with no entry is blank.
    expect(screen.getByLabelText("Line item 1 month 2 cost")).toHaveValue("");
  });

  it("editing a cell emits the updated flat array (no client sum)", () => {
    const h = setup();
    fireEvent.change(screen.getByLabelText("Line item 2 month 1 cost"), {
      target: { value: "50000" },
    });
    expect(h.onChangeRows).toHaveBeenLastCalledWith([
      { category: "Consultant", month: 1, amount: 100000 },
      { category: "Equipment", month: 1, amount: 50000 },
    ]);
  });

  it("filling a previously empty month cell appends a flat entry", () => {
    const h = setup();
    fireEvent.change(screen.getByLabelText("Line item 1 month 3 cost"), {
      target: { value: "7000" },
    });
    expect(h.onChangeRows).toHaveBeenLastCalledWith([
      { category: "Consultant", month: 1, amount: 100000 },
      { category: "Equipment", month: 1, amount: 45000 },
      { category: "Consultant", month: 3, amount: 7000 },
    ]);
  });

  it("renaming a line-item rewrites the category on its flat entries", () => {
    const h = setup();
    fireEvent.change(screen.getByLabelText("Line item 1 name"), {
      target: { value: "Lead Consultant" },
    });
    expect(h.onChangeRows).toHaveBeenLastCalledWith([
      { category: "Lead Consultant", month: 1, amount: 100000 },
      { category: "Equipment", month: 1, amount: 45000 },
    ]);
  });
});

describe("CostScheduleEditor — add row + trash remove (#33)", () => {
  it('the add control is labelled "Add row" with the add-cost-row testid', async () => {
    const user = userEvent.setup();
    const h = setup();
    const add = screen.getByTestId("add-cost-row");
    expect(add).toHaveTextContent(/add row/i);
    await user.click(add);
    expect(h.onChangeRows).toHaveBeenCalledTimes(1);
    const next = h.onChangeRows.mock.calls[0][0] as CostScheduleRow[];
    expect(next).toHaveLength(3); // appended one empty line-item
  });

  it("removes a line-item via a trash-can icon button (not a text button)", async () => {
    const user = userEvent.setup();
    const h = setup();
    const remove = screen.getByRole("button", { name: /remove .*consultant/i });
    // The control is an icon button — no visible text label.
    expect(remove).toHaveTextContent("");
    await user.click(remove);
    expect(h.onChangeRows).toHaveBeenLastCalledWith([
      { category: "Equipment", month: 1, amount: 45000 },
    ]);
  });
});

describe("CostScheduleEditor — grand-opening column (#34)", () => {
  it("highlights the opening month column and styles pre-opening months subtly", () => {
    setup({ openingMonthNumber: 4 });
    expect(screen.getByTestId("cost-col-4").className).toMatch(/opening/);
    // Months before opening get a pre-opening modifier.
    expect(screen.getByTestId("cost-col-1").className).toMatch(/pre/);
    expect(screen.getByTestId("cost-col-3").className).toMatch(/pre/);
    // A post-opening month is neither.
    expect(screen.getByTestId("cost-col-8").className).not.toMatch(/opening|pre/);
  });

  it('renders a draggable handle labelled "grand opening" on the opening column', () => {
    setup({ openingMonthNumber: 4 });
    const handle = screen.getByTestId("grand-opening-handle");
    expect(handle).toHaveTextContent(/grand opening/i);
    expect(handle).toHaveAttribute("draggable", "true");
    // The handle is now in the go-row (above the month headers), not inside cost-col-4.
    expect(handle).toBeInTheDocument();
  });

  it("dropping the handle on another month column sets openingMonthNumber", () => {
    const h = setup({ openingMonthNumber: 1 });
    fireEvent.dragStart(screen.getByTestId("grand-opening-handle"));
    fireEvent.drop(screen.getByTestId("cost-col-7"));
    expect(h.onChangeOpeningMonth).toHaveBeenCalledWith(7);
  });

  // #320: the FULL column header accepts the drop — the go-row cell above each month
  // header (where the handle visibly lives) is a drop target too, not just Row-2.
  it("dropping the handle anywhere in the column header row (the go-row cell) sets openingMonthNumber", () => {
    const h = setup({ openingMonthNumber: 1 });
    fireEvent.dragStart(screen.getByTestId("grand-opening-handle"));
    fireEvent.drop(screen.getByTestId("go-col-7"));
    expect(h.onChangeOpeningMonth).toHaveBeenCalledWith(7);
  });

  it("exposes the handle as an accessible slider with the opening month value", () => {
    setup({ openingMonthNumber: 4 });
    const handle = screen.getByTestId("grand-opening-handle");
    expect(handle).toHaveAttribute("role", "slider");
    expect(handle).toHaveAttribute("aria-valuemin", "1");
    expect(handle).toHaveAttribute("aria-valuemax", "12");
    expect(handle).toHaveAttribute("aria-valuenow", "4");
    expect(handle).toHaveAccessibleName(/grand opening/i);
  });

  it("keyboard arrows move the focused handle (WCAG equivalent to drag)", async () => {
    const h = setup({ openingMonthNumber: 4 });
    const handle = screen.getByTestId("grand-opening-handle");
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(h.onChangeOpeningMonth).toHaveBeenLastCalledWith(5);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(h.onChangeOpeningMonth).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(h.onChangeOpeningMonth).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(handle, { key: "End" });
    expect(h.onChangeOpeningMonth).toHaveBeenLastCalledWith(12);
  });

  it("clamps the handle at the ends (no move past month 1 / month 12)", () => {
    const h = setup({ openingMonthNumber: 1 });
    fireEvent.keyDown(screen.getByTestId("grand-opening-handle"), { key: "ArrowLeft" });
    expect(h.onChangeOpeningMonth).not.toHaveBeenCalled();
  });
});

describe("CostScheduleEditor — server totals rendered verbatim (#15, no client math)", () => {
  const totals: CostSchedulePreview = {
    rowTotals: [
      { category: "Consultant", total: { raw: 100000, display: "$100,000" } },
      { category: "Equipment", total: { raw: 45000, display: "$45,000" } },
    ],
    columnTotals: [{ month: 1, total: { raw: 145000, display: "$145,000" } }],
    grandTotal: { raw: 145000, display: "$145,000" },
    modelVersion: "2.5.0",
    computeSchemaVersion: "1.3.0",
  };

  it("renders the server row totals, column totals, and grand total display strings", () => {
    setup({ totals });
    expect(screen.getByTestId("row-total-0")).toHaveTextContent("$100,000");
    expect(screen.getByTestId("row-total-1")).toHaveTextContent("$45,000");
    expect(screen.getByTestId("col-total-1")).toHaveTextContent("$145,000");
    expect(screen.getByTestId("cost-grand-total")).toHaveTextContent("$145,000");
  });

  // Same class of bug, and the one that ACTUALLY reproduced live: under a parallel
  // test run, CreateProjectionPage.test.tsx's catch-all fetch mock answered
  // POST /api/cost-schedule/preview with an unrelated view-model body (no
  // `grandTotal` key at all) — `totals?.grandTotal.display` threw because the
  // optional chain only covered `totals`, not `totals.grandTotal`.
  it("does not throw when totals arrives without a grandTotal (a wrong-shaped/partial response)", () => {
    const noGrandTotal = {
      rowTotals: [
        { category: "Consultant", total: { raw: 100000, display: "$100,000" } },
        { category: "Equipment", total: { raw: 45000, display: "$45,000" } },
      ],
      columnTotals: [{ month: 1, total: { raw: 145000, display: "$145,000" } }],
      modelVersion: "2.5.0",
      computeSchemaVersion: "1.3.0",
    } as unknown as CostSchedulePreview;
    expect(() => setup({ totals: noGrandTotal })).not.toThrow();
    expect(screen.getByTestId("cost-grand-total")).toHaveTextContent("—");
    // The row totals WERE present, so they still render verbatim.
    expect(screen.getByTestId("row-total-0")).toHaveTextContent("$100,000");
  });

  // Root-caused flake (intermittent uncaught TypeError in parallel test runs, and a
  // potential prod crash): `totals?.rowTotals.map(...)` only guards `totals` itself
  // — if the PREVIEW RESPONSE ARRIVES PARTIAL (a truthy totals object missing the
  // rowTotals/columnTotals arrays), `undefined.map` throws synchronously during
  // render. The grid must degrade to the placeholder, never throw.
  it("does not throw when totals arrives without rowTotals or columnTotals (a partial server response)", () => {
    const partial = {
      grandTotal: { raw: 145000, display: "$145,000" },
      modelVersion: "2.5.0",
      computeSchemaVersion: "1.3.0",
    } as unknown as CostSchedulePreview;
    expect(() => setup({ totals: partial })).not.toThrow();
    // The row-total cells fall back to the neutral placeholder — no totals row data
    // renders from the missing rowTotals array.
    expect(screen.getByTestId("row-total-0")).toHaveTextContent("—");
    expect(screen.getByTestId("row-total-1")).toHaveTextContent("—");
    // grandTotal WAS present on this partial response, so it still renders verbatim.
    expect(screen.getByTestId("cost-grand-total")).toHaveTextContent("$145,000");
  });

  it("shows a neutral placeholder for totals before the server responds", () => {
    setup({ totals: null });
    expect(screen.getByTestId("cost-grand-total")).toHaveTextContent("—");
  });
});

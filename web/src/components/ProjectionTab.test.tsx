import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ProjectionTab } from "./ProjectionTab";
import type { ViewModel } from "../api/viewModel";

// EPIC D — the owner detail Projection panel. It renders the Appendix-D view-model
// VERBATIM (no client math) and:
//   - is YEAR-COUNT-AGNOSTIC: a stored 3-year snapshot (y1..y3) renders 3 columns;
//     a 2.6.0 snapshot (y1..y5) renders 5;
//   - drops the "% share" sub-label under each year header (D7);
//   - no longer renders the decision tiles (those moved to the header metric bar);
//   - the bottom income-statement line reads "Net income", never "Net profit";
//   - editable cells open an inline editor; derived cells are non-editable with no
//     hand cursor (cursor:pointer only on `cell--editable`).

function vm(overrides: Partial<ViewModel> = {}): ViewModel {
  return {
    reco: {
      tag: "proceed",
      headline: "Proceed. The model clears break-even.",
      sub: "Year-1 net is positive and the worst-case trough is covered.",
    },
    metrics: {
      capital: { raw: 277990, display: "$277,990" },
      cashGap: { raw: -219990, display: "($219,990)" },
      breakeven: { raw: 5, display: "Month 5" },
      reasonCapital: "One-time startup + worst-case cash trough + $25,000 reserve.",
      reasonGap: "Most-negative cumulative cash across the first year.",
      reasonBreakeven: "First month operating net turns and stays non-negative.",
    },
    kpis: [
      { label: "Total revenue", value: { raw: 426911, display: "$426,911" }, sub: "Year 1" },
      { label: "Net income", value: { raw: 46000, display: "$46,000" }, sub: "Year 1" },
    ],
    monthly: [
      { month: 0, revenue: { raw: 0, display: "$0" }, expenses: { raw: 31870, display: "($31,870)" }, net: { raw: -14793, display: "($14,793)" }, cumulativeCash: { raw: -199793, display: "($199,793)" } },
      { month: 5, revenue: { raw: 32018, display: "$32,018" }, expenses: { raw: 31376, display: "($31,376)" }, net: { raw: 643, display: "$643" }, cumulativeCash: { raw: -219990, display: "($219,990)" } },
      { month: 12, revenue: { raw: 53364, display: "$53,364" }, expenses: { raw: 32077, display: "($32,077)" }, net: { raw: 20718, display: "$20,718" }, cumulativeCash: { raw: -173000, display: "($173,000)" } },
    ],
    breakevenMonth: 5,
    rows: [
      { label: "Donor market share", group: "drivers", y1: { raw: 0.06, display: "6.0%" }, y2: { raw: 0.08, display: "8.0%" }, y3: { raw: 0.1, display: "10.0%" }, class: "input", editable: true },
      { label: "Total Revenue", group: "revenue", y1: { raw: 426911, display: "$426,911" }, y2: { raw: 560000, display: "$560,000" }, y3: { raw: 700000, display: "$700,000" }, class: "computed", editable: false },
      { label: "Rent", group: "expenses", y1: { raw: 90000, display: "$90,000" }, y2: { raw: 92700, display: "$92,700" }, y3: { raw: 95481, display: "$95,481" }, class: "estimated", editable: true },
      { label: "Payroll", group: "expenses", y1: { raw: 256146, display: "$256,146" }, y2: { raw: 280000, display: "$280,000" }, y3: { raw: 300000, display: "$300,000" }, class: "overridden", editable: false },
      { label: "Net income", group: "expenses", y1: { raw: 46000, display: "$46,000" }, y2: { raw: 60000, display: "$60,000" }, y3: { raw: 80000, display: "$80,000" }, class: "computed", editable: false },
    ],
    settings: {},
    version: 3,
    view_slug: "abc",
    name: "House of Hope",
    ...overrides,
  };
}

/** A 5-year view-model (rows carry y1..y5) for the year-count-agnostic table. */
function vm5(): ViewModel {
  const five = (a: number, b: number, c: number, d: number, e: number) => ({
    y1: { raw: a, display: `$${a}` },
    y2: { raw: b, display: `$${b}` },
    y3: { raw: c, display: `$${c}` },
    y4: { raw: d, display: `$${d}` },
    y5: { raw: e, display: `$${e}` },
  });
  return vm({
    rows: [
      { label: "Total Revenue", group: "revenue", ...five(426911, 560000, 700000, 750000, 800000), class: "computed", editable: false },
      { label: "Net income", group: "expenses", ...five(46000, 60000, 80000, 90000, 100000), class: "computed", editable: false },
    ],
  });
}

describe("ProjectionTab — year-count-agnostic table (E1 / Decision 5)", () => {
  it("renders 3 year columns for a stored 3-year snapshot (y1..y3 only)", () => {
    render(<ProjectionTab vm={vm()} />);
    const table = screen.getByTestId("three-year-table");
    expect(within(table).getByRole("columnheader", { name: "Year 1" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Year 3" })).toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: "Year 4" })).not.toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: "Year 5" })).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: /3-year projection/i })).toBeInTheDocument();
  });

  it("renders 5 year columns for a 2.6.0 snapshot (y1..y5) without code change", () => {
    render(<ProjectionTab vm={vm5()} />);
    const table = screen.getByTestId("three-year-table");
    for (const n of [1, 2, 3, 4, 5]) {
      expect(within(table).getByRole("columnheader", { name: `Year ${n}` })).toBeInTheDocument();
    }
    expect(screen.getByTestId("cell-Total Revenue-y5")).toHaveTextContent("$800000");
    expect(screen.getByRole("table", { name: /5-year projection/i })).toBeInTheDocument();
  });

  it("labels the income-statement bottom line 'Net income', never 'Net profit'", () => {
    render(<ProjectionTab vm={vm5()} />);
    expect(screen.getByRole("rowheader", { name: /net income/i })).toBeInTheDocument();
    expect(screen.queryByText(/net profit/i)).not.toBeInTheDocument();
  });
});

describe("ProjectionTab — D7: no per-year '% share' sub-label", () => {
  it("renders bare 'Year N' headers with no share sub-label", () => {
    const { container } = render(<ProjectionTab vm={vm()} />);
    const head = screen.getByRole("columnheader", { name: /year 1/i });
    // The share value (6.0%) is no longer echoed under the year header.
    expect(head).not.toHaveTextContent("6.0%");
    expect(container.querySelector(".three-year-table__share")).toBeNull();
  });
});

describe("ProjectionTab — decision tiles moved to the header metric bar", () => {
  it("no longer renders the in-panel decision tiles (they live in the header)", () => {
    render(<ProjectionTab vm={vm()} />);
    expect(screen.queryByTestId("decision-tiles")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tile-capital")).not.toBeInTheDocument();
  });

  it("does NOT render the 2nd tile set (server kpis[]) — that lives in the KPIs view", () => {
    render(<ProjectionTab vm={vm()} />);
    expect(screen.queryByTestId("kpi-strip")).not.toBeInTheDocument();
  });
});

describe("ProjectionTab — table + chart", () => {
  it("renders the monthly cash-flow SVG with a break-even marker", () => {
    render(<ProjectionTab vm={vm()} />);
    expect(screen.getByTestId("cashflow-chart")).toBeInTheDocument();
    expect(screen.getByTestId("breakeven-marker")).toBeInTheDocument();
  });

  it("renders the Input/Computed/Overridden/Estimated legend", () => {
    render(<ProjectionTab vm={vm()} />);
    const legend = screen.getByTestId("table-legend");
    for (const label of ["Input", "Computed", "Overridden", "Estimated"]) {
      expect(within(legend).getByText(label)).toBeInTheDocument();
    }
  });

  it("applies the server cell-state class to each row's cells (no client classification)", () => {
    render(<ProjectionTab vm={vm()} />);
    expect(screen.getByTestId("cell-Rent-y1")).toHaveClass("cell--estimated");
    expect(screen.getByTestId("cell-Payroll-y1")).toHaveClass("cell--overridden");
    expect(screen.getByTestId("cell-Total Revenue-y1")).toHaveClass("cell--computed");
    expect(screen.getByTestId("cell-Donor market share-y1")).toHaveClass("cell--input");
  });

  it("renders server display strings verbatim (no client math)", () => {
    render(<ProjectionTab vm={vm()} />);
    expect(screen.getByTestId("cell-Payroll-y1")).toHaveTextContent("$256,146");
  });
});

describe("ProjectionTab — negative (loss) treatment [#148]", () => {
  it("flags a negative table cell with data-negative while keeping the server parentheses (non-color cue)", () => {
    const m = vm({
      rows: [
        {
          label: "Net income",
          group: "expenses",
          y1: { raw: -44433, display: "($44,433)" },
          y2: { raw: 10000, display: "$10,000" },
          y3: { raw: 20000, display: "$20,000" },
          class: "computed",
          editable: false,
        },
      ],
    });
    render(<ProjectionTab vm={m} />);
    const neg = screen.getByTestId("cell-Net income-y1");
    expect(neg).toHaveAttribute("data-negative", "true");
    expect(neg).toHaveTextContent("($44,433)");
    expect(screen.getByTestId("cell-Net income-y2")).not.toHaveAttribute("data-negative");
  });
});

describe("ProjectionTab a11y + D6 editing", () => {
  it("exposes a recompute live-region for autosave/recompute status", () => {
    render(<ProjectionTab vm={vm()} recomputeStatus="Updated" />);
    const live = screen.getByTestId("recompute-status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("Updated");
  });

  it("makes editable (input) cells keyboard-focusable and derived cells not", () => {
    render(<ProjectionTab vm={vm()} />);
    const share = screen.getByTestId("cell-Donor market share-y1");
    expect(share.tagName).toBe("BUTTON");
    const total = screen.getByTestId("cell-Total Revenue-y1");
    expect(total.tagName).not.toBe("BUTTON");
    expect(total).toHaveAttribute("aria-disabled", "true");
  });

  // D6: the hand cursor (`cell--editable`) appears ONLY when a commit seam is wired.
  // A derived cell never gets it; a read-only editable-typed cell (no onEditCell)
  // gets aria-disabled and no `cell--editable` (so no pointer cursor = no dead hand).
  it("marks a derived cell non-editable (no cell--editable, no hand cursor)", () => {
    render(<ProjectionTab vm={vm()} onEditCell={() => {}} />);
    const total = screen.getByTestId("cell-Total Revenue-y1");
    expect(total).not.toHaveClass("cell--editable");
    const share = screen.getByTestId("cell-Donor market share-y1");
    expect(share).toHaveClass("cell--editable");
  });

  it("does not show the hand-cursor affordance on an editable cell when no editor seam is wired (read-only)", () => {
    render(<ProjectionTab vm={vm()} />);
    const share = screen.getByTestId("cell-Donor market share-y1");
    expect(share).not.toHaveClass("cell--editable");
    expect(share).toHaveAttribute("aria-disabled", "true");
  });

  it("opens an inline editor on keyboard activation (Enter) and commits the typed value with the node identity", async () => {
    const seen: string[] = [];
    render(
      <ProjectionTab
        vm={vm()}
        onEditCell={(node, year, value) => seen.push(`${node}#${year}=${value}`)}
      />,
    );
    const share = screen.getByTestId("cell-Donor market share-y1");
    share.focus();
    await userEvent.keyboard("{Enter}");
    const input = screen.getByTestId("cell-Donor market share-y1-input");
    expect(input).toHaveFocus();
    expect(seen).toHaveLength(0);
    await userEvent.clear(input);
    await userEvent.type(input, "0.07{Enter}");
    expect(seen).toContain("Donor market share#1=0.07");
  });

  it("does not commit when the inline edit is cancelled with Escape", async () => {
    const seen: string[] = [];
    render(<ProjectionTab vm={vm()} onEditCell={(node, year, value) => seen.push(`${node}#${year}=${value}`)} />);
    const share = screen.getByTestId("cell-Donor market share-y1");
    share.focus();
    await userEvent.keyboard("{Enter}");
    const input = screen.getByTestId("cell-Donor market share-y1-input");
    await userEvent.clear(input);
    await userEvent.type(input, "0.09{Escape}");
    expect(seen).toHaveLength(0);
    expect(screen.getByTestId("cell-Donor market share-y1").tagName).toBe("BUTTON");
  });

  it("gives the table an accessible name and uses row headers (AA structure)", () => {
    render(<ProjectionTab vm={vm()} />);
    const table = screen.getByRole("table", { name: /3-year projection/i });
    expect(table).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: /Donor market share/i })).toBeInTheDocument();
  });
});

describe("ProjectionTab — per-field change affordance (PE7, #126)", () => {
  it("renders the FieldChange affordance on an editable cell that recently changed", () => {
    render(
      <ProjectionTab
        vm={vm()}
        fieldChanges={{ "Donor market share#1": { previous: "4.0%", by: "penny" } }}
      />,
    );
    const cell = screen.getByTestId("cell-Donor market share-y1").closest("td");
    const fc = within(cell as HTMLElement).getByTestId("field-change");
    expect(within(fc).getByTestId("field-change-badge")).toHaveTextContent(/changed by penny/i);
    expect(within(fc).getByTestId("field-change-was")).toHaveTextContent("was 4.0%");
  });

  it("per-field undo reverts THAT field — calls onUndoField with the node + year", async () => {
    const onUndoField = vi.fn();
    const user = userEvent.setup();
    render(
      <ProjectionTab
        vm={vm()}
        fieldChanges={{ "Donor market share#1": { previous: "4.0%", by: "penny" } }}
        onUndoField={onUndoField}
      />,
    );
    await user.click(screen.getByTestId("field-change-undo"));
    expect(onUndoField).toHaveBeenCalledWith("Donor market share", 1);
  });
});

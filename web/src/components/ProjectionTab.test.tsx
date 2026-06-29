import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ProjectionTab } from "./ProjectionTab";
import type { Milestones, ViewModel } from "../api/viewModel";

// Epic G (#39/#40) — the owner detail Projection panel. It renders the Appendix-D
// view-model VERBATIM but de-duplicates the decision:
//   - NO verdict (reco chip / headline / sub are suppressed here);
//   - 3 high-level tiles ONLY: Startup capital (no "required"), Break-even, Payback;
//     the first-year cash-gap tile is HIDDEN (metrics.cashGap stays in the vm);
//   - vertical order: 3-year table (TOP) → tiles → first-year cash-flow detail;
//   - the "2nd tile set" (server kpis[]) is NOT here — it moved to the KPIs tab.
// NO client math: every figure is the server's { display } string.

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
      { label: "Net profit", value: { raw: 46000, display: "$46,000" }, sub: "Year 1" },
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
      { label: "Net profit", group: "expenses", y1: { raw: 46000, display: "$46,000" }, y2: { raw: 60000, display: "$60,000" }, y3: { raw: 80000, display: "$80,000" }, class: "computed", editable: false },
    ],
    settings: {},
    version: 3,
    view_slug: "abc",
    name: "House of Hope",
    ...overrides,
  };
}

describe("ProjectionTab — Epic G decision de-duplication (#39/#40)", () => {
  it("SUPPRESSES the verdict (no reco chip / headline / sub) on the owner detail page", () => {
    render(<ProjectionTab vm={vm()} />);
    // The tiles section keeps its data-testid (the e2e/detail contract reads it)…
    expect(screen.getByTestId("decision-banner")).toBeInTheDocument();
    // …but the verdict chip + headline + sub are GONE (kept in computed_json for
    // /r/<slug> + the Board Packet, not repeated here).
    expect(screen.queryByTestId("reco-chip")).not.toBeInTheDocument();
    expect(screen.queryByText(/clears break-even/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/worst-case trough is covered/i)).not.toBeInTheDocument();
    // No verdict color tag drives the banner anymore.
    expect(screen.getByTestId("decision-banner")).not.toHaveAttribute("data-tag");
  });

  it("renders the 3 high-level tiles: Startup capital (no 'required'), Break-even, Payback", () => {
    const milestones: Milestones = {
      grandOpening: { raw: 1, display: "Month 1" },
      breakEven: { raw: 5, display: "Month 5" },
      payback: { raw: 25, display: "Month 25", duration: "25 months" },
    };
    render(<ProjectionTab vm={vm({ milestones })} />);
    const cap = screen.getByTestId("tile-capital");
    expect(cap).toHaveTextContent(/startup capital/i);
    expect(cap).not.toHaveTextContent(/required/i);
    expect(cap).toHaveTextContent("$277,990");
    expect(screen.getByTestId("tile-breakeven")).toHaveTextContent("Month 5");
    expect(screen.getByTestId("tile-payback")).toHaveTextContent("Month 25");
  });

  it("HIDES the first-year cash-gap tile (metrics.cashGap stays in the vm, just not a tile)", () => {
    render(<ProjectionTab vm={vm()} />);
    expect(screen.queryByTestId("tile-cashgap")).not.toBeInTheDocument();
    expect(screen.queryByTestId("metric-cashgap")).not.toBeInTheDocument();
    // (the trough value may still appear as a cumulative-cash figure in the monthly
    // table — that is the data, not a repeated decision tile.)
  });

  it("drops the downside/confidence 'Why?' reason disclosures on the owner detail page", () => {
    render(<ProjectionTab vm={vm()} />);
    expect(screen.queryByRole("button", { name: /why/i })).not.toBeInTheDocument();
  });

  it("does NOT render the 2nd tile set (server kpis[]) — that moved to the KPIs tab", () => {
    render(<ProjectionTab vm={vm()} />);
    expect(screen.queryByTestId("kpi-strip")).not.toBeInTheDocument();
  });

  it("keeps the back-compat metric hooks the detail/e2e contract reads", () => {
    const milestones: Milestones = {
      grandOpening: { raw: 1, display: "Month 1" },
      breakEven: { raw: 5, display: "Month 5" },
      payback: { raw: 25, display: "Month 25" },
    };
    render(<ProjectionTab vm={vm({ milestones })} />);
    expect(screen.getByTestId("metric-capital")).toBeInTheDocument();
    expect(screen.getByTestId("metric-breakeven")).toBeInTheDocument();
    expect(screen.getByTestId("metric-payback")).toBeInTheDocument();
  });

  it("orders the 3-year table ABOVE the high-level tiles, with the chart present", () => {
    render(<ProjectionTab vm={vm()} />);
    const table = screen.getByTestId("three-year-table");
    const tiles = screen.getByTestId("decision-tiles");
    // 3-year table precedes the tiles in document order (#40).
    expect(table.compareDocumentPosition(tiles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("cashflow-chart")).toBeInTheDocument();
  });
});

describe("ProjectionTab — 3-year table + chart", () => {
  it("renders the monthly cash-flow SVG with a break-even marker", () => {
    render(<ProjectionTab vm={vm()} />);
    expect(screen.getByTestId("cashflow-chart")).toBeInTheDocument();
    expect(screen.getByTestId("breakeven-marker")).toBeInTheDocument();
  });

  it("renders the 3-year table with year headers carrying the per-year share", () => {
    render(<ProjectionTab vm={vm()} />);
    const table = screen.getByTestId("three-year-table");
    const head = within(table).getByRole("columnheader", { name: /year 1/i });
    expect(head).toHaveTextContent("6.0%");
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
    expect(screen.getByTestId("tile-capital")).toHaveTextContent("$277,990");
  });
});

describe("ProjectionTab — negative (loss) treatment [#148]", () => {
  it("flags a negative table cell with data-negative while keeping the server parentheses (non-color cue)", () => {
    const m = vm({
      rows: [
        {
          label: "Net profit",
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
    const neg = screen.getByTestId("cell-Net profit-y1");
    expect(neg).toHaveAttribute("data-negative", "true");
    expect(neg).toHaveTextContent("($44,433)");
    expect(screen.getByTestId("cell-Net profit-y2")).not.toHaveAttribute("data-negative");
  });

  it("flags a negative capital tile value but not a positive one", () => {
    const neg = vm({
      metrics: {
        capital: { raw: -10000, display: "($10,000)" },
        cashGap: { raw: -219990, display: "($219,990)" },
        breakeven: { raw: 5, display: "Month 5" },
      },
    });
    const { unmount } = render(<ProjectionTab vm={neg} />);
    expect(
      screen.getByTestId("tile-capital").querySelector(".decision-tile__value"),
    ).toHaveAttribute("data-negative", "true");
    unmount();

    render(<ProjectionTab vm={vm()} />);
    expect(
      screen.getByTestId("tile-capital").querySelector(".decision-tile__value"),
    ).not.toHaveAttribute("data-negative");
  });
});

describe("ProjectionTab a11y", () => {
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
    // Enter opens the inline editor (no immediate commit) — it must replace the
    // button, land focus on the input, and only PATCH once the value settles.
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
    // The editor closes back to the value button (no PATCH).
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

describe("ProjectionTab — break-even / payback are NOT conflated [#193]", () => {
  const milestones: Milestones = {
    grandOpening: { raw: 3, display: "Month 3" },
    breakEven: { raw: 5, display: "Month 5" },
    payback: { raw: 25, display: "Month 25", duration: "25 months" },
  };

  it("labels the break-even tile 'Break-even' — never 'Break-even (payback)'", () => {
    render(<ProjectionTab vm={vm()} />);
    const be = screen.getByTestId("tile-breakeven");
    expect(be).toHaveTextContent(/break-even/i);
    expect(be).not.toHaveTextContent(/payback/i);
  });

  it("renders a SEPARATE Payback tile from milestones.payback (distinct month)", () => {
    render(<ProjectionTab vm={vm({ milestones })} />);
    expect(screen.getByTestId("tile-breakeven")).toHaveTextContent("Month 5");
    const payback = screen.getByTestId("tile-payback");
    expect(within(payback).getByText(/payback/i)).toBeInTheDocument();
    expect(payback).toHaveTextContent("Month 25");
    expect(within(payback).getByTestId("metric-payback")).toBeInTheDocument();
  });

  it("omits the Payback tile for legacy snapshots without milestones", () => {
    render(<ProjectionTab vm={vm()} />);
    expect(screen.queryByTestId("tile-payback")).not.toBeInTheDocument();
  });

  it("renders an unreached payback as N/A with reason, never a misleading 0", () => {
    const naMilestones: Milestones = {
      grandOpening: { raw: 3, display: "Month 3" },
      breakEven: { raw: 5, display: "Month 5" },
      payback: { raw: null, display: "N/A", reason: "N/A — startup costs not recovered in Year 1" },
    };
    render(<ProjectionTab vm={vm({ milestones: naMilestones })} />);
    const payback = screen.getByTestId("tile-payback");
    expect(payback).toHaveTextContent("N/A");
    expect(payback).not.toHaveTextContent("$0");
    expect(payback).toHaveTextContent(/not recovered in Year 1/i);
  });
});

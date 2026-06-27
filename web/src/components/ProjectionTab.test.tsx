import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ProjectionTab } from "./ProjectionTab";
import type { Milestones, ViewModel } from "../api/viewModel";

// SLICE 3 — the Projection tab. It renders the Appendix-D view-model VERBATIM:
// decision banner (reco chip carrying icon + TEXT, never color alone), the three
// decision tiles (capital / break-even / cash-gap, each with a downside+confidence
// detail), the hand-rolled monthly cash-flow SVG with a break-even marker, and the
// 3-year table with an Input/Computed/Overridden/Estimated legend + per-cell state
// classes. NO client math: every figure is the server's { display } string.

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

describe("ProjectionTab", () => {
  it("renders the decision banner with reco text (not color alone) + headline + sub", () => {
    render(<ProjectionTab vm={vm()} />);
    const banner = screen.getByTestId("decision-banner");
    expect(banner).toHaveAttribute("data-tag", "proceed");
    // Meaning carried in TEXT: the chip label, not only a color token.
    expect(within(banner).getByTestId("reco-chip")).toHaveTextContent(/proceed/i);
    expect(screen.getByText(/clears break-even/i)).toBeInTheDocument();
    expect(screen.getByText(/worst-case trough is covered/i)).toBeInTheDocument();
  });

  it("hides each decision reason until its Why? disclosure is tapped", async () => {
    const user = userEvent.setup();
    render(<ProjectionTab vm={vm()} />);

    const cap = screen.getByTestId("tile-capital");
    expect(cap).toHaveTextContent("$277,990");
    const capWhy = within(cap).getByRole("button", { name: /why/i });
    // In the DOM (so aria-controls resolves) but hidden + collapsed by default.
    const capReason = within(cap).getByRole("note", { hidden: true });
    expect(capWhy).toHaveAttribute("aria-expanded", "false");
    expect(capReason).not.toBeVisible();
    await user.click(capWhy);
    expect(capWhy).toHaveAttribute("aria-expanded", "true");
    expect(capReason).toBeVisible();
    expect(capReason).toHaveTextContent(/reserve/i);
    await user.click(capWhy); // collapses again
    expect(capReason).not.toBeVisible();

    const be = screen.getByTestId("tile-breakeven");
    expect(be).toHaveTextContent("Month 5");
    await user.click(within(be).getByRole("button", { name: /why/i }));
    expect(within(be).getByRole("note")).toHaveTextContent(/operating net/i);

    const gap = screen.getByTestId("tile-cashgap");
    expect(gap).toHaveTextContent("($219,990)");
    await user.click(within(gap).getByRole("button", { name: /why/i }));
    expect(within(gap).getByRole("note")).toHaveTextContent(/cumulative cash/i);
  });

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
    // Parenthesized negative from the server — rendered as-is, never re-derived.
    expect(screen.getByTestId("cell-Payroll-y1")).toHaveTextContent("$256,146");
    expect(screen.getByTestId("tile-cashgap")).toHaveTextContent("($219,990)");
  });

  it("never inlines a hex color on the banner/chip (token mapping is CSS)", () => {
    render(<ProjectionTab vm={vm()} />);
    expect(screen.getByTestId("reco-chip").getAttribute("style")).toBeNull();
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
    // Color cue (CSS [data-negative]) is PAIRED with the server's parentheses,
    // which remain the non-color cue — meaning is never carried by color alone.
    expect(neg).toHaveAttribute("data-negative", "true");
    expect(neg).toHaveTextContent("($44,433)");
    // A positive sibling cell carries no negative hook.
    expect(screen.getByTestId("cell-Net profit-y2")).not.toHaveAttribute("data-negative");
  });

  it("flags the negative cash-gap decision tile value but not the positive capital tile", () => {
    render(<ProjectionTab vm={vm()} />);
    const gapValue = screen.getByTestId("tile-cashgap").querySelector(".decision-tile__value")!;
    expect(gapValue).toHaveAttribute("data-negative", "true");
    expect(gapValue).toHaveTextContent("($219,990)");
    const capValue = screen.getByTestId("tile-capital").querySelector(".decision-tile__value")!;
    expect(capValue).not.toHaveAttribute("data-negative");
  });

  it("flags a negative KPI value but not a positive one", () => {
    const m = vm({
      kpis: [
        { label: "Total revenue", value: { raw: 426911, display: "$426,911" }, sub: "Year 1" },
        { label: "Net profit", value: { raw: -44433, display: "($44,433)" }, sub: "Year 1" },
      ],
    });
    render(<ProjectionTab vm={m} />);
    const strip = screen.getByTestId("kpi-strip");
    expect(within(strip).getByText("($44,433)")).toHaveAttribute("data-negative", "true");
    expect(within(strip).getByText("$426,911")).not.toHaveAttribute("data-negative");
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
    // Editable driver cell is a button (Enter/Space activatable).
    const share = screen.getByTestId("cell-Donor market share-y1");
    expect(share.tagName).toBe("BUTTON");
    // Derived total is read-only — not a button, marked aria-disabled.
    const total = screen.getByTestId("cell-Total Revenue-y1");
    expect(total.tagName).not.toBe("BUTTON");
    expect(total).toHaveAttribute("aria-disabled", "true");
  });

  it("activates an editable cell via keyboard (Enter) and reports the node", async () => {
    const seen: string[] = [];
    render(<ProjectionTab vm={vm()} onEditCell={(node, year) => seen.push(`${node}#${year}`)} />);
    const share = screen.getByTestId("cell-Donor market share-y1");
    share.focus();
    await userEvent.keyboard("{Enter}");
    expect(seen).toContain("Donor market share#1");
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
    // recent-change badge (icon + text, not color alone) + subtle "was X".
    expect(within(fc).getByTestId("field-change-badge")).toHaveTextContent(/changed by penny/i);
    expect(within(fc).getByTestId("field-change-was")).toHaveTextContent("was 4.0%");
  });

  it("does not render the affordance on cells with no recent change", () => {
    render(<ProjectionTab vm={vm()} fieldChanges={{ "Donor market share#1": { previous: "4.0%" } }} />);
    // The Rent editable cell has no change entry → no affordance there.
    const rent = screen.getByTestId("cell-Rent-y1").closest("td");
    expect(within(rent as HTMLElement).queryByTestId("field-change")).not.toBeInTheDocument();
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

  it("renders no undo control when onUndoField is absent (display-only)", () => {
    render(
      <ProjectionTab
        vm={vm()}
        fieldChanges={{ "Donor market share#1": { previous: "4.0%", by: "penny" } }}
      />,
    );
    expect(screen.queryByTestId("field-change-undo")).not.toBeInTheDocument();
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
    // The conflated label is gone — break-even must not claim it is payback.
    expect(be).not.toHaveTextContent(/payback/i);
  });

  it("renders a SEPARATE Payback tile from milestones.payback (distinct month)", () => {
    render(<ProjectionTab vm={vm({ milestones })} />);
    const be = screen.getByTestId("tile-breakeven");
    expect(be).toHaveTextContent("Month 5");
    const payback = screen.getByTestId("tile-payback");
    expect(within(payback).getByText(/payback/i)).toBeInTheDocument();
    // The recovered-investment month is its own number, not the break-even month.
    expect(payback).toHaveTextContent("Month 25");
    // Back-compat metric hook mirrors the DecisionBanner.
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

describe("ProjectionTab — cash-gap label is sign-aware [#194]", () => {
  it("labels a negative trough 'First-year cash gap' (a real shortfall)", () => {
    render(<ProjectionTab vm={vm()} />);
    const gap = screen.getByTestId("tile-cashgap");
    expect(gap).toHaveTextContent(/First-year cash gap/i);
    expect(gap).toHaveTextContent("($219,990)");
  });

  it("labels a positive trough 'Lowest first-year cash balance' — a cushion, not a gap", () => {
    const m = vm({
      metrics: {
        capital: { raw: 277990, display: "$277,990" },
        cashGap: { raw: 40000, display: "$40,000" },
        breakeven: { raw: 5, display: "Month 5" },
        reasonGap: "Most-negative cumulative cash across the first year.",
      },
    });
    render(<ProjectionTab vm={m} />);
    const gap = screen.getByTestId("tile-cashgap");
    expect(gap).toHaveTextContent(/Lowest first-year cash balance/i);
    expect(gap).not.toHaveTextContent(/cash gap/i);
    // Server display verbatim; a positive cushion carries no negative color cue.
    expect(gap).toHaveTextContent("$40,000");
    expect(gap.querySelector(".decision-tile__value")).not.toHaveAttribute("data-negative");
  });
});

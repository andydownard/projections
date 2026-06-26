import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ProjectionTab } from "./ProjectionTab";
import type { ViewModel } from "../api/viewModel";

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

  it("renders the three decision tiles, each with value + downside/confidence detail", () => {
    render(<ProjectionTab vm={vm()} />);
    const cap = screen.getByTestId("tile-capital");
    expect(cap).toHaveTextContent("$277,990");
    expect(cap).toHaveTextContent(/reserve/i); // reasonCapital detail

    const be = screen.getByTestId("tile-breakeven");
    expect(be).toHaveTextContent("Month 5");
    expect(be).toHaveTextContent(/operating net/i); // reasonBreakeven detail

    const gap = screen.getByTestId("tile-cashgap");
    expect(gap).toHaveTextContent("($219,990)");
    expect(gap).toHaveTextContent(/cumulative cash/i); // reasonGap detail
  });

  it("labels the tiles with the canonical metric vocabulary (UX fix #10)", () => {
    render(<ProjectionTab vm={vm()} />);
    expect(within(screen.getByTestId("tile-capital")).getByText("Startup capital required")).toBeInTheDocument();
    expect(within(screen.getByTestId("tile-breakeven")).getByText("Break-even month")).toBeInTheDocument();
    expect(within(screen.getByTestId("tile-cashgap")).getByText("First-year cash gap")).toBeInTheDocument();
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

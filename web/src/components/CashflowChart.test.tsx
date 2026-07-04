import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CashflowChart } from "./CashflowChart";
import type { Milestones, MonthlyPoint } from "../api/viewModel";

// A server money value {raw, display} — display matches the server convention
// (whole dollars, "$", parentheses for negatives) since the module renders it
// verbatim (never re-derives it).
function sv(raw: number) {
  const abs = Math.abs(Math.round(raw));
  const grouped = abs.toLocaleString("en-US");
  return { raw, display: raw < 0 ? `($${grouped})` : `$${grouped}` };
}

function pt(month: number, revenue: number, expenses: number, net: number, cum: number): MonthlyPoint {
  return {
    month,
    revenue: sv(revenue),
    expenses: sv(expenses),
    net: sv(net),
    cumulativeCash: sv(cum),
  };
}

// A full 60-month series with grand opening at month 1 (no pre-opening). A deep
// startup trough early, break-even mid-year-1, recovering thereafter.
function series60(): MonthlyPoint[] {
  const pts: MonthlyPoint[] = [];
  for (let m = 1; m <= 60; m++) {
    // A cumulative curve that dips to a trough around month 4 then climbs.
    const cum = m <= 4 ? -50000 * m : -200000 + (m - 4) * 8000;
    const net = m === 1 ? -200000 : m <= 4 ? -50000 : 8000;
    pts.push(pt(m, 20000 + m * 100, 25000, net, cum));
  }
  return pts;
}

const milestones60: Milestones = {
  grandOpening: { raw: 1, display: "Month 1" },
  breakEven: { raw: 29, display: "Month 29" },
  payback: { raw: 45, display: "Month 45", duration: "44 months" },
};

// A series whose grand opening is month 3 → months 1-2 are Pre-opening.
function seriesPreopen(): MonthlyPoint[] {
  const pts: MonthlyPoint[] = [];
  for (let m = 1; m <= 27; m++) {
    pts.push(pt(m, 10000, 12000, m < 3 ? -30000 : -2000, -30000 * Math.min(m, 3) - m * 100));
  }
  return pts;
}
const milestonesPreopen: Milestones = {
  grandOpening: { raw: 3, display: "Month 3" },
  breakEven: { raw: 10, display: "Month 10" },
  payback: { raw: 22, display: "Month 22", duration: "20 months" },
};

// A legacy 2.6.0-era snapshot: 12 monthly rows, NO milestones block.
function legacy12(): MonthlyPoint[] {
  const pts: MonthlyPoint[] = [];
  for (let m = 1; m <= 12; m++) pts.push(pt(m, 1000 * m, 500 * m, 500 * m, 500 * m));
  return pts;
}

describe("CashflowChart module", () => {
  it("renders the 'Cash flow' module with a CSV export link (href + download)", () => {
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} viewSlug="abc123" />);
    expect(screen.getByTestId("cashflow-module")).toHaveAttribute("aria-label", "Cash flow");
    expect(screen.getByRole("heading", { level: 2, name: "Cash flow" })).toBeInTheDocument();
    const csv = screen.getByTestId("cashflow-export");
    expect(csv).toHaveAttribute("href", "/api/projections/abc123/cashflow.csv");
    expect(csv).toHaveAttribute("download");
  });

  it("omits the CSV link when no viewSlug is available", () => {
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />);
    expect(screen.queryByTestId("cashflow-export")).not.toBeInTheDocument();
  });

  it("renders an SVG cash-flow figure with role=img and a headline aria-label", () => {
    const { container } = render(
      <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
    );
    expect(screen.getByTestId("cashflow-chart")).toBeInTheDocument();
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("role", "img");
    expect(svg.getAttribute("aria-label")).toMatch(/table below/i);
  });

  it("draws one net bar per month across the full 60-month horizon (dual-axis, not a slice)", () => {
    const { container } = render(
      <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
    );
    expect(container.querySelectorAll(".cashflow-chart__bar")).toHaveLength(60);
    expect(container.querySelector(".cashflow-chart__line")).toBeInTheDocument();
  });

  it("signs the net bars: positive bars are base, negative bars carry --neg", () => {
    const { container } = render(
      <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
    );
    // Month 1 net is a deep loss → a --neg bar exists; later months are positive.
    expect(container.querySelectorAll(".cashflow-chart__bar--neg").length).toBeGreaterThan(0);
    const positive = container.querySelectorAll(".cashflow-chart__bar:not(.cashflow-chart__bar--neg)");
    expect(positive.length).toBeGreaterThan(0);
  });

  it("labels the right (cumulative) axis with nice-number $ ticks incl. $0", () => {
    const { container } = render(
      <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
    );
    const right = Array.from(container.querySelectorAll(".cashflow-chart__axis-tick--right")).map(
      (t) => t.textContent,
    );
    expect(right).toContain("$0");
    // A client-derived nice number (e.g. ($200,000)/($100,000)) — parenthesized neg.
    expect(right.some((t) => /^\(\$[\d,]+\)$/.test(t ?? ""))).toBe(true);
  });

  it("anchors both axes' $0 on the same pixel row (shared-zero)", () => {
    const { container } = render(
      <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
    );
    const zeroRight = Array.from(container.querySelectorAll(".cashflow-chart__axis-tick--right")).find(
      (t) => t.textContent === "$0",
    );
    const zeroLeft = Array.from(container.querySelectorAll(".cashflow-chart__axis-tick--left")).find(
      (t) => t.textContent === "$0",
    );
    expect(zeroRight).toBeTruthy();
    expect(zeroLeft).toBeTruthy();
    expect(zeroRight!.getAttribute("y")).toBe(zeroLeft!.getAttribute("y"));
  });

  it("replaces the standalone legend with two axis titles (net + cumulative)", () => {
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />);
    // The old legend LIST is gone.
    expect(screen.queryByTestId("cashflow-legend")).not.toBeInTheDocument();
    const svg = screen.getByTestId("cashflow-chart").querySelector("svg")!;
    expect(svg.textContent).toMatch(/Monthly net/);
    expect(svg.textContent).toMatch(/Cumulative cash/);
  });

  it("draws year dividers + Year labels across the horizon", () => {
    const { container } = render(
      <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
    );
    expect(container.querySelectorAll(".cashflow-chart__year-divider").length).toBeGreaterThan(0);
    const labels = Array.from(container.querySelectorAll(".cashflow-chart__year-label")).map(
      (t) => t.textContent,
    );
    expect(labels).toContain("Year 1");
    expect(labels).toContain("Year 5");
  });

  it("draws a pre-opening band + caption when grand opening is after month 1", () => {
    const { container } = render(
      <CashflowChart monthly={seriesPreopen()} breakevenMonth={10} milestones={milestonesPreopen} />,
    );
    expect(container.querySelector(".cashflow-chart__preopen-band")).toBeInTheDocument();
    expect(container.textContent).toMatch(/Pre-opening/);
  });

  // ── the grouped table ──────────────────────────────────────────────────────
  it("renders ONE table with the five month columns and a <tbody> per year group", () => {
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />);
    const table = screen.getByTestId("cashflow-table");
    expect(table.tagName).toBe("TABLE");
    const cols = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(cols).toEqual(["Month", "Revenue", "Expenses", "Net", "Cumulative cash"]);
    // Five operating-year groups (opening month 1 → no pre-opening).
    expect(table.querySelectorAll("tbody.cashflow-table__group").length).toBe(5);
  });

  it("gives each group a native <button aria-expanded> toggle", () => {
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />);
    const toggle = screen.getByTestId("cashflow-group-toggle-year-1");
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls");
  });

  it("shows the group's ending cash (last-month cumulative, verbatim server display)", () => {
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />);
    const toggle = screen.getByTestId("cashflow-group-toggle-year-1");
    // Year 1 = months 1..12; ending cash = month 12 cumulative display.
    const y1EndingRaw = series60().find((m) => m.month === 12)!.cumulativeCash.display;
    expect(toggle.textContent).toContain("Ending cash");
    expect(toggle.textContent).toContain(y1EndingRaw);
  });

  it("expands Pre-opening + Year 1 by default and collapses Years 2-5", () => {
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />);
    // Year-1 month rows are visible (not hidden).
    expect(screen.getByTestId("cashflow-month-1")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("cashflow-month-12")).not.toHaveAttribute("hidden");
    // Year-2 month row is present in the DOM but hidden.
    expect(screen.getByTestId("cashflow-month-13")).toHaveAttribute("hidden");
    expect(screen.getByTestId("cashflow-group-toggle-year-2")).toHaveAttribute("aria-expanded", "false");
  });

  it("also auto-expands the group containing break-even when it falls outside Year 1", () => {
    // break-even month 29 → Year 3 (months 25..36). It must start expanded.
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />);
    expect(screen.getByTestId("cashflow-group-toggle-year-3")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("cashflow-month-29")).not.toHaveAttribute("hidden");
  });

  it("toggles a collapsed group open on click (aria-expanded flips, rows un-hide)", () => {
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />);
    const toggle = screen.getByTestId("cashflow-group-toggle-year-2");
    expect(screen.getByTestId("cashflow-month-13")).toHaveAttribute("hidden");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("cashflow-month-13")).not.toHaveAttribute("hidden");
  });

  it("flags the break-even and payback month rows (icon + sr-only label)", () => {
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />);
    // Break-even row (month 29, Year 3 — expanded by the auto-expand rule).
    const be = screen.getByTestId("cashflow-month-29");
    expect(be.textContent).toMatch(/break-even/i);
    // Payback row (month 45, Year 4 — expand it first, then assert the flag).
    fireEvent.click(screen.getByTestId("cashflow-group-toggle-year-4"));
    expect(screen.getByTestId("cashflow-month-45").textContent).toMatch(/payback/i);
  });

  it("flags the grand-opening month row", () => {
    render(<CashflowChart monthly={seriesPreopen()} breakevenMonth={10} milestones={milestonesPreopen} />);
    expect(screen.getByTestId("cashflow-month-3")).toHaveAttribute("data-grand-opening", "true");
    expect(screen.getByTestId("cashflow-month-4")).not.toHaveAttribute("data-grand-opening");
  });

  // ── bidirectional hover / focus linking ────────────────────────────────────
  it("hovering a visible table row highlights it AND shows the chart point (row→chart)", () => {
    const { container } = render(
      <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
    );
    const row = screen.getByTestId("cashflow-month-2"); // Year 1, visible
    expect(container.querySelector(".cashflow-chart__point")).toBeNull();
    fireEvent.mouseEnter(row);
    expect(row).toHaveClass("cashflow-table__row--active");
    expect(container.querySelector(".cashflow-chart__point")).toBeInTheDocument();
    expect(container.querySelector(".cashflow-chart__crosshair")).toBeInTheDocument();
  });

  it("has a keyboard scrubber (role=slider) that moves the active month (chart→row)", () => {
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />);
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("aria-valuemin", "1");
    expect(slider).toHaveAttribute("aria-valuemax", "60");
    slider.focus();
    fireEvent.keyDown(slider, { key: "Home" }); // month 1
    expect(slider).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByTestId("cashflow-month-1")).toHaveClass("cashflow-table__row--active");
    expect(slider.getAttribute("aria-valuetext")).toMatch(/Month 1/);
    fireEvent.keyDown(slider, { key: "ArrowRight" }); // month 2
    expect(slider).toHaveAttribute("aria-valuenow", "2");
  });

  it("auto-expands + reveals the landed month's group when the scrubber lands in a collapsed group", () => {
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />);
    const slider = screen.getByRole("slider");
    // Year 5 (months 49-60) starts collapsed; End lands on month 60.
    expect(screen.getByTestId("cashflow-month-60")).toHaveAttribute("hidden");
    slider.focus();
    fireEvent.keyDown(slider, { key: "End" });
    expect(slider).toHaveAttribute("aria-valuenow", "60");
    expect(screen.getByTestId("cashflow-month-60")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("cashflow-group-toggle-year-5")).toHaveAttribute("aria-expanded", "true");
  });

  // ── a11y text alternative ──────────────────────────────────────────────────
  it("provides an sr-only milestone summary incl. an unreached milestone's N/A reason", () => {
    const naMilestones: Milestones = {
      grandOpening: { raw: 1, display: "Month 1" },
      breakEven: { raw: 29, display: "Month 29" },
      payback: {
        raw: null,
        display: "N/A",
        reason: "N/A — startup costs are not recovered within the projection horizon",
      },
    };
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={naMilestones} />);
    const sr = screen.getByTestId("chart-milestones-sr");
    expect(sr).toHaveTextContent("Grand Opening");
    expect(sr).toHaveTextContent("Break-even");
    expect(sr).toHaveTextContent("startup costs are not recovered");
  });

  it("colors negative table cells via the server parentheses display (never color alone) [#148]", () => {
    const rows: MonthlyPoint[] = [pt(1, 0, 31870, -14793, -199793), pt(2, 20000, 10000, 10000, 5000)];
    render(<CashflowChart monthly={rows} breakevenMonth={2} />);
    const table = screen.getByTestId("cashflow-table");
    expect(within(table).getByText("($14,793)")).toHaveAttribute("data-negative", "true");
    expect(within(table).getByText("$20,000")).not.toHaveAttribute("data-negative");
  });

  // ── legacy degradation ─────────────────────────────────────────────────────
  it("renders a legacy 12-row snapshot with no milestones (G=1 fallback, one Year 1 group)", () => {
    render(<CashflowChart monthly={legacy12()} breakevenMonth={null} />);
    const table = screen.getByTestId("cashflow-table");
    // No milestones → G=1 → all 12 months in a single Year 1 group.
    expect(table.querySelectorAll("tbody.cashflow-table__group").length).toBe(1);
    expect(screen.getByTestId("cashflow-group-toggle-year-1")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("cashflow-month-1")).toBeInTheDocument();
    expect(screen.getByTestId("cashflow-month-12")).toBeInTheDocument();
  });

  it("renders nothing but an empty-state caption when there is no monthly data", () => {
    render(<CashflowChart monthly={[]} breakevenMonth={null} />);
    expect(screen.getByTestId("cashflow-chart")).toBeInTheDocument();
    expect(screen.getByText(/no monthly cash-flow data/i)).toBeInTheDocument();
  });
});

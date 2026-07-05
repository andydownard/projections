import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CashflowChart } from "./CashflowChart";
import type { Milestones, MonthlyPoint } from "../api/viewModel";

const here = dirname(fileURLToPath(import.meta.url));

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
  it("renders the 'Cash position and change by month' module with a CSV export link (href + download)", () => {
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} viewSlug="abc123" />);
    expect(screen.getByTestId("cashflow-module")).toHaveAttribute("aria-label", "Cash position and change by month");
    expect(screen.getByRole("heading", { level: 2, name: "Cash position and change by month" })).toBeInTheDocument();
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

  // ── owner-feedback polish (2026-07-04 second live review) — rotated axis
  // titles. The horizontal top-row title chips read as sloppy/unlabeled to the
  // owner; they are replaced with CONVENTIONAL rotated y-axis titles, one in
  // each gutter, vertically centered on the plot, glyph riding along with the
  // text as one rotated group. "($)" is dropped from both — the tick labels
  // already carry "$", so repeating it in the title is redundant. ──────────────
  describe("rotated axis titles (owner item, 2026-07-04 second review)", () => {
    it("drops the redundant '($)' from both axis titles — ticks already show $", () => {
      render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />);
      const net = screen.getByTestId("cashflow-axis-title-net");
      const cum = screen.getByTestId("cashflow-axis-title-cum");
      expect(net.textContent).toBe("Monthly net");
      expect(cum.textContent).toBe("Cumulative cash");
      expect(net.textContent).not.toMatch(/\(\$\)/);
      expect(cum.textContent).not.toMatch(/\(\$\)/);
    });

    it("rotates the net title -90° (reads bottom-to-top) and the cumulative title 90° (reads top-to-bottom)", () => {
      const { container } = render(
        <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
      );
      const netGroup = container.querySelector(".cashflow-chart__axis-label--net")!;
      const cumGroup = container.querySelector(".cashflow-chart__axis-label--cum")!;
      const netTransform = netGroup.getAttribute("transform") ?? "";
      const cumTransform = cumGroup.getAttribute("transform") ?? "";
      expect(netTransform).toMatch(/^rotate\(-90 /);
      expect(cumTransform).toMatch(/^rotate\(90 /);
    });

    it("vertically centers both rotated titles on the plot area, on the SAME pixel row", () => {
      const { container } = render(
        <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
      );
      const netGroup = container.querySelector(".cashflow-chart__axis-label--net")!;
      const cumGroup = container.querySelector(".cashflow-chart__axis-label--cum")!;
      const parse = (t: string) => t.match(/rotate\((-?[\d.]+) ([\d.]+) ([\d.]+)\)/)!;
      const [, , netCx, netCy] = parse(netGroup.getAttribute("transform")!);
      const [, , cumCx, cumCy] = parse(cumGroup.getAttribute("transform")!);
      // Plot area is H=300, padT=44, padB=28 → plotH=228 → vertical center = 158,
      // fixed regardless of viewport width (chart geometry constant).
      expect(netCy).toBe("158");
      expect(cumCy).toBe(netCy);
      // The net title sits in the LEFT gutter, the cumulative title in the RIGHT.
      expect(parseFloat(netCx)).toBeLessThan(parseFloat(cumCx));
    });

    it("places the net title in the left gutter and the cumulative title in the right gutter (outside the tick labels)", () => {
      const { container } = render(
        <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
      );
      const netGroup = container.querySelector(".cashflow-chart__axis-label--net")!;
      const cumGroup = container.querySelector(".cashflow-chart__axis-label--cum")!;
      const parse = (t: string) => parseFloat(t.match(/rotate\(-?[\d.]+ ([\d.]+)/)![1]);
      const netCx = parse(netGroup.getAttribute("transform")!);
      const cumCx = parse(cumGroup.getAttribute("transform")!);
      // Wide viewBox is 660 units wide; the net pivot is near the left edge,
      // the cumulative pivot near the right edge.
      expect(netCx).toBeLessThan(30);
      expect(cumCx).toBeGreaterThan(630);
    });

    it("renders the glyph BEFORE the text in DOM/reading order for both titles", () => {
      const { container } = render(
        <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
      );
      const netGroup = container.querySelector(".cashflow-chart__axis-label--net")!;
      const cumGroup = container.querySelector(".cashflow-chart__axis-label--cum")!;
      const netChildren = Array.from(netGroup.children).map((c) => c.tagName.toLowerCase());
      const cumChildren = Array.from(cumGroup.children).map((c) => c.tagName.toLowerCase());
      expect(netChildren.indexOf("text")).toBe(netChildren.length - 1);
      expect(cumChildren.indexOf("text")).toBe(cumChildren.length - 1);
    });

    it("still renders both titles rotated + centered at the narrow (<=480px) viewport", () => {
      const mql = {
        matches: true,
        media: "(max-width: 480px)",
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mql as unknown as MediaQueryList));
      const { container } = render(
        <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
      );
      const netGroup = container.querySelector(".cashflow-chart__axis-label--net")!;
      const cumGroup = container.querySelector(".cashflow-chart__axis-label--cum")!;
      expect(netGroup.getAttribute("transform")).toMatch(/^rotate\(-90 /);
      expect(cumGroup.getAttribute("transform")).toMatch(/^rotate\(90 /);
      // Narrow viewBox is 380 units wide; the cumulative pivot tracks the
      // narrower right edge (never clipped, never dropped).
      const cumCx = parseFloat(
        cumGroup.getAttribute("transform")!.match(/rotate\(-?[\d.]+ ([\d.]+)/)![1],
      );
      expect(cumCx).toBeGreaterThan(350);
      expect(cumCx).toBeLessThan(380);
      vi.unstubAllGlobals();
    });
  });

  // ── owner-feedback polish (2026-07-04 live review) ─────────────────────────
  it("marks the axis-title swatches aria-hidden (the text label already names the series)", () => {
    const { container } = render(
      <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
    );
    const netSwatches = container.querySelectorAll(
      ".cashflow-chart__axis-swatch--net-pos, .cashflow-chart__axis-swatch--net-neg",
    );
    const cumSwatches = container.querySelectorAll(
      ".cashflow-chart__axis-swatch--cum, .cashflow-chart__axis-swatch--cum-dot",
    );
    expect(netSwatches.length).toBeGreaterThan(0);
    expect(cumSwatches.length).toBeGreaterThan(0);
    [...netSwatches, ...cumSwatches].forEach((el) => {
      expect(el).toHaveAttribute("aria-hidden", "true");
    });
  });

  it("net gridlines span the full plot width and never duplicate a cumulative gridline row (item 2, collision rule)", () => {
    const { container } = render(
      <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
    );
    const netLines = Array.from(container.querySelectorAll(".cashflow-chart__gridline--net"));
    const cumLines = Array.from(
      container.querySelectorAll(".cashflow-chart__gridline:not(.cashflow-chart__gridline--net)"),
    );
    expect(netLines.length).toBeGreaterThan(0);
    expect(cumLines.length).toBeGreaterThan(0);
    // Full width: same x1/x2 span as the cumulative (hero) gridlines.
    const [plotX1, plotX2] = [cumLines[0].getAttribute("x1"), cumLines[0].getAttribute("x2")];
    netLines.forEach((l) => {
      expect(l.getAttribute("x1")).toBe(plotX1);
      expect(l.getAttribute("x2")).toBe(plotX2);
    });
    // Collision rule: no net gridline within 1 viewBox unit of any cumulative one.
    const cumYs = cumLines.map((l) => parseFloat(l.getAttribute("y1")!));
    netLines.forEach((l) => {
      const y = parseFloat(l.getAttribute("y1")!);
      expect(cumYs.some((cy) => Math.abs(cy - y) < 1)).toBe(false);
    });
  });

  it("never draws a duplicate net gridline at the shared-zero row (item 2)", () => {
    const { container } = render(
      <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
    );
    const zeroY = container.querySelector(".cashflow-chart__zero")!.getAttribute("y1");
    const netAtZero = Array.from(container.querySelectorAll(".cashflow-chart__gridline--net")).some(
      (l) => l.getAttribute("y1") === zeroY,
    );
    expect(netAtZero).toBe(false);
  });

  it("gives every month row a fixed leading milestone slot BEFORE 'M{n}' (item 3, consistent labels)", () => {
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />);
    // Month 1 carries the Grand Opening flag; month 2 carries none.
    const flaggedCell = screen.getByTestId("cashflow-month-1").querySelector(".cashflow-table__label")!;
    const plainCell = screen.getByTestId("cashflow-month-2").querySelector(".cashflow-table__label")!;
    expect(flaggedCell.firstElementChild).toHaveClass("cashflow-table__milestone-slot");
    expect(plainCell.firstElementChild).toHaveClass("cashflow-table__milestone-slot");
    // The month text is the LAST child in both — the slot never pushes into it,
    // so "M1".."M60" all start at the identical x regardless of flags.
    expect(flaggedCell.lastChild?.textContent).toBe("M1");
    expect(plainCell.lastChild?.textContent).toBe("M2");
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

// ── review C1: the shared-zero pass must stay NON-DEGENERATE when a series is
// one-signed. On the CANONICAL 60%-labor default (payback N/A → cumulative never
// reaches $0 → cum.max === 0) the unguarded pass yielded zeroFrac=1 → zeroY=padT
// → sNet=0: all 60 net bars collapsed to the 0.5px floor and every left-axis
// label stacked on one y. Pinned to the REAL golden fixture, not a synthetic. ──
describe("shared-zero degenerate guard (review C1)", () => {
  const golden = JSON.parse(
    readFileSync(
      join(here, "..", "..", "..", "engine", "tests", "golden", "house_of_hope_canonical_60.json"),
      "utf8",
    ),
  ) as { monthly: MonthlyPoint[]; breakevenMonth: number | null; milestones: Milestones };

  it("canonical 60%-labor golden: net bars are visible and VARY; left tick ys are distinct", () => {
    const { container } = render(
      <CashflowChart
        monthly={golden.monthly}
        breakevenMonth={golden.breakevenMonth}
        milestones={golden.milestones}
      />,
    );
    const heights = Array.from(container.querySelectorAll(".cashflow-chart__bar")).map((b) =>
      parseFloat(b.getAttribute("height") ?? "0"),
    );
    expect(heights).toHaveLength(60);
    // The bars must not all sit at the 0.5px degenerate floor: they vary, and the
    // deep month-1 loss bar is tall.
    expect(new Set(heights.map((h) => h.toFixed(1))).size).toBeGreaterThan(1);
    expect(Math.max(...heights)).toBeGreaterThan(20);
    // Left (net) axis tick labels render on DISTINCT rows, never stacked.
    const leftYs = Array.from(container.querySelectorAll(".cashflow-chart__axis-tick--left")).map(
      (t) => t.getAttribute("y"),
    );
    expect(leftYs.length).toBeGreaterThan(1);
    expect(new Set(leftYs).size).toBe(leftYs.length);
    // The shared-$0 property is PRESERVED: both axes' $0 on the same pixel row.
    const zeroY = (sel: string) =>
      Array.from(container.querySelectorAll(sel))
        .find((t) => t.textContent === "$0")!
        .getAttribute("y");
    expect(zeroY(".cashflow-chart__axis-tick--right")).toBe(zeroY(".cashflow-chart__axis-tick--left"));
  });

  it("mirror case: both series entirely non-negative stays well-formed (bars vary, ticks distinct, $0 on both axes)", () => {
    // A profitable-from-day-1 shape: every net >= 0, cumulative never below 0
    // (min === 0 on both domains — the zeroFrac=0 mirror of the C1 case).
    const pts: MonthlyPoint[] = [];
    let cum = 0;
    for (let m = 1; m <= 24; m++) {
      const net = 1000 * m;
      cum += net;
      pts.push(pt(m, 2000 * m, 1000 * m, net, cum));
    }
    const { container } = render(<CashflowChart monthly={pts} breakevenMonth={1} />);
    const heights = Array.from(container.querySelectorAll(".cashflow-chart__bar")).map((b) =>
      parseFloat(b.getAttribute("height") ?? "0"),
    );
    expect(new Set(heights.map((h) => h.toFixed(1))).size).toBeGreaterThan(1);
    expect(Math.max(...heights)).toBeGreaterThan(20);
    const leftYs = Array.from(container.querySelectorAll(".cashflow-chart__axis-tick--left")).map(
      (t) => t.getAttribute("y"),
    );
    expect(new Set(leftYs).size).toBe(leftYs.length);
    const rightTicks = Array.from(
      container.querySelectorAll(".cashflow-chart__axis-tick--right"),
    ).map((t) => t.textContent);
    expect(rightTicks).toContain("$0");
  });
});

// ── review C2 + I1: plot→row pointer hover and tap/click-to-pin. The scrubber
// rect is the single pointer surface (the whole month band = the ≥24px hit
// target). jsdom has no layout, so the rect's box is mocked. ──
function mockScrubberRect(scrubber: Element) {
  vi.spyOn(scrubber, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    x: 0,
    y: 0,
    width: 600,
    height: 228,
    right: 600,
    bottom: 228,
    toJSON: () => ({}),
  } as DOMRect);
}
// The mocked plot is 600px wide over 60 months → each band 10px; band center of
// month m is at (m - 0.5) * 10.
const bandX = (month: number) => (month - 0.5) * 10;

describe("plot→row pointer hover (review C2)", () => {
  function setup() {
    const utils = render(
      <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
    );
    const scrubber = screen.getByTestId("cashflow-scrubber");
    mockScrubberRect(scrubber);
    return { ...utils, scrubber };
  }

  it("mousemove over a month band highlights that month's table row + crosshair + point + tooltip", () => {
    const { container, scrubber } = setup();
    fireEvent.mouseMove(scrubber, { clientX: bandX(2) });
    expect(screen.getByTestId("cashflow-month-2")).toHaveClass("cashflow-table__row--active");
    expect(container.querySelector(".cashflow-chart__crosshair")).toBeInTheDocument();
    expect(container.querySelector(".cashflow-chart__point")).toBeInTheDocument();
    expect(screen.getByTestId("cashflow-tooltip")).toBeInTheDocument();
  });

  it("moving to another band moves the linked highlight", () => {
    const { scrubber } = setup();
    fireEvent.mouseMove(scrubber, { clientX: bandX(2) });
    fireEvent.mouseMove(scrubber, { clientX: bandX(5) });
    expect(screen.getByTestId("cashflow-month-5")).toHaveClass("cashflow-table__row--active");
    expect(screen.getByTestId("cashflow-month-2")).not.toHaveClass("cashflow-table__row--active");
  });

  it("mouseleave clears the transient hover (no pin)", () => {
    const { container, scrubber } = setup();
    fireEvent.mouseMove(scrubber, { clientX: bandX(2) });
    fireEvent.mouseLeave(scrubber);
    expect(container.querySelector(".cashflow-chart__point")).toBeNull();
    expect(screen.queryByTestId("cashflow-tooltip")).not.toBeInTheDocument();
  });

  it("passive hover over a collapsed group does NOT auto-expand it — tooltip still shows (spec §5)", () => {
    const { scrubber } = setup();
    // Month 20 lives in Year 2 (months 13-24), which starts collapsed.
    fireEvent.mouseMove(scrubber, { clientX: bandX(20) });
    expect(screen.getByTestId("cashflow-group-toggle-year-2")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByTestId("cashflow-month-20")).toHaveAttribute("hidden");
    expect(screen.getByTestId("cashflow-tooltip")).toBeInTheDocument();
  });
});

describe("tap/click-to-pin (review I1, spec §5 touch)", () => {
  function setup() {
    const utils = render(
      <CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />,
    );
    const scrubber = screen.getByTestId("cashflow-scrubber");
    mockScrubberRect(scrubber);
    return { ...utils, scrubber };
  }

  it("click pins the month: highlight + tooltip survive pointer leave; a second click unpins", () => {
    const { container, scrubber } = setup();
    fireEvent.click(scrubber, { clientX: bandX(3) });
    expect(screen.getByTestId("cashflow-month-3")).toHaveClass("cashflow-table__row--active");
    fireEvent.mouseLeave(scrubber);
    // Pinned: the readout persists after the pointer leaves.
    expect(screen.getByTestId("cashflow-month-3")).toHaveClass("cashflow-table__row--active");
    expect(screen.getByTestId("cashflow-tooltip")).toBeInTheDocument();
    // Second tap on the same month unpins and dismisses.
    fireEvent.click(scrubber, { clientX: bandX(3) });
    expect(screen.queryByTestId("cashflow-tooltip")).not.toBeInTheDocument();
    expect(container.querySelector(".cashflow-chart__point")).toBeNull();
  });

  it("tapping another month MOVES the pin", () => {
    const { scrubber } = setup();
    fireEvent.click(scrubber, { clientX: bandX(3) });
    fireEvent.click(scrubber, { clientX: bandX(7) });
    fireEvent.mouseLeave(scrubber);
    expect(screen.getByTestId("cashflow-month-7")).toHaveClass("cashflow-table__row--active");
    expect(screen.getByTestId("cashflow-month-3")).not.toHaveClass("cashflow-table__row--active");
  });

  it("tapping a month in a collapsed group auto-expands it (deliberate navigation, spec §5)", () => {
    const { scrubber } = setup();
    expect(screen.getByTestId("cashflow-month-20")).toHaveAttribute("hidden");
    fireEvent.click(scrubber, { clientX: bandX(20) });
    expect(screen.getByTestId("cashflow-group-toggle-year-2")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("cashflow-month-20")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("cashflow-month-20")).toHaveClass("cashflow-table__row--active");
  });

  it("tapping a table row pins that month (row-side tap parity)", () => {
    render(<CashflowChart monthly={series60()} breakevenMonth={29} milestones={milestones60} />);
    const row = screen.getByTestId("cashflow-month-4");
    fireEvent.click(row);
    fireEvent.mouseLeave(row);
    // Pinned via the row: the highlight persists after the pointer leaves.
    expect(row).toHaveClass("cashflow-table__row--active");
    fireEvent.click(row); // second tap unpins
    expect(row).not.toHaveClass("cashflow-table__row--active");
  });
});

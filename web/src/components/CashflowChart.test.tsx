import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CashflowChart } from "./CashflowChart";
import type { MonthlyPoint, Milestones } from "../api/viewModel";

function pt(month: number, cum: number): MonthlyPoint {
  const sv = (raw: number) => ({ raw, display: `$${raw}` });
  return { month, revenue: sv(0), expenses: sv(0), net: sv(0), cumulativeCash: sv(cum) };
}

const monthly: MonthlyPoint[] = [
  pt(0, -200000),
  pt(1, -150000),
  pt(2, -50000),
  pt(3, 10000),
];

// A months-1..N series (x-axis from month 1) with three distinct milestones.
const monthlyV3: MonthlyPoint[] = [
  pt(1, -50000),
  pt(2, -120000),
  pt(3, -150000),
  pt(4, -90000),
  pt(5, -20000),
  pt(6, 30000),
  pt(7, 90000),
];

const milestones: Milestones = {
  grandOpening: { raw: 3, display: "Month 3" },
  breakEven: { raw: 5, display: "Month 5" },
  payback: { raw: 7, display: "Month 7", duration: "5 months" },
};

describe("CashflowChart", () => {
  it("renders an SVG cash-flow figure", () => {
    render(<CashflowChart monthly={monthly} breakevenMonth={3} />);
    expect(screen.getByTestId("cashflow-chart")).toBeInTheDocument();
  });

  it("marks the break-even month", () => {
    render(<CashflowChart monthly={monthly} breakevenMonth={3} />);
    expect(screen.getByTestId("breakeven-marker")).toBeInTheDocument();
  });

  it("does not pin a fixed pixel height — follows the viewBox aspect so phones don't letterbox [#196]", () => {
    const { container } = render(<CashflowChart monthly={monthly} breakevenMonth={3} />);
    const svg = container.querySelector("svg")!;
    // No fixed `height="240"`: the box follows the viewBox ratio (CSS width:100%/height:auto)
    // so a narrow mobile column gets a proportional height, not a ~55% empty band.
    expect(svg.getAttribute("height")).not.toBe("240");
    expect(svg).toHaveAttribute("width", "100%");
    // The drawing geometry still uses the 660x240 coordinate space.
    expect(svg).toHaveAttribute("viewBox", "0 0 660 240");
  });

  it("omits the marker when break-even never occurs", () => {
    render(<CashflowChart monthly={monthly} breakevenMonth={null} />);
    expect(screen.queryByTestId("breakeven-marker")).not.toBeInTheDocument();
  });

  it("marks Grand Opening, Breakeven and Payback distinctly", () => {
    render(<CashflowChart monthly={monthlyV3} breakevenMonth={5} milestones={milestones} />);
    expect(screen.getByTestId("grandopening-marker")).toBeInTheDocument();
    expect(screen.getByTestId("breakeven-marker")).toBeInTheDocument();
    expect(screen.getByTestId("payback-marker")).toBeInTheDocument();
  });

  it("labels the milestones with the server display strings (no client formatting)", () => {
    render(<CashflowChart monthly={monthlyV3} breakevenMonth={5} milestones={milestones} />);
    const legend = screen.getByTestId("chart-milestones");
    expect(legend).toHaveTextContent("Grand Opening");
    expect(legend).toHaveTextContent("Month 3");
    expect(legend).toHaveTextContent("Break-even");
    expect(legend).toHaveTextContent("Month 5");
    expect(legend).toHaveTextContent("Payback");
    expect(legend).toHaveTextContent("Month 7");
  });

  it("starts the x-axis at month 1", () => {
    const { container } = render(
      <CashflowChart monthly={monthlyV3} breakevenMonth={5} milestones={milestones} />,
    );
    const ticks = Array.from(container.querySelectorAll(".cashflow-chart__tick")).map(
      (t) => t.textContent,
    );
    expect(ticks[0]).toBe("M1");
  });

  it("renders an unreached milestone as N/A with reason, never a 0 marker", () => {
    const naMilestones: Milestones = {
      grandOpening: { raw: 3, display: "Month 3" },
      breakEven: { raw: 5, display: "Month 5" },
      payback: {
        raw: null,
        display: "N/A",
        reason: "N/A — startup costs are not recovered within the projection horizon",
      },
    };
    render(<CashflowChart monthly={monthlyV3} breakevenMonth={5} milestones={naMilestones} />);
    // No phantom marker drawn at month 0 / position 0.
    expect(screen.queryByTestId("payback-marker")).not.toBeInTheDocument();
    const legend = screen.getByTestId("chart-milestones");
    expect(legend).toHaveTextContent("N/A");
    expect(legend).toHaveTextContent("startup costs are not recovered");
  });

  it("colors negative cells in the monthly data table — loss color paired with the server parentheses [#148]", () => {
    const loss: MonthlyPoint = {
      month: 0,
      revenue: { raw: 0, display: "$0" },
      expenses: { raw: -31870, display: "($31,870)" },
      net: { raw: -14793, display: "($14,793)" },
      cumulativeCash: { raw: -199793, display: "($199,793)" },
    };
    const gain: MonthlyPoint = {
      month: 1,
      revenue: { raw: 20000, display: "$20,000" },
      expenses: { raw: -10000, display: "($10,000)" },
      net: { raw: 10000, display: "$10,000" },
      cumulativeCash: { raw: 5000, display: "$5,000" },
    };
    render(<CashflowChart monthly={[loss, gain]} breakevenMonth={1} />);
    const table = screen.getByTestId("cashflow-table");
    // Negative net / cumulative cells carry the negative hook (CSS error color),
    // PAIRED with the server's parentheses — never color alone.
    expect(within(table).getByText("($14,793)")).toHaveAttribute("data-negative", "true");
    expect(within(table).getByText("($199,793)")).toHaveAttribute("data-negative", "true");
    // Positive figures are unflagged.
    expect(within(table).getByText("$20,000")).not.toHaveAttribute("data-negative");
    expect(within(table).getByText("$10,000")).not.toHaveAttribute("data-negative");
  });
});

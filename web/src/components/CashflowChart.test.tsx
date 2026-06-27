import { render, screen } from "@testing-library/react";
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
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CashflowChart } from "./CashflowChart";
import type { MonthlyPoint } from "../api/viewModel";

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
});

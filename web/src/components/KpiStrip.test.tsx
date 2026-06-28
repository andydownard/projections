import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { KpiStrip } from "./KpiStrip";
import type { Kpi } from "../api/viewModel";

// The "2nd tile set" (server kpis[]) extracted for the KPIs tab (Epic G #40/#41).
// Pure presentation: server display strings verbatim; the negative cue is by SIGN.
const kpis: Kpi[] = [
  { label: "Total revenue", value: { raw: 426911, display: "$426,911" }, sub: "Year 1" },
  { label: "Net profit", value: { raw: -44433, display: "($44,433)" }, sub: "Year 1" },
  { label: "Labor ratio", value: { raw: 0.6, display: "60.0%" } },
];

describe("KpiStrip", () => {
  it("renders each server KPI with its display string verbatim", () => {
    render(<KpiStrip kpis={kpis} />);
    const strip = screen.getByTestId("kpi-strip");
    expect(within(strip).getByText("$426,911")).toBeInTheDocument();
    expect(within(strip).getByText("60.0%")).toBeInTheDocument();
  });

  it("maps Total revenue to the kpi-revenue testid and others to kpi-<label>", () => {
    render(<KpiStrip kpis={kpis} />);
    expect(screen.getByTestId("kpi-revenue")).toHaveTextContent("$426,911");
    expect(screen.getByTestId("kpi-Labor ratio")).toHaveTextContent("60.0%");
  });

  it("flags a negative KPI value (data-negative) but not a positive one [#148]", () => {
    render(<KpiStrip kpis={kpis} />);
    const strip = screen.getByTestId("kpi-strip");
    expect(within(strip).getByText("($44,433)")).toHaveAttribute("data-negative", "true");
    expect(within(strip).getByText("$426,911")).not.toHaveAttribute("data-negative");
  });

  it("renders the optional sub-label", () => {
    render(<KpiStrip kpis={kpis} />);
    expect(within(screen.getByTestId("kpi-revenue")).getByText("Year 1")).toBeInTheDocument();
  });
});

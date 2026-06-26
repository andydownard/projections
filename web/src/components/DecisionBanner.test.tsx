import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DecisionBanner } from "./DecisionBanner";
import type { Metrics, Reco } from "../api/viewModel";

const reco: Reco = { tag: "proceed", headline: "Proceed.", sub: "Healthy plan." };
const metrics: Metrics = {
  capital: { raw: 277990, display: "$277,990" },
  cashGap: { raw: -12000, display: "($12,000)" },
  breakeven: { raw: 5, display: "Month 5" },
};

describe("DecisionBanner", () => {
  it("renders the decision banner with the three metrics", () => {
    render(<DecisionBanner reco={reco} metrics={metrics} />);
    expect(screen.getByTestId("decision-banner")).toBeInTheDocument();
    expect(screen.getByTestId("metric-capital")).toHaveTextContent("$277,990");
    expect(screen.getByTestId("metric-breakeven")).toHaveTextContent("Month 5");
    expect(screen.getByTestId("metric-cashgap")).toHaveTextContent("($12,000)");
  });

  it("carries the verdict text, not color alone (a11y)", () => {
    render(<DecisionBanner reco={reco} metrics={metrics} />);
    expect(screen.getByText("Proceed.")).toBeInTheDocument();
    expect(screen.getByTestId("decision-banner")).toHaveAttribute("data-tag", "proceed");
  });

  it("labels the three metrics with the canonical vocabulary (UX fix #10)", () => {
    render(<DecisionBanner reco={reco} metrics={metrics} />);
    expect(screen.getByText("Startup capital required")).toBeInTheDocument();
    expect(screen.getByText("Break-even month")).toBeInTheDocument();
    expect(screen.getByText("First-year cash gap")).toBeInTheDocument();
  });

  it("renders server display strings verbatim (no client math)", () => {
    render(<DecisionBanner reco={reco} metrics={metrics} />);
    // The cash gap is a parenthesized negative from the server — rendered as-is.
    expect(screen.getByTestId("metric-cashgap")).toHaveTextContent("($12,000)");
  });
});

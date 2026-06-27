import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DecisionBanner } from "./DecisionBanner";
import type { Metrics, Milestones, Reco } from "../api/viewModel";

const reco: Reco = { tag: "proceed", headline: "Proceed.", sub: "Healthy plan." };
const metrics: Metrics = {
  capital: { raw: 277990, display: "$277,990" },
  cashGap: { raw: -12000, display: "($12,000)" },
  breakeven: { raw: 5, display: "Month 5" },
};

const milestones: Milestones = {
  grandOpening: { raw: 3, display: "Month 3" },
  breakEven: { raw: 5, display: "Month 5" },
  payback: { raw: 7, display: "Month 7", duration: "5 months" },
};

const BREAKEVEN_DEF =
  "The milestone where your ongoing revenue matches your ongoing expenses. Crossing this line means your day-to-day operations are officially profitable.";
const PAYBACK_DEF =
  "The length of time it takes for those accumulated profits to equal your initial startup costs. Reaching the end of this period means you have officially recovered your investment.";

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

  it("renders server display strings verbatim (no client math)", () => {
    render(<DecisionBanner reco={reco} metrics={metrics} />);
    // The cash gap is a parenthesized negative from the server — rendered as-is.
    expect(screen.getByTestId("metric-cashgap")).toHaveTextContent("($12,000)");
  });

  it("surfaces Breakeven and Payback with their plain-language definitions", () => {
    render(<DecisionBanner reco={reco} metrics={metrics} milestones={milestones} />);
    expect(screen.getByTestId("metric-breakeven")).toHaveTextContent("Month 5");
    expect(screen.getByTestId("metric-payback")).toHaveTextContent("Month 7");
    expect(screen.getByText(BREAKEVEN_DEF)).toBeInTheDocument();
    expect(screen.getByText(PAYBACK_DEF)).toBeInTheDocument();
  });

  it("exposes each definition through a keyboard-focusable help button (a11y)", () => {
    render(<DecisionBanner reco={reco} metrics={metrics} milestones={milestones} />);
    const beHelp = screen.getByRole("button", { name: /what is the break-even point/i });
    const pbHelp = screen.getByRole("button", { name: /what is the payback period/i });
    // Definition is associated for screen readers, not color-only.
    expect(beHelp).toHaveAttribute("aria-describedby");
    expect(pbHelp).toHaveAttribute("aria-describedby");
    const beTip = document.getElementById(beHelp.getAttribute("aria-describedby")!);
    expect(beTip).toHaveTextContent(BREAKEVEN_DEF);
    expect(beTip).toHaveAttribute("role", "tooltip");
  });

  it("labels a negative trough 'First-year cash gap' (a real shortfall) [#194]", () => {
    render(<DecisionBanner reco={reco} metrics={metrics} />);
    const gap = screen.getByTestId("metric-cashgap");
    expect(gap).toHaveTextContent(/First-year cash gap/i);
    expect(gap).toHaveTextContent("($12,000)");
  });

  it("labels a positive trough 'Lowest first-year cash balance' — a cushion, not a gap [#194]", () => {
    const cushion: Metrics = {
      ...metrics,
      cashGap: { raw: 40000, display: "$40,000" },
    };
    render(<DecisionBanner reco={reco} metrics={cushion} />);
    const gap = screen.getByTestId("metric-cashgap");
    expect(gap).toHaveTextContent(/Lowest first-year cash balance/i);
    expect(gap).not.toHaveTextContent(/cash gap/i);
    // Server display rendered verbatim — no client math.
    expect(gap).toHaveTextContent("$40,000");
  });

  it("renders an unreached payback as N/A with reason, never a misleading 0", () => {
    const naMilestones: Milestones = {
      grandOpening: { raw: 3, display: "Month 3" },
      breakEven: { raw: null, display: "N/A", reason: "N/A — no Year 1 profit" },
      payback: { raw: null, display: "N/A", reason: "N/A — no Year 1 profit" },
    };
    render(<DecisionBanner reco={reco} metrics={metrics} milestones={naMilestones} />);
    const payback = screen.getByTestId("metric-payback");
    expect(payback).toHaveTextContent("N/A");
    expect(payback).not.toHaveTextContent("$0");
    expect(payback).toHaveTextContent("no Year 1 profit");
  });
});

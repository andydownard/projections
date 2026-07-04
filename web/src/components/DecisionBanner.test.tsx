import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DecisionBanner } from "./DecisionBanner";
import type { Confidence, Metrics, Milestones, Reco, Sensitivity } from "../api/viewModel";

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

  // task 3.3 (audit P0): the §12.2 sensitivity block was computed by decision.py
  // but dropped before it ever reached the view-model. It must now surface on
  // the banner — the delta framing sourced from the server field, never hard-coded.
  const sensitivity: Sensitivity = {
    base: {
      net: { raw: 46900, display: "$46,900" },
      breakeven: 5,
      capital: { raw: 277990, display: "$277,990" },
    },
    downside: {
      net: { raw: -12000, display: "($12,000)" },
      breakeven: null,
      capital: { raw: 312000, display: "$312,000" },
    },
    upside: {
      net: { raw: 98000, display: "$98,000" },
      breakeven: 4,
      capital: { raw: 250000, display: "$250,000" },
    },
    delta: 0.25,
  };

  describe("sensitivity + confidence [task 3.3]", () => {
    it("surfaces the downside line when the server sensitivity block is present", () => {
      render(<DecisionBanner reco={reco} metrics={metrics} sensitivity={sensitivity} />);
      const line = screen.getByTestId("sensitivity-downside");
      expect(line).toHaveTextContent("Downside");
      expect(line).toHaveTextContent("rent +25% / donations −25%");
      expect(line).toHaveTextContent("($12,000)");
      expect(line).toHaveTextContent("$312,000");
    });

    it("renders the delta framing FROM sensitivity.delta, never a hard-coded 25", () => {
      const tighter: Sensitivity = { ...sensitivity, delta: 0.1 };
      render(<DecisionBanner reco={reco} metrics={metrics} sensitivity={tighter} />);
      const line = screen.getByTestId("sensitivity-downside");
      expect(line).toHaveTextContent("rent +10% / donations −10%");
      expect(line).not.toHaveTextContent("25%");
    });

    it("renders 'not reached' when the downside break-even is null (never a misleading 0)", () => {
      render(<DecisionBanner reco={reco} metrics={metrics} sensitivity={sensitivity} />);
      const line = screen.getByTestId("sensitivity-downside");
      expect(line).toHaveTextContent("not reached");
      expect(line).not.toHaveTextContent("Month 0");
    });

    it("hides cleanly for a legacy snapshot with no sensitivity block", () => {
      render(<DecisionBanner reco={reco} metrics={metrics} />);
      expect(screen.queryByTestId("sensitivity-downside")).not.toBeInTheDocument();
      expect(screen.queryByTestId("confidence-chip")).not.toBeInTheDocument();
    });

    it("shows the low-ramp confidence chip when confidence.ramp is 'low'", () => {
      const confidence: Confidence = { ramp: "low" };
      render(
        <DecisionBanner reco={reco} metrics={metrics} confidence={confidence} />,
      );
      const chip = screen.getByTestId("confidence-chip");
      expect(chip).toHaveTextContent(/Confidence: ramp estimate — low/i);
    });

    it("hides the confidence chip when ramp is 'high'", () => {
      const confidence: Confidence = { ramp: "high" };
      render(
        <DecisionBanner reco={reco} metrics={metrics} confidence={confidence} />,
      );
      expect(screen.queryByTestId("confidence-chip")).not.toBeInTheDocument();
    });
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

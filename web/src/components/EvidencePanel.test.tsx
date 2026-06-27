import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EvidencePanel } from "./EvidencePanel";
import type { EvidenceItem } from "../api/viewModel";

const HOUSEHOLDS: EvidenceItem = {
  field: "households",
  label: "Trade-area households",
  value: 31798,
  // The server is the sole formatting authority (PRD §13): the panel renders
  // these strings verbatim and does no client-side number formatting.
  value_display: "~31,798 households",
  method: "census_acs",
  source: "U.S. Census Bureau, ACS 5-year (2022), table B11001",
  source_date: "2022",
  confidence: "estimated",
  geography: "Longview city",
  moe: 412,
  moe_display: "±412 households (MOE)",
};

describe("EvidencePanel", () => {
  it("renders nothing when there is no evidence", () => {
    const { container } = render(<EvidencePanel evidence={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows households evidence with an estimated badge (icon+text) and source", () => {
    render(<EvidencePanel evidence={[HOUSEHOLDS]} />);
    expect(screen.getByTestId("evidence-panel")).toBeInTheDocument();
    expect(screen.getByText("Trade-area households")).toBeInTheDocument();
    // Meaning carried in text, not color alone.
    expect(screen.getByText(/Estimated/)).toBeInTheDocument();
    // Server display strings render VERBATIM (no client formatting).
    expect(screen.getByText(/~31,798 households/)).toBeInTheDocument();
    expect(screen.getByText(/ACS 5-year \(2022\)/)).toBeInTheDocument();
    expect(screen.getByText(/±412 households \(MOE\)/)).toBeInTheDocument();
  });

  it("renders the server display string verbatim and ignores the raw value", () => {
    render(
      <EvidencePanel
        evidence={[{ ...HOUSEHOLDS, value: 999, value_display: "~31,798 households" }]}
      />,
    );
    // Renders value_display, NOT a client-formatted version of the raw value.
    expect(screen.getByText(/~31,798 households/)).toBeInTheDocument();
    expect(screen.queryByText(/999/)).not.toBeInTheDocument();
  });

  it("falls back to the raw value when no server display string is present", () => {
    const { value_display, moe_display, ...noDisplay } = HOUSEHOLDS;
    void value_display;
    void moe_display;
    render(<EvidencePanel evidence={[noDisplay]} />);
    expect(screen.getByText("31798")).toBeInTheDocument();
  });
});

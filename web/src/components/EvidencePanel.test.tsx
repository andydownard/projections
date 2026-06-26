import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EvidencePanel } from "./EvidencePanel";
import type { EvidenceItem } from "../api/viewModel";

const HOUSEHOLDS: EvidenceItem = {
  field: "households",
  label: "Trade-area households",
  value: 31798,
  method: "census_acs",
  source: "U.S. Census Bureau, ACS 5-year (2022), table B11001",
  source_date: "2022",
  confidence: "estimated",
  geography: "Longview city",
  moe: 412,
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
    expect(screen.getByText(/~31,798 households/)).toBeInTheDocument();
    expect(screen.getByText(/ACS 5-year \(2022\)/)).toBeInTheDocument();
    expect(screen.getByText(/±412 households/)).toBeInTheDocument();
  });
});

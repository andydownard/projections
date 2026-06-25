import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectionsList } from "./ProjectionsList";
import type { ProjectionListItem } from "../api/projections";

// SLICE 2 — owner-scoped list page (PRD §19.1). Rows show name, location + basis,
// updated, Year-1 revenue, net profit, capital required, and a recommendation
// chip. Money is rendered VERBATIM from the server { display } (no client math).
// Empty state is utilitarian: heading + Create + "start from example".

const item: ProjectionListItem = {
  view_slug: "p_8x",
  name: "House of Hope — Longview, TX",
  location: "Longview, TX",
  basis: "city",
  y1_revenue: { raw: 426911, display: "$426,911" },
  y1_net: { raw: 47100, display: "$47,100" },
  capital_required: { raw: 277990, display: "$277,990" },
  reco_tag: "proceed",
  status: "active",
  version: 7,
  updated_at: "2026-06-24T17:03:21Z",
};

describe("ProjectionsList — empty state", () => {
  it("renders a utilitarian empty state with Create and start-from-example", () => {
    render(<ProjectionsList projections={[]} onCreate={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole("heading", { name: /no projections yet/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start from example/i })).toBeInTheDocument();
  });

  it("fires onCreate when Create is clicked in the empty state", () => {
    let created = false;
    render(
      <ProjectionsList projections={[]} onCreate={() => (created = true)} onOpen={() => {}} />,
    );
    screen.getByRole("button", { name: /^create/i }).click();
    expect(created).toBe(true);
  });
});

describe("ProjectionsList — populated", () => {
  it("renders one row per projection with server display strings (no client math)", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onOpen={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(within(row).getByText("House of Hope — Longview, TX")).toBeInTheDocument();
    // location + basis sub-line (a single node combining both)
    expect(within(row).getByText(/Longview, TX · city/)).toBeInTheDocument();
    expect(within(row).getByText("$426,911")).toBeInTheDocument();
    expect(within(row).getByText("$47,100")).toBeInTheDocument();
    expect(within(row).getByText("$277,990")).toBeInTheDocument();
  });

  it("shows the recommendation chip per row", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onOpen={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(within(row).getByText(/proceed/i)).toBeInTheDocument();
  });

  it("opens a projection by view_slug when its row is activated", () => {
    let opened = "";
    render(
      <ProjectionsList projections={[item]} onCreate={() => {}} onOpen={(s) => (opened = s)} />,
    );
    screen.getByRole("button", { name: /open house of hope/i }).click();
    expect(opened).toBe("p_8x");
  });

  it("offers a Create action in the header when projections exist", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: /new projection/i })).toBeInTheDocument();
  });
});

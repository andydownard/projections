import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectionsList } from "./ProjectionsList";
import type { ProjectionListItem } from "../api/projections";

// SLICE 2 — owner-scoped list page (PRD §19.1). Rows show name, location + basis,
// updated, Year-1 revenue, net profit, capital required, and a recommendation
// chip. Money is rendered VERBATIM from the server { display } (no client math).
// Empty state is utilitarian: heading + a single Create action.

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
  coords: { lat: 32.5, lng: -94.7 },
};

describe("ProjectionsList — empty state", () => {
  it("renders a utilitarian empty state with a single create action", () => {
    render(<ProjectionsList projections={[]} onCreate={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole("heading", { name: /no projections yet/i })).toBeInTheDocument();
    // QA P1 (decision #4) — the create button is CONSISTENT with the populated
    // state: same label "New projection" (no "Create projection" divergence).
    expect(screen.getByRole("button", { name: /new projection/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create projection/i })).toBeNull();
    // Still exactly one action — no mislabeled "Start from example" duplicate.
    expect(screen.queryByRole("button", { name: /start from example/i })).toBeNull();
  });

  // QA P1 (decision #4) — the button sits UPPER-RIGHT next to the heading, in the
  // SAME `.list__header` (justify-content: space-between) the populated state uses,
  // not on the LEFT below the copy. Asserting the shared container == same placement.
  it("places the create button upper-right in the shared list header (same as populated)", () => {
    const { container } = render(
      <ProjectionsList projections={[]} onCreate={() => {}} onOpen={() => {}} />,
    );
    const header = container.querySelector(".list__header");
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByRole("heading", { name: /no projections yet/i }))
      .toBeInTheDocument();
    expect(within(header as HTMLElement).getByRole("button", { name: /new projection/i }))
      .toBeInTheDocument();
  });

  it("fires onCreate when the create button is clicked in the empty state", () => {
    let created = false;
    render(
      <ProjectionsList projections={[]} onCreate={() => (created = true)} onOpen={() => {}} />,
    );
    screen.getByRole("button", { name: /new projection/i }).click();
    expect(created).toBe(true);
  });
});

describe("ProjectionsList — populated", () => {
  it("renders one row per projection with server display strings (no client math)", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onOpen={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(within(row).getByText("House of Hope — Longview, TX")).toBeInTheDocument();
    // location + basis sub-line (a single node combining both); basis is a
    // humanized label, never the raw enum code (#151).
    expect(within(row).getByText(/Longview, TX · City/)).toBeInTheDocument();
    expect(within(row).getByText("$426,911")).toBeInTheDocument();
    expect(within(row).getByText("$47,100")).toBeInTheDocument();
    expect(within(row).getByText("$277,990")).toBeInTheDocument();
  });

  it("colors a negative Y1 net as a loss — error color paired with the server parentheses [#148]", () => {
    const loss: ProjectionListItem = {
      ...item,
      view_slug: "p_loss",
      y1_net: { raw: -44433, display: "($44,433)" },
    };
    render(<ProjectionsList projections={[loss]} onCreate={() => {}} onOpen={() => {}} />);
    const row = screen.getByTestId("projection-row-p_loss");
    const net = within(row).getByText("($44,433)");
    expect(net).toHaveAttribute("data-negative", "true");
    expect(net).toHaveTextContent("($44,433)"); // parentheses (non-color cue) kept
    // Positive figures are never flagged negative.
    expect(within(row).getByText("$426,911")).not.toHaveAttribute("data-negative");
  });

  it("renders a friendly, locale-stable updated date — not a raw ISO slice [#151]", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onOpen={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(within(row).getByText("Jun 24, 2026")).toBeInTheDocument();
    expect(within(row).queryByText("2026-06-24")).toBeNull();
  });

  it("renders a human trade-area basis label, never the raw enum code [#151]", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onOpen={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(within(row).getByText(/· City$/)).toBeInTheDocument();
    expect(within(row).queryByText(/· city$/)).toBeNull();
  });

  it("renders a per-row trade-area mini-map when coordinates are present", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onOpen={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(within(row).getByRole("img", { name: /Map of Longview, TX/i })).toBeInTheDocument();
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

  // #143 — an explicit Edit affordance routes an owned projection to the EDITABLE
  // detail (Settings/sliders/overrides/autosave). The list is owner-scoped, so
  // every listed row is owner-editable.
  it("offers an Edit action per row that routes to the editable detail by view_slug", () => {
    let edited = "";
    render(
      <ProjectionsList
        projections={[item]}
        onCreate={() => {}}
        onOpen={() => {}}
        onEdit={(s) => (edited = s)}
      />,
    );
    const row = screen.getByTestId("projection-row-p_8x");
    within(row).getByRole("button", { name: /edit house of hope/i }).click();
    expect(edited).toBe("p_8x");
  });

  it("omits the Edit action when no onEdit handler is provided", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onOpen={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(within(row).queryByRole("button", { name: /edit house of hope/i })).toBeNull();
  });
});

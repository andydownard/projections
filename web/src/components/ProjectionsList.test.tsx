import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectionsList } from "./ProjectionsList";
import type { ProjectionListItem } from "../api/projections";

// EPIC L v2 redesign — owner-scoped list page (PRD §19.1).
// Columns: Location (name + updated date), Income sparkline (Y1..Y5 net income),
// Capital required (red), Payback, Breakeven, Caret.
// The entire row is the click target → /p/<slug>/edit; no separate Edit button.
// Money is rendered VERBATIM from the server {display} (no client math, PRD §13).

const item: ProjectionListItem = {
  view_slug: "p_8x",
  name: "House of Hope — Longview, TX",
  location: "Longview city",
  income_series: [
    { raw: -20000, display: "($20,000)" },
    { raw: 10000, display: "$10,000" },
    { raw: 30000, display: "$30,000" },
    { raw: 45000, display: "$45,000" },
    { raw: 60000, display: "$60,000" },
  ],
  y5_income: { raw: 60000, display: "$60,000" },
  capital_required: { raw: 277990, display: "$277,990" },
  payback: { raw: 25, display: "Month 25" },
  breakeven: { raw: 5, display: "Month 5" },
  reco_tag: "proceed",
  status: "active",
  version: 7,
  updated_at: "2026-06-24T17:03:21Z",
};

describe("ProjectionsList — L1: h1 'Projections'", () => {
  it("renders h1 'Projections' in the empty state", () => {
    render(<ProjectionsList projections={[]} onCreate={() => {}} onRowClick={() => {}} />);
    expect(screen.getByRole("heading", { level: 1, name: /^Projections$/i })).toBeInTheDocument();
  });

  it("renders h1 'Projections' in the populated state", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    expect(screen.getByRole("heading", { level: 1, name: /^Projections$/i })).toBeInTheDocument();
  });

  it("never says 'Your projections' as the h1 (drop 'Your')", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    expect(screen.queryByRole("heading", { name: /your projections/i })).toBeNull();
  });
});

describe("ProjectionsList — empty state", () => {
  it("renders the h1 and a single create action in the empty state", () => {
    render(<ProjectionsList projections={[]} onCreate={() => {}} onRowClick={() => {}} />);
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new projection/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create projection/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /start from example/i })).toBeNull();
  });

  it("places the create button upper-right in the shared list header (same as populated)", () => {
    const { container } = render(
      <ProjectionsList projections={[]} onCreate={() => {}} onRowClick={() => {}} />,
    );
    const header = container.querySelector(".list__header");
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(within(header as HTMLElement).getByRole("button", { name: /new projection/i }))
      .toBeInTheDocument();
  });

  it("fires onCreate when the create button is clicked in the empty state", () => {
    let created = false;
    render(
      <ProjectionsList projections={[]} onCreate={() => (created = true)} onRowClick={() => {}} />,
    );
    screen.getByRole("button", { name: /new projection/i }).click();
    expect(created).toBe(true);
  });
});

describe("ProjectionsList — L2: whole-row click target", () => {
  it("entire row fires onRowClick with the view_slug on click → navigates to /p/<slug>/edit", () => {
    let clicked = "";
    render(
      <ProjectionsList
        projections={[item]}
        onCreate={() => {}}
        onRowClick={(s) => (clicked = s)}
      />,
    );
    const row = screen.getByTestId("projection-row-p_8x");
    row.click();
    expect(clicked).toBe("p_8x");
  });

  it("row has role='button' for keyboard accessibility", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(row).toHaveAttribute("role", "button");
  });

  it("row has tabIndex=0 so it is keyboard-reachable", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(row).toHaveAttribute("tabindex", "0");
  });

  it("Enter key fires onRowClick (keyboard activation)", () => {
    let clicked = "";
    render(
      <ProjectionsList
        projections={[item]}
        onCreate={() => {}}
        onRowClick={(s) => (clicked = s)}
      />,
    );
    const row = screen.getByTestId("projection-row-p_8x");
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(clicked).toBe("p_8x");
  });

  it("Space key fires onRowClick (keyboard activation)", () => {
    let clicked = "";
    render(
      <ProjectionsList
        projections={[item]}
        onCreate={() => {}}
        onRowClick={(s) => (clicked = s)}
      />,
    );
    const row = screen.getByTestId("projection-row-p_8x");
    row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(clicked).toBe("p_8x");
  });

  it("has no separate Edit button (removed in v2)", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(within(row).queryByRole("button", { name: /edit house of hope/i })).toBeNull();
  });

  it("has no separate Open button (removed in v2)", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(within(row).queryByRole("button", { name: /open house of hope/i })).toBeNull();
  });
});

describe("ProjectionsList — L3: new column structure", () => {
  it("renders the projection name in the location column", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(within(row).getByText("House of Hope — Longview, TX")).toBeInTheDocument();
  });

  it("renders the updated date in the location cell (2-line cell)", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    // formatListDate("2026-06-24T17:03:21Z") → "Jun 24, 2026"
    expect(within(row).getByText("Jun 24, 2026")).toBeInTheDocument();
  });

  it("renders an income sparkline with role=img per row", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    const sparkline = within(row).getByRole("img");
    expect(sparkline).toBeInTheDocument();
    expect(sparkline.getAttribute("aria-label")).toMatch(/annual net income/i);
  });

  it("sparkline receives the 5 income_series raw points from the server", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    // The sparkline renders a polyline with 5 points
    const polyline = within(row).getByRole("img").querySelector("polyline");
    expect(polyline).not.toBeNull();
    // Points attribute has 5 pairs
    const ptsCount = (polyline!.getAttribute("points") ?? "").trim().split(/\s+/).length;
    expect(ptsCount).toBe(5);
  });

  it("sparkline aria-label names the Y5 income display value", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    const label = within(row).getByRole("img").getAttribute("aria-label") ?? "";
    expect(label).toContain("$60,000");
  });

  it("renders the capital required display string verbatim", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(within(row).getByText("$277,990")).toBeInTheDocument();
  });

  it("renders the payback display string verbatim", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(within(row).getByText("Month 25")).toBeInTheDocument();
  });

  it("renders the breakeven display string verbatim", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(within(row).getByText("Month 5")).toBeInTheDocument();
  });

  it("renders N/A payback when unreached", () => {
    const naItem: ProjectionListItem = {
      ...item,
      view_slug: "p_na",
      payback: { raw: null, display: "N/A" },
    };
    render(<ProjectionsList projections={[naItem]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_na");
    expect(within(row).getByText("N/A")).toBeInTheDocument();
  });

  // Audit P2 restore: the server never stopped emitting `reco_tag` on every list
  // row, but the v2 redesign silently dropped the RecoChip from the UI — a real
  // regression for a "decision-and-funding tool, not a calculator" (CLAUDE.md).
  // This inverts the prior "does not render a RecoChip (removed in v2)" test.
  it("renders a RecoChip naming the server's recommendation for the row", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    const chip = within(row).getByTestId("reco-chip");
    expect(chip).toHaveAttribute("data-tag", "proceed");
    expect(within(row).getByText(/^proceed$/i)).toBeInTheDocument();
  });

  it("renders a different RecoChip tag per row from the server's reco_tag", () => {
    const doNotProceed: ProjectionListItem = {
      ...item,
      view_slug: "p_dnp",
      reco_tag: "do_not_proceed",
    };
    render(
      <ProjectionsList projections={[doNotProceed]} onCreate={() => {}} onRowClick={() => {}} />,
    );
    const row = screen.getByTestId("projection-row-p_dnp");
    expect(within(row).getByTestId("reco-chip")).toHaveAttribute(
      "data-tag",
      "do_not_proceed",
    );
  });

  it("right-aligns Payback and Breakeven with the shared .num tabular-nums class", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    const paybackCell = within(row).getByText("Month 25").closest("td");
    const breakevenCell = within(row).getByText("Month 5").closest("td");
    expect(paybackCell).toHaveClass("num");
    expect(breakevenCell).toHaveClass("num");
  });

  it("does not render a mini-map (removed in v2)", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    // TradeAreaMap renders an img with alt "Map of ..."
    expect(within(row).queryByRole("img", { name: /map of/i })).toBeNull();
  });
});

describe("ProjectionsList — populated: general", () => {
  it("offers a Create action in the header when projections exist", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    expect(screen.getByRole("button", { name: /new projection/i })).toBeInTheDocument();
  });

  it("renders one row per projection", () => {
    const second: ProjectionListItem = {
      ...item,
      view_slug: "p_2",
      name: "Grace Mission",
    };
    render(
      <ProjectionsList
        projections={[item, second]}
        onCreate={() => {}}
        onRowClick={() => {}}
      />,
    );
    expect(screen.getByTestId("projection-row-p_8x")).toBeInTheDocument();
    expect(screen.getByTestId("projection-row-p_2")).toBeInTheDocument();
  });

  it("renders a friendly, locale-stable updated date — not a raw ISO slice", () => {
    render(<ProjectionsList projections={[item]} onCreate={() => {}} onRowClick={() => {}} />);
    const row = screen.getByTestId("projection-row-p_8x");
    expect(within(row).getByText("Jun 24, 2026")).toBeInTheDocument();
    expect(within(row).queryByText("2026-06-24")).toBeNull();
  });

  it("renders empty income_series without throwing", () => {
    const noSeries: ProjectionListItem = {
      ...item,
      view_slug: "p_empty_series",
      income_series: [],
    };
    expect(() =>
      render(
        <ProjectionsList projections={[noSeries]} onCreate={() => {}} onRowClick={() => {}} />,
      ),
    ).not.toThrow();
  });
});

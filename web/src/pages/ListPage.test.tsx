import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ListPage } from "./ListPage";
import type { ProjectionListResponse } from "../api/projections";

// This project has no authentication (owner decision, 2026-09-13): the list page
// always fetches the global list — every projection in the database, unfiltered.
// v2 (EPIC L): the list page renders the redesigned ProjectionsList with the new
// column contract (income_series, y5_income, payback, breakeven).

const populated: ProjectionListResponse = {
  projections: [
    {
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
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ListPage", () => {
  it("fetches and renders the global list with no credential of any kind", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(populated), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ListPage />);
    expect(
      await screen.findByText("House of Hope — Longview, TX"),
    ).toBeInTheDocument();
    expect(screen.getByText("$277,990")).toBeInTheDocument();
    expect(screen.getByText("Month 25")).toBeInTheDocument();
    expect(screen.getByText("Month 5")).toBeInTheDocument();

    // No Authorization header of any kind — this project has no authentication.
    const init = fetchSpy.mock.calls[0][1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  it("renders the empty state when the list has no rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ projections: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ListPage />);
    expect(
      await screen.findByRole("heading", { level: 1, name: /^Projections$/i }),
    ).toBeInTheDocument();
  });
});

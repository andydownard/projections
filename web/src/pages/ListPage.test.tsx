import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ListPage } from "./ListPage";
import type { ProjectionListResponse } from "../api/projections";

// SLICE 2 — owner-scoped list page wiring (PRD §19.1 / §20). The page fetches the
// owner-scoped list (no global index) and renders ProjectionsList. Without an
// owner token there is nothing to list, so it shows the utilitarian empty state.
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
  it("renders the empty state with no owner token (no global index)", async () => {
    // No fetch should be made without a token; listProjections short-circuits.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<ListPage />);
    // v2 (L1): h1 is "Projections" on both states.
    expect(
      await screen.findByRole("heading", { level: 1, name: /^Projections$/i }),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders owner-scoped rows from the server (verbatim display strings)", async () => {
    localStorage.setItem("projections.owner_token", "owner-abc");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(populated), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ListPage />);
    expect(
      await screen.findByText("House of Hope — Longview, TX"),
    ).toBeInTheDocument();
    // v2: capital required is still shown; payback and breakeven now appear.
    expect(screen.getByText("$277,990")).toBeInTheDocument();
    expect(screen.getByText("Month 25")).toBeInTheDocument();
    expect(screen.getByText("Month 5")).toBeInTheDocument();
  });

  it("sends the owner bearer token (owner-scoped, never global)", async () => {
    localStorage.setItem("projections.owner_token", "owner-abc");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(populated), { status: 200 }),
    );
    render(<ListPage />);
    await screen.findByText("House of Hope — Longview, TX");
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer owner-abc");
  });

  it("renders a 'Shared with me' section for shared rows with no owner-only affordances (#323)", async () => {
    localStorage.setItem("projections.owner_token", "owner-abc");
    const sharedRow = {
      ...populated.projections[0],
      view_slug: "p_shared",
      name: "Partner Co — Dallas, TX",
      owner: false,
      shared: true,
      editable: true,
    };
    const ownerRow = { ...populated.projections[0], owner: true, shared: false };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ projections: [ownerRow, sharedRow] }), { status: 200 }),
    );
    render(<ListPage />);

    // The shared row appears under its own "Shared with me" heading.
    expect(
      await screen.findByRole("heading", { name: /shared with me/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Partner Co — Dallas, TX")).toBeInTheDocument();
    // Owner-only affordances render ONLY on the owner section: exactly one header
    // "Trash" link (the owner list), none on the shared section.
    expect(screen.getAllByTestId("open-trash")).toHaveLength(1);
  });

  it("omits the 'Shared with me' section when there are no shared rows", async () => {
    localStorage.setItem("projections.owner_token", "owner-abc");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(populated), { status: 200 }),
    );
    render(<ListPage />);
    await screen.findByText("House of Hope — Longview, TX");
    expect(screen.queryByRole("heading", { name: /shared with me/i })).toBeNull();
  });
});

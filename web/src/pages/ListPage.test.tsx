import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ListPage } from "./ListPage";
import type { ProjectionListResponse } from "../api/projections";

// SLICE 2 — owner-scoped list page wiring (PRD §19.1 / §20). The page fetches the
// owner-scoped list (no global index) and renders ProjectionsList. Without an
// owner token there is nothing to list, so it shows the utilitarian empty state.

const populated: ProjectionListResponse = {
  projections: [
    {
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
    expect(
      await screen.findByRole("heading", { name: /no projections yet/i }),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("navigates to /p/example when 'Start from example' is clicked (UX fix #5)", async () => {
    vi.spyOn(globalThis, "fetch");
    const pushSpy = vi.spyOn(window.history, "pushState");
    render(<ListPage />);
    (await screen.findByRole("button", { name: /start from example/i })).click();
    expect(pushSpy).toHaveBeenCalledWith(null, "", "/p/example");
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
    expect(screen.getByText("$426,911")).toBeInTheDocument();
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
});

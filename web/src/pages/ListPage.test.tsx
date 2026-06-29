import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("trashes a row (confirm → POST /trash with If-Match) and removes it from the list", async () => {
    localStorage.setItem("projections.owner_token", "owner-abc");
    const trashCalls: Array<[string, RequestInit | undefined]> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      const u = String(url);
      if (u.includes("/trash")) {
        trashCalls.push([u, init]);
        return Promise.resolve(
          new Response(JSON.stringify({ version: 8, status: "trashed" }), {
            status: 200,
            headers: { ETag: "8" },
          }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(populated), { status: 200 }));
    });

    render(<ListPage />);
    await screen.findByText("House of Hope — Longview, TX");

    // Open the row's "⋯" menu and choose Move to Trash.
    await userEvent.click(screen.getByTestId("row-actions-trigger"));
    await userEvent.click(screen.getByTestId("row-action-trash"));
    // The confirm dialog names the projection; accept it.
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("confirm-accept"));

    // The row drops out of the list.
    await waitFor(() =>
      expect(screen.queryByText("House of Hope — Longview, TX")).toBeNull(),
    );
    // The POST went to /trash with the row's current version as If-Match.
    expect(trashCalls).toHaveLength(1);
    const [u, init] = trashCalls[0];
    expect(u).toContain("/api/projections/p_8x/trash");
    expect((init?.headers as Record<string, string>)["If-Match"]).toBe("7");
    // The secret never appears in the URL.
    expect(u).not.toContain("owner-abc");
  });

  it("keeps the row when the trash 409s (stale version)", async () => {
    localStorage.setItem("projections.owner_token", "owner-abc");
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (String(url).includes("/trash")) {
        return Promise.resolve(
          new Response(JSON.stringify({ detail: { error: "version_conflict", current_version: 9 } }), {
            status: 409,
          }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(populated), { status: 200 }));
    });

    render(<ListPage />);
    await screen.findByText("House of Hope — Longview, TX");
    await userEvent.click(screen.getByTestId("row-actions-trigger"));
    await userEvent.click(screen.getByTestId("row-action-trash"));
    await userEvent.click(screen.getByTestId("confirm-accept"));

    // The conflict means nothing changed — the row stays and the dialog closes.
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText("House of Hope — Longview, TX")).toBeInTheDocument();
  });

  it("cancelling the confirm keeps the row in the list and makes no request", async () => {
    localStorage.setItem("projections.owner_token", "owner-abc");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(populated), { status: 200 }),
    );
    render(<ListPage />);
    await screen.findByText("House of Hope — Longview, TX");

    await userEvent.click(screen.getByTestId("row-actions-trigger"));
    await userEvent.click(screen.getByTestId("row-action-trash"));
    await userEvent.click(screen.getByTestId("confirm-cancel"));

    expect(screen.getByText("House of Hope — Longview, TX")).toBeInTheDocument();
    // Only the initial list GET — no trash POST.
    expect(fetchSpy.mock.calls.every(([u]) => !String(u).includes("/trash"))).toBe(true);
  });
});

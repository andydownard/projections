import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TrashPage } from "./TrashPage";
import type { ProjectionListResponse } from "../api/projections";

// The owner Trash view (API_SPEC §4.8): lists soft-deleted projections (owner-scoped)
// with Restore and a STRONG type-to-confirm permanent delete (DESTRUCTIVE).

const trashed: ProjectionListResponse = {
  projections: [
    {
      view_slug: "p_trash",
      name: "Grace Mission",
      location: "Tyler city",
      income_series: [],
      y5_income: { raw: 0, display: "$0" },
      capital_required: { raw: 90000, display: "$90,000" },
      payback: { raw: null, display: "N/A" },
      breakeven: { raw: null, display: "N/A" },
      status: "trashed",
      version: 4,
      updated_at: "2026-06-24T17:03:21Z",
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) =>
    Promise.resolve(handler(String(url), init as RequestInit | undefined)),
  );
}

describe("TrashPage", () => {
  it("shows the empty state when there is no owner token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<TrashPage />);
    expect(await screen.findByTestId("trash-empty")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lists this owner's trashed projections (GET ?trashed=true)", async () => {
    localStorage.setItem("projections.owner_token", "owner-abc");
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return new Response(JSON.stringify(trashed), { status: 200 });
    });
    render(<TrashPage />);
    expect(await screen.findByText("Grace Mission")).toBeInTheDocument();
    expect(calls[0]).toContain("/api/projections?trashed=true");
  });

  it("restores a row (POST /restore with If-Match) and removes it", async () => {
    localStorage.setItem("projections.owner_token", "owner-abc");
    const restoreCalls: Array<[string, RequestInit | undefined]> = [];
    mockFetch((url, init) => {
      if (url.includes("/restore")) {
        restoreCalls.push([url, init]);
        return new Response(JSON.stringify({ version: 5, status: "active" }), {
          status: 200,
          headers: { ETag: "5" },
        });
      }
      return new Response(JSON.stringify(trashed), { status: 200 });
    });

    render(<TrashPage />);
    await screen.findByText("Grace Mission");
    await userEvent.click(screen.getByTestId("restore-p_trash"));

    await waitFor(() => expect(screen.queryByText("Grace Mission")).toBeNull());
    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0][0]).toContain("/api/projections/p_trash/restore");
    expect((restoreCalls[0][1]?.headers as Record<string, string>)["If-Match"]).toBe("4");
  });

  it("requires type-to-confirm before permanently deleting (DESTRUCTIVE)", async () => {
    localStorage.setItem("projections.owner_token", "owner-abc");
    const deleteCalls: Array<[string, RequestInit | undefined]> = [];
    mockFetch((url, init) => {
      if (init?.method === "DELETE") {
        deleteCalls.push([url, init]);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(trashed), { status: 200 });
    });

    render(<TrashPage />);
    await screen.findByText("Grace Mission");
    await userEvent.click(screen.getByTestId("purge-p_trash"));

    // The strong confirm appears; its delete button is disabled until the name matches.
    expect(screen.getByTestId("confirm-purge-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-purge-accept")).toBeDisabled();
    expect(deleteCalls).toHaveLength(0);

    await userEvent.type(screen.getByTestId("confirm-purge-input"), "Grace Mission");
    await userEvent.click(screen.getByTestId("confirm-purge-accept"));

    await waitFor(() => expect(screen.queryByText("Grace Mission")).toBeNull());
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toContain("/api/projections/p_trash");
    expect((deleteCalls[0][1]?.headers as Record<string, string>)["If-Match"]).toBe("4");
  });

  it("keeps the row when a permanent delete 409s (nothing erased)", async () => {
    localStorage.setItem("projections.owner_token", "owner-abc");
    mockFetch((url, init) => {
      if (init?.method === "DELETE") {
        return new Response(
          JSON.stringify({ detail: { error: "version_conflict", current_version: 9 } }),
          { status: 409 },
        );
      }
      return new Response(JSON.stringify(trashed), { status: 200 });
    });

    render(<TrashPage />);
    await screen.findByText("Grace Mission");
    await userEvent.click(screen.getByTestId("purge-p_trash"));
    await userEvent.type(screen.getByTestId("confirm-purge-input"), "Grace Mission");
    await userEvent.click(screen.getByTestId("confirm-purge-accept"));

    // The dialog closes but the row remains (the conflict means nothing was erased).
    await waitFor(() => expect(screen.queryByTestId("confirm-purge-dialog")).toBeNull());
    expect(screen.getByText("Grace Mission")).toBeInTheDocument();
  });

  it("keeps the row when a restore 409s", async () => {
    localStorage.setItem("projections.owner_token", "owner-abc");
    mockFetch((url) => {
      if (url.includes("/restore")) {
        return new Response(JSON.stringify({ detail: { error: "version_conflict" } }), {
          status: 409,
        });
      }
      return new Response(JSON.stringify(trashed), { status: 200 });
    });

    render(<TrashPage />);
    await screen.findByText("Grace Mission");
    await userEvent.click(screen.getByTestId("restore-p_trash"));
    // The restore failed; the row stays in Trash.
    await waitFor(() =>
      expect(screen.getByTestId("restore-p_trash")).toBeEnabled(),
    );
    expect(screen.getByText("Grace Mission")).toBeInTheDocument();
  });
});

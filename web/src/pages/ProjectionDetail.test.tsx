// web/src/pages/ProjectionDetail.test.tsx — detail load-failure + header chips.
//
// #146: a 404/failed load renders a load-failed DegradedState, never an infinite
// "Loading…" spinner. #150: a successful load publishes the server model_version
// into the shared TopBar header chip (detail-page-only; rendered by App).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectionDetail } from "./ProjectionDetail";
import { App } from "../App";
import { clearDetailHeader } from "../state/detailHeader";
import type { ViewModel } from "../api/viewModel";

function fullVm(overrides: Partial<ViewModel> = {}): ViewModel {
  return {
    reco: { tag: "proceed", headline: "Proceed.", sub: "The trough is covered." },
    metrics: {
      capital: { raw: 277990, display: "$277,990" },
      cashGap: { raw: -219990, display: "($219,990)" },
      breakeven: { raw: 5, display: "Month 5" },
    },
    kpis: [
      { label: "Total revenue", value: { raw: 426911, display: "$426,911" }, sub: "Year 1" },
    ],
    monthly: [
      { month: 0, revenue: { raw: 0, display: "$0" }, expenses: { raw: 31870, display: "($31,870)" }, net: { raw: -14793, display: "($14,793)" }, cumulativeCash: { raw: -199793, display: "($199,793)" } },
      { month: 12, revenue: { raw: 53364, display: "$53,364" }, expenses: { raw: 32077, display: "($32,077)" }, net: { raw: 20718, display: "$20,718" }, cumulativeCash: { raw: -173000, display: "($173,000)" } },
    ],
    breakevenMonth: 5,
    rows: [
      { label: "Total Revenue", group: "revenue", y1: { raw: 426911, display: "$426,911" }, y2: { raw: 560000, display: "$560,000" }, y3: { raw: 700000, display: "$700,000" }, class: "computed", editable: false },
    ],
    settings: {},
    version: 3,
    view_slug: "p_8x",
    name: "House of Hope",
    model_version: "2.1.0",
    ...overrides,
  };
}

vi.mock("../api/viewModel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/viewModel")>();
  return {
    ...actual,
    fetchProjection: vi.fn(),
  };
});

// Imported after the mock so it resolves to the mocked function.
import { fetchProjection } from "../api/viewModel";

afterEach(() => {
  vi.clearAllMocks();
  clearDetailHeader();
  window.history.pushState({}, "", "/");
});

describe("ProjectionDetail — load failure (#146)", () => {
  it("renders a load-failed degraded state, not an infinite spinner, on a 404", async () => {
    vi.mocked(fetchProjection).mockRejectedValueOnce(
      new Error("GET /projections/missing failed: 404"),
    );
    render(<ProjectionDetail slug="missing" edit={false} />);
    expect(await screen.findByTestId("degraded-load-failed")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("announces the load failure assertively and offers a recovery action", async () => {
    vi.mocked(fetchProjection).mockRejectedValueOnce(new Error("404"));
    render(<ProjectionDetail slug="missing" edit={false} />);
    const region = await screen.findByTestId("degraded-load-failed");
    expect(region).toHaveAttribute("role", "alert");
    expect(within(region).getByRole("button")).toBeInTheDocument();
  });
});

describe("ProjectionDetail — header model-version chip (#150)", () => {
  it("publishes the server model_version into the shared TopBar on the detail route", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    window.history.pushState({}, "", "/p/p_8x");
    render(<App />);
    const chip = await screen.findByTestId("version-chip");
    expect(chip).toHaveTextContent("model 2.1.0");
  });
});

describe("ProjectionDetail — Penny mount (PE6, #125)", () => {
  beforeEach(() => {
    // Edit mode reads the owner token from localStorage when no edit fragment is
    // present (issue #143). Penny's mutate path needs it.
    localStorage.setItem("projections.owner_token", "owner-tok");
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("mounts the Penny FAB on the editable detail page when AI is on", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit aiOff={false} />);
    const fab = await screen.findByTestId("penny-fab");
    expect(fab).toHaveAttribute("data-state", "ai-enabled");
    expect(fab).toHaveAccessibleName(/ask penny/i);
  });

  it("degrades to the muted Settings FAB when AI is opt-out (?ai=off) — never a dead-end", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit aiOff />);
    const fab = await screen.findByTestId("penny-fab");
    expect(fab).toHaveAttribute("data-state", "ai-disabled");
    expect(fab.tagName).toBe("A");
    expect(fab).toHaveAccessibleName(/settings/i);
  });

  it("does not mount Penny in read-only mode (no edit token to mutate with)", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    await screen.findByTestId("decision-banner");
    expect(screen.queryByTestId("penny-fab")).not.toBeInTheDocument();
  });

  it("refetches the view-model after Penny applies an edit (tiles reflect the new computed_json)", async () => {
    vi.mocked(fetchProjection)
      .mockResolvedValueOnce(fullVm()) // initial load — capital $277,990
      .mockResolvedValueOnce(
        fullVm({
          metrics: { ...fullVm().metrics, capital: { raw: 311111, display: "$311,111" } },
        }),
      );

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              turns_appended: [{ id: "a1", role: "assistant", content: "Done. Capital updated." }],
              provider: "anthropic",
              applied_revisions: ["rev_2"],
              narration: "Done. Capital updated.",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );

    const user = userEvent.setup();
    render(<ProjectionDetail slug="p_8x" edit aiOff={false} />);

    // Initial computed_json on screen (the capital tile).
    await screen.findByTestId("metric-capital");
    expect(screen.getByTestId("metric-capital")).toHaveTextContent("$277,990");

    // Drive a Penny turn that applies an edit.
    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    await user.type(screen.getByRole("textbox", { name: /ask penny/i }), "raise the reserve");
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    // The applied edit triggers a refetch → the tile reflects the NEW figure.
    await waitFor(() => expect(screen.getByTestId("metric-capital")).toHaveTextContent("$311,111"));
    await waitFor(() => expect(vi.mocked(fetchProjection)).toHaveBeenCalledTimes(2));

    vi.unstubAllGlobals();
  });
});

describe("ProjectionDetail — per-field change affordance (PE7, #126)", () => {
  beforeEach(() => {
    localStorage.setItem("projections.owner_token", "owner-tok");
  });
  afterEach(() => {
    localStorage.clear();
  });

  /** A view-model carrying an editable Year-1 donor-share cell + row. */
  function shareVm(shareY1: { raw: number; display: string }, version: number): ViewModel {
    return fullVm({
      version,
      rows: [
        {
          label: "Donor market share",
          group: "drivers",
          y1: shareY1,
          y2: { raw: 0.08, display: "8.0%" },
          y3: { raw: 0.1, display: "10.0%" },
          class: "input",
          editable: true,
        },
        {
          label: "Total Revenue",
          group: "revenue",
          y1: { raw: 426911, display: "$426,911" },
          y2: { raw: 560000, display: "$560,000" },
          y3: { raw: 700000, display: "$700,000" },
          class: "computed",
          editable: false,
        },
      ],
      settings: {
        shareY1,
        shareY2: { raw: 0.08, display: "8.0%" },
        shareY3: { raw: 0.1, display: "10.0%" },
      },
    });
  }

  it("surfaces 'changed by Penny' + subtle 'was 6.0%' on the share cell after Penny applies, and the per-field undo forward-PATCHes the prior value (If-Match)", async () => {
    vi.mocked(fetchProjection)
      .mockResolvedValueOnce(shareVm({ raw: 0.06, display: "6.0%" }, 3)) // initial load
      .mockResolvedValueOnce(shareVm({ raw: 0.08, display: "8.0%" }, 4)); // after Penny applies

    const fetchMock = vi.fn((url: string, _opts?: RequestInit) => {
      const u = String(url);
      if (u.includes("/penny")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              turns_appended: [{ id: "a1", role: "assistant", content: "Done. Year-1 share is now 8.0%." }],
              provider: "anthropic",
              applied_revisions: ["rev_2"],
              narration: "Done. Year-1 share is now 8.0%.",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      // The undo forward-PATCH → reverted view-model with a fresh version (ETag).
      return Promise.resolve(
        new Response(JSON.stringify(shareVm({ raw: 0.06, display: "6.0%" }, 5)), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: "5" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<ProjectionDetail slug="p_8x" edit aiOff={false} />);

    // Drive a Penny turn that applies a share edit.
    await user.click(await screen.findByTestId("penny-fab"));
    await screen.findByRole("dialog");
    await user.type(screen.getByRole("textbox", { name: /ask penny/i }), "set year-1 share to 8%");
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    // The share cell shows the recent-change affordance (icon + text, not color
    // alone) + the subtle prior value, derived from the server display string.
    const fc = await screen.findByTestId("field-change");
    expect(within(fc).getByTestId("field-change-badge")).toHaveTextContent(/changed by penny/i);
    expect(within(fc).getByTestId("field-change-was")).toHaveTextContent("was 6.0%");

    // Per-field undo → a FORWARD PATCH restoring the prior value (0.06), carrying
    // If-Match: the post-apply version (4). Never history erasure.
    await user.click(screen.getByTestId("field-change-undo"));
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([u, o]) => String(u).includes("/projections/p_8x") && (o as RequestInit)?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      const opts = patchCall![1] as RequestInit;
      // Donor shares PATCH as a flat `inputs.share_yN` (an engine Inputs field).
      // The old nested `inputs.demand.share_y1` shape 422'd at the real merge path
      // (Inputs(**{demand: ...}) -> unknown kwarg), so the undo could never settle.
      expect(JSON.parse(opts.body as string)).toEqual({ inputs: { share_y1: 0.06 } });
      expect((opts.headers as Record<string, string>)["If-Match"]).toBe("4");
    });

    vi.unstubAllGlobals();
  });
});

// #203 — the read-only detail page rendered no page heading; the first heading was
// an <h3>, so h1/h2 were skipped (WCAG 1.3.1 / 2.4.6). A visible h1 names the
// projection and a section h2 keeps the existing h3s from skipping levels.
describe("ProjectionDetail — heading hierarchy (a11y #203)", () => {
  it("renders an h1 naming the projection on the read view", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent(/House of Hope/i);
  });

  it("inserts an h2 section heading so the existing h3s don't skip levels", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
  });
});

// #188 — the LIVE server raises 409 as `HTTPException(detail={...})` → `{"detail":
// {...}}`. The client parsed it FLAT, so `current_version` was undefined and the
// Overwrite path re-sent the STALE If-Match → a 409 loop the owner could never
// escape. With the nested-envelope parse, Overwrite re-sends the server's current
// version and the force-save lands.
describe("ProjectionDetail — 409 Overwrite resolves (does not loop) #188", () => {
  beforeEach(() => {
    localStorage.setItem("projections.owner_token", "owner-tok");
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("re-sends the server's current_version on Overwrite so the save lands", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm()); // version 3
    const ifMatches: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "PATCH") {
          const ifMatch = new Headers(init?.headers).get("If-Match") ?? "";
          ifMatches.push(ifMatch);
          if (ifMatch === "3") {
            // Stale write → the live server's nested {detail:{...}} 409 envelope.
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  detail: {
                    error: "version_conflict",
                    current_version: 9,
                    your_version: 3,
                    current_state: fullVm({ version: 9 }),
                    recovery: "reload | overwrite | save_as_copy",
                  },
                }),
                { status: 409, headers: { "Content-Type": "application/json" } },
              ),
            );
          }
          // Overwrite carries If-Match: 9 → accepted.
          const next = Number(ifMatch) + 1;
          return Promise.resolve(
            new Response(JSON.stringify(fullVm({ version: next })), {
              status: 200,
              headers: { "Content-Type": "application/json", ETag: `"${next}"` },
            }),
          );
        }
        return Promise.resolve(
          new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
        );
      }),
    );

    const user = userEvent.setup();
    render(<ProjectionDetail slug="p_8x" edit aiOff={false} />);

    const nameInput = await screen.findByLabelText("Store name");
    await user.type(nameInput, "Z"); // debounced PATCH with the stale If-Match: 3

    // The stale write surfaces the conflict modal.
    await screen.findByTestId("save-conflict-modal");

    // Owner chooses Overwrite — the force-save must succeed, not loop.
    await user.click(screen.getByRole("button", { name: /overwrite/i }));

    await waitFor(() => expect(screen.queryByTestId("save-conflict-modal")).toBeNull());
    // The decisive proof: the Overwrite used the SERVER's current version (9), not
    // the stale client version (3) — the flat parse never learned "9".
    expect(ifMatches).toContain("9");

    vi.unstubAllGlobals();
  });
});

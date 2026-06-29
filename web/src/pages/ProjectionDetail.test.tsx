// web/src/pages/ProjectionDetail.test.tsx — detail load-failure + header chips.
//
// #146: a 404/failed load renders a load-failed DegradedState, never an infinite
// "Loading…" spinner. #38: the model_version is no longer displayed — even after a
// successful load, no version chip is rendered (it stays on computed_json).
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
    milestones: {
      grandOpening: { raw: 1, display: "Month 1" },
      breakEven: { raw: 5, display: "Month 5" },
      payback: { raw: 25, display: "Month 25", duration: "25 months" },
    },
    incomeSeries: [
      { raw: 46000, display: "$46,000" },
      { raw: 60000, display: "$60,000" },
      { raw: 80000, display: "$80,000" },
      { raw: 90000, display: "$90,000" },
      { raw: 100000, display: "$100,000" },
    ],
    year5Income: { raw: 100000, display: "$100,000" },
    rows: [
      { label: "Total Revenue", group: "revenue", y1: { raw: 426911, display: "$426,911" }, y2: { raw: 560000, display: "$560,000" }, y3: { raw: 700000, display: "$700,000" }, class: "computed", editable: false },
    ],
    settings: {},
    location: { lat: 32.5, lng: -94.7, formatted_address: "123 Main St, Longview, TX" },
    updated_at: "2026-06-20T12:00:00Z",
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

describe("ProjectionDetail — no model-version chip (#38)", () => {
  it("never renders a model-version chip even after the projection loads", async () => {
    // model_version stays on computed_json (vm.model_version is still "2.1.0"),
    // but it is no longer displayed anywhere in the UI (#38).
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    window.history.pushState({}, "", "/p/p_8x");
    render(<App />);
    // Wait for the projection to actually load before asserting the chip's absence.
    await screen.findByTestId("decision-banner");
    expect(screen.queryByTestId("version-chip")).not.toBeInTheDocument();
    expect(screen.queryByText(/^model\s/i)).not.toBeInTheDocument();
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
    expect(fab).toHaveAccessibleName(/penny ai/i);
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

describe("App shell — Penny is openable on every primary route (#264, Epic E #3)", () => {
  afterEach(() => {
    localStorage.clear();
    window.history.pushState({}, "", "/");
  });

  it("mounts the general-help Penny on a READ-ONLY detail view (the page mounts none of its own)", async () => {
    // The read-only detail page has no edit token, so it mounts NO Penny of its own
    // (asserted above). The App shell adds the general-help Penny so Penny is still
    // openable here — and it never errors with no editable projection loaded.
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    window.history.pushState({}, "", "/p/p_8x"); // view route, NO /edit
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("decision-banner");

    const fab = screen.getByTestId("penny-fab"); // exactly one (throws if doubled)
    expect(fab).toHaveAttribute("data-state", "ai-enabled");
    expect(fab).toHaveAccessibleName(/penny ai/i);

    await user.click(fab);
    await screen.findByRole("dialog");
    await waitFor(() =>
      expect(screen.getByTestId("penny-transcript")).toHaveTextContent(/i'm penny/i),
    );
  });

  it("does NOT double-mount Penny on the editable detail page (the page mounts its own)", async () => {
    // Edit mode mounts the live PennyAssistant; the shell must NOT add a second FAB.
    localStorage.setItem("projections.owner_token", "owner-tok");
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    window.history.pushState({}, "", "/p/p_8x/edit");
    render(<App />);
    await screen.findByTestId("decision-banner");
    expect(screen.getAllByTestId("penny-fab")).toHaveLength(1);
  });

  it("honors ?ai=off on the read-only view: the shell's Penny degrades to the muted FAB", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    window.history.pushState({}, "", "/p/p_8x?ai=off");
    render(<App />);
    await screen.findByTestId("decision-banner");
    const fab = screen.getByTestId("penny-fab");
    expect(fab).toHaveAttribute("data-state", "ai-disabled");
    expect(fab).toHaveAccessibleName(/settings/i);
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

// A subtle, keyboard-accessible "Back to projections" link returns to the owner
// list (route "/") without a full reload.
describe("ProjectionDetail — back-to-projections nav", () => {
  it("renders a keyboard-accessible back link that SPA-navigates to the list", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    window.history.pushState({}, "", "/p/p_8x");
    const user = userEvent.setup();
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    const back = await screen.findByTestId("back-to-projections");
    expect(back).toHaveAttribute("href", "/");
    expect(back).toHaveAccessibleName(/back to projections/i);
    await user.click(back);
    expect(window.location.pathname).toBe("/");
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

  it("keeps h2 section headings so the page never skips h1→h3", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    await screen.findByRole("heading", { level: 1 });
    // The Projection panel section headings ("3-year projection", "First-year cash
    // flow") are h2 (Epic G removed the standalone "Decision & 3-year projection").
    expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("heading", { name: /decision & 3-year projection/i }),
    ).not.toBeInTheDocument();
  });
});

// Epic G (#39/#40/#41) — the owner detail page de-duplicates the decision, hides the
// cash-gap tile, relabels the capital tile, and reflows into a Projection | KPIs IA
// with Settings merged into the KPIs tab + a trade-area map in the upper-right.
describe("ProjectionDetail — Epic G reorg", () => {
  it("SUPPRESSES the verdict on the owner read page (reco headline/sub not repeated)", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    await screen.findByTestId("decision-banner");
    expect(screen.queryByTestId("reco-chip")).not.toBeInTheDocument();
    expect(screen.queryByText(/the trough is covered/i)).not.toBeInTheDocument();
  });

  it("HIDES the first-year cash-gap metric (metric.cashGap stays in the vm)", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    await screen.findByTestId("decision-banner");
    expect(screen.queryByTestId("metric-cashgap")).not.toBeInTheDocument();
    // D1: the header metric bar carries Capital required (RED), Payback, Break-even.
    expect(screen.getByTestId("metric-capital")).toHaveTextContent("$277,990");
    expect(screen.getByTestId("metric-breakeven")).toBeInTheDocument();
    expect(screen.getByTestId("metric-payback")).toBeInTheDocument();
  });

  it("renders the 2nd tile set (KPIs) inline on the read page so kpi-revenue is visible", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    expect(await screen.findByTestId("kpi-revenue")).toBeInTheDocument();
    // No Settings on the read page.
    expect(screen.queryByTestId("settings-tab")).not.toBeInTheDocument();
  });

  it("places the trade-area map in the page header (upper-right)", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    await screen.findByTestId("decision-banner");
    expect(screen.getByTestId("detail-map")).toBeInTheDocument();
  });

  it("edit mode shows a Projection | KPIs tablist and merges KPIs + Settings into the KPIs tab (D11)", async () => {
    localStorage.setItem("projections.owner_token", "owner-tok");
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    const user = userEvent.setup();
    render(<ProjectionDetail slug="p_8x" edit aiOff={false} />);
    await screen.findByTestId("decision-banner");

    // The tablist is Projection | KPIs (no standalone Settings tab).
    expect(screen.getByRole("tab", { name: /projection/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /kpis/i })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /^settings$/i })).not.toBeInTheDocument();

    // The merged KPIs+drivers grid is hidden under the (inactive) KPIs tab, then
    // revealed on activation. The derived KPI + an editable driver live in ONE grid.
    expect(screen.getByTestId("settings-tab")).not.toBeVisible();
    await user.click(screen.getByRole("tab", { name: /kpis/i }));
    expect(screen.getByTestId("settings-tab")).toBeVisible();
    expect(screen.getByTestId("kpi-revenue")).toBeVisible();
    // D10: the standalone "Pinned overrides" audit block is gone from the KPIs tab.
    expect(screen.queryByTestId("kpis-override-audit")).not.toBeInTheDocument();
    localStorage.clear();
  });
});

// EPIC D — D1 header (name + inline pencil rename, address, updated date, the 4-cell
// metric bar with the income sparkline + capital-RED), D9 (.xlsx/.docx at the top),
// D8 (no bottom feedback button).
describe("ProjectionDetail — D1 header + D9 downloads", () => {
  it("renders the income sparkline (annual net income) with the Y5 income label in the metric bar", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    const income = await screen.findByTestId("metric-income");
    // The Sparkline is a role=img naming the Y1→Y5 net-income series + the Y5 value.
    const spark = within(income).getByRole("img");
    expect(spark).toHaveAccessibleName(/net income year 1 to year 5/i);
    expect(spark).toHaveAccessibleName(/\$100,000/); // the Y5 income label
  });

  it("renders the address (muted) and the updated date when the server provides them", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    expect(await screen.findByTestId("detail-address")).toHaveTextContent("Longview, TX");
    expect(screen.getByTestId("detail-updated")).toHaveTextContent(/updated/i);
  });

  it("omits the updated date when the server does not provide one (never a fabricated date)", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm({ updated_at: undefined }));
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    await screen.findByTestId("decision-banner");
    expect(screen.queryByTestId("detail-updated")).not.toBeInTheDocument();
  });

  it("places the .xlsx and .docx downloads at the top with the correct hrefs (D9)", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    const xlsx = await screen.findByTestId("download-xlsx");
    const docx = screen.getByTestId("download-docx");
    expect(xlsx).toHaveAttribute("href", "/api/projections/p_8x/xlsx");
    expect(docx).toHaveAttribute("href", "/api/projections/p_8x/packet?format=docx");
    // Both live in the header download cluster (top), not a bottom actions row.
    expect(screen.getByTestId("detail-downloads")).toContainElement(xlsx);
  });

  it("D8: renders no bottom Feedback button", async () => {
    localStorage.setItem("projections.owner_token", "owner-tok");
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit aiOff={false} />);
    await screen.findByTestId("decision-banner");
    expect(screen.queryByRole("button", { name: /^feedback$/i })).not.toBeInTheDocument();
    localStorage.clear();
  });

  it("D1/Decision 13: the always-on 'Store name' input is gone; a pencil reveals the rename input", async () => {
    localStorage.setItem("projections.owner_token", "owner-tok");
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    const user = userEvent.setup();
    render(<ProjectionDetail slug="p_8x" edit aiOff={false} />);
    await screen.findByTestId("decision-banner");
    // No always-on Store-name input.
    expect(screen.queryByLabelText("Store name")).not.toBeInTheDocument();
    // The pencil reveals it.
    await user.click(screen.getByTestId("rename-projection"));
    expect(screen.getByLabelText("Store name")).toBeInTheDocument();
    localStorage.clear();
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

    // D1/Decision 13: the rename input is behind the inline pencil now.
    await user.click(await screen.findByTestId("rename-projection"));
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

// ============================================================================
// Epic G2 (decision #42, #266) — the standalone Override Inspector is ELIMINATED.
// Its function moved into Penny (the focused justification capture) + the KPIs tab
// (the at-a-glance audit). The override DATA model + server contract are unchanged:
// reset PATCHes overrides.clear; a saved justification re-pins the SAME value with the
// note via overrides.set. A §12.2 guardrail that needs a note slides Penny OUT.
// ============================================================================
describe("ProjectionDetail — Override Inspector → Penny (#42)", () => {
  beforeEach(() => {
    localStorage.setItem("projections.owner_token", "owner-tok");
  });
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  /** A view-model carrying one pinned override (Payroll, Year 1). */
  function overrideVm(over: Partial<ViewModel> = {}): ViewModel {
    return fullVm({
      version: 3,
      rows: [
        {
          label: "Payroll",
          group: "expenses",
          node: "payroll",
          y1: { raw: 120000, display: "$120,000" },
          y2: null,
          y3: null,
          class: "overridden",
          editable: true,
        },
      ],
      overrides: [
        {
          node: "payroll",
          year: 1,
          calculated: { raw: 140000, display: "$140,000" },
          value: { raw: 120000, display: "$120,000" },
          note: "",
        },
      ],
      staleNodes: [],
      ...over,
    });
  }

  /** Stub fetch to capture PATCH bodies and echo a bumped view-model. */
  function patchCapture() {
    const bodies: Array<Record<string, unknown>> = [];
    const ifMatches: string[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "PATCH") {
        ifMatches.push(new Headers(init?.headers).get("If-Match") ?? "");
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(
          new Response(JSON.stringify(overrideVm({ version: 4 })), {
            status: 200,
            headers: { "Content-Type": "application/json", ETag: '"4"' },
          }),
        );
      }
      return Promise.resolve(
        new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    return { bodies, ifMatches };
  }

  it("mounts NO standalone Override Inspector FAB on the editable page (it is eliminated)", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(overrideVm());
    render(<ProjectionDetail slug="p_8x" edit aiOff={false} />);
    await screen.findByTestId("penny-fab");
    expect(screen.queryByTestId("inspector-fab")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inspector-panel")).not.toBeInTheDocument();
  });

  it("D10: removes the standalone 'Pinned overrides' audit block from the KPIs tab", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(overrideVm());
    const user = userEvent.setup();
    render(<ProjectionDetail slug="p_8x" edit aiOff={false} />);
    await screen.findByTestId("decision-banner");

    await user.click(screen.getByRole("tab", { name: /kpis/i }));
    // The at-a-glance "Pinned overrides" audit is gone (override justification now
    // lives only in Penny's drawer). The merged KPIs grid is still there.
    expect(screen.queryByTestId("kpis-override-audit")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-tab")).toBeVisible();
  });

  it("slides Penny OUT with the prompt + saves the justification (overrides.set) when a §12.2 guardrail needs an unrecorded note", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(
      overrideVm({ flags: { net_margin_out_of_band: { value: 0.39, band: "≤ ~30%", requires_note: true } } }),
    );
    const { bodies } = patchCapture();
    const user = userEvent.setup();
    render(<ProjectionDetail slug="p_8x" edit aiOff={false} />);
    // No FAB click: the guardrail auto-opens Penny straight onto the justification.
    const form = await screen.findByTestId("override-comment-form");
    const input = within(form).getByLabelText(/why did you override payroll, year 1\?/i);
    await user.type(input, "signed two hires");
    await user.click(within(form).getByTestId("override-comment-save"));

    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    // The note persists on the pin by re-setting the SAME value (no data-model change).
    expect(bodies[0]).toEqual({
      overrides: { set: [{ node: "payroll", year: 1, value: "120000", note: "signed two hires" }] },
    });
  });

  // P1 REGRESSION (#284): activating an editable cell in the 3-year table was a
  // dead no-op — ProjectionDetail never wired ProjectionTab's onEditCell, so the
  // cell button only took a focus ring and never opened the override editor. The
  // value-change entry point (the whole reason a component cell is editable) was
  // lost when the Override Inspector was removed. Activating the cell must open an
  // inline editor and pin the typed value via the EXISTING overrides.set contract
  // (the §12.2 guardrail then slides Penny out for the note — covered above).
  it("activating an editable component cell opens an inline editor and pins the typed value via overrides.set", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(overrideVm());
    const { bodies, ifMatches } = patchCapture();
    const user = userEvent.setup();
    render(<ProjectionDetail slug="p_8x" edit aiOff={false} />);
    await screen.findByTestId("decision-banner");

    // The editable Payroll cell in the 3-year table is a button (focus ring only,
    // pre-fix). Activating it must OPEN an inline editor — not be a silent no-op.
    const cell = screen.getByTestId("cell-Payroll-y1");
    expect(cell.tagName).toBe("BUTTON");
    await user.click(cell);

    // An inline editor mounts, seeded with the cell's raw value, and is focused.
    const input = await screen.findByTestId("cell-Payroll-y1-input");
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "130000{Enter}");

    // Persists via the EXISTING override contract — overrides.set {node,year,value},
    // carrying the optimistic-concurrency If-Match. No data-model/server change.
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect(bodies[0]).toEqual({
      overrides: { set: [{ node: "payroll", year: 1, value: "130000" }] },
    });
    expect(ifMatches[0]).toBe("3");
  });
});

// EPIC SHARE (Decision 12) — the unified Share affordance on the detail header. The
// read-only link is always offered; the editable link appears only when this device
// holds the projection's edit token (localStorage), and carries it in the fragment.
describe("ProjectionDetail — Share affordance (EPIC SHARE)", () => {
  afterEach(() => {
    localStorage.clear();
    window.history.pushState({}, "", "/");
  });

  it("opens the Share panel with the read-only view_slug link", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    const user = userEvent.setup();
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    await screen.findByTestId("decision-banner");

    await user.click(screen.getByTestId("share-projection"));
    const readonly = (await screen.findByTestId("share-readonly-link")) as HTMLInputElement;
    expect(readonly.value).toBe(`${window.location.origin}/p/p_8x`);
  });

  it("offers the editable link (token in the fragment) when the edit token is held", async () => {
    localStorage.setItem("projections.edit_token.p_8x", "edit_secret_xyz");
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    const user = userEvent.setup();
    render(<ProjectionDetail slug="p_8x" edit aiOff={false} />);
    await screen.findByTestId("decision-banner");

    await user.click(screen.getByTestId("share-projection"));
    const editLink = (await screen.findByTestId("share-edit-link")) as HTMLInputElement;
    expect(editLink.value).toBe(`${window.location.origin}/p/p_8x/edit#edit_secret_xyz`);
    // Regression #10: the secret is in the fragment, never the path/query.
    expect(new URL(editLink.value).pathname).not.toContain("edit_secret_xyz");
  });

  it("omits the editable link when no edit token is held on this device", async () => {
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    const user = userEvent.setup();
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    await screen.findByTestId("decision-banner");

    await user.click(screen.getByTestId("share-projection"));
    await screen.findByTestId("share-readonly-link");
    expect(screen.queryByTestId("share-edit-link")).not.toBeInTheDocument();
    expect(screen.getByTestId("share-edit-unavailable")).toBeInTheDocument();
  });
});

describe("ProjectionDetail — Move to Trash (soft delete, owner-only)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("shows a Delete affordance for the owner and trashes on confirm → navigates home", async () => {
    localStorage.setItem("projections.owner_token", "owner-tok");
    vi.mocked(fetchProjection).mockResolvedValue(fullVm()); // version 3
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ version: 4, status: "trashed" }), {
          status: 200,
          headers: { ETag: "4" },
        }),
      );
    window.history.pushState({}, "", "/p/p_8x/edit");
    const user = userEvent.setup();
    render(<ProjectionDetail slug="p_8x" edit />);
    await screen.findByTestId("decision-banner");

    await user.click(screen.getByTestId("trash-projection"));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await user.click(screen.getByTestId("confirm-accept"));

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    // POST /trash with the loaded version as If-Match; no secret in the URL.
    const trashCall = fetchSpy.mock.calls.find(([u]) => String(u).includes("/trash"));
    expect(trashCall).toBeTruthy();
    expect(String(trashCall![0])).toContain("/api/projections/p_8x/trash");
    const init = trashCall![1] as RequestInit;
    expect((init.headers as Record<string, string>)["If-Match"]).toBe("3");
    expect(String(trashCall![0])).not.toContain("owner-tok");
  });

  it("does NOT show the Delete affordance in read-only mode", async () => {
    localStorage.setItem("projections.owner_token", "owner-tok");
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    render(<ProjectionDetail slug="p_8x" edit={false} />);
    await screen.findByTestId("decision-banner");
    expect(screen.queryByTestId("trash-projection")).not.toBeInTheDocument();
  });

  it("does NOT show the Delete affordance to an editor (share link, not the owner)", async () => {
    // No owner token on this device; the edit capability rides the fragment → editor,
    // not owner. Trash is owner-only on the server, so the button is hidden.
    vi.mocked(fetchProjection).mockResolvedValue(fullVm());
    window.history.pushState({}, "", "/p/p_8x/edit#edit-secret");
    render(<ProjectionDetail slug="p_8x" edit />);
    await screen.findByTestId("decision-banner");
    expect(screen.queryByTestId("trash-projection")).not.toBeInTheDocument();
  });
});

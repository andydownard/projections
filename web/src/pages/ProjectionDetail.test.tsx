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

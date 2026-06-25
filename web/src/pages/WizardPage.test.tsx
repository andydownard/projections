import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WizardPage } from "./WizardPage";
import type { ViewModel } from "../api/viewModel";

// SLICE 5 — the /wizard route must expose a directly-fillable express create form
// (households + the three explicit Y1/Y2/Y3 shares + Generate) so the happy-path
// E2E can generate a projection without stepping a multi-page wizard. On Generate
// the server view-model renders the decision banner + KPI strip + cash-flow. NO
// client math: every figure is the server's.

const VM: ViewModel = {
  reco: { tag: "proceed", headline: "Proceed.", sub: "Capital is within reach." },
  metrics: {
    capital: { raw: 277990, display: "$277,990" },
    cashGap: { raw: -12400, display: "($12,400)" },
    breakeven: { raw: 5, display: "Month 5" },
  },
  kpis: [{ label: "Total revenue", value: { raw: 426911, display: "$426,911" } }],
  monthly: [
    { month: 0, revenue: { raw: 0, display: "$0" }, expenses: { raw: 0, display: "$0" }, net: { raw: 0, display: "$0" }, cumulativeCash: { raw: 0, display: "$0" } },
  ],
  breakevenMonth: 5,
  rows: [],
  settings: {},
  version: 1,
  view_slug: "p_new",
  name: "House of Hope",
};

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("WizardPage express form", () => {
  it("exposes households + three share fields + a generate button", () => {
    render(<WizardPage />);
    expect(screen.getByLabelText(/households/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 1 share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 2 share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 3 share/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate/i })).toBeInTheDocument();
  });

  it("POSTs to the server and renders the decision banner from the view-model", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ...VM, owner_token: "tok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<WizardPage />);
    await user.clear(screen.getByLabelText(/households/i));
    await user.type(screen.getByLabelText(/households/i), "31798");
    await user.click(screen.getByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(screen.getByTestId("decision-banner")).toBeInTheDocument();
    });
    expect(screen.getByTestId("metric-capital")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projections",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

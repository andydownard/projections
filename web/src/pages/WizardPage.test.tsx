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

  it("saves the RESOLVED address + Census provenance in the create payload", async () => {
    const RESOLVED = {
      location: { place_id: "PID_DAL", lat: 32.78, lng: -96.8, formatted_address: "Dallas, TX, USA" },
      trade_area: {
        basis: "city", households: 512000, geography_name: "Dallas city",
        geography_fips: "4819000", acs_vintage: "2022", households_source: "census_acs", moe: 1500,
        alternatives: { city: { geography_name: "Dallas city", fips: "4819000", households: 512000, moe: 1500 } },
      },
      evidence: { field: "households", label: "", value: 512000, method: "census_acs", source: "", source_date: "2022", confidence: "estimated", geography: "Dallas city" },
    };
    const json = (b: unknown) =>
      Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } }));
    const bodies: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes("/api/places/autocomplete"))
        return json({ predictions: [{ description: "Dallas, TX, USA", place_id: "PID_DAL" }] });
      if (url.includes("/api/places/resolve")) return json(RESOLVED);
      bodies[url] = JSON.parse(String(init?.body)); // /api/projections
      return json({ ...VM, owner_token: "tok" });
    });
    const user = userEvent.setup();
    render(<WizardPage />);
    await user.type(screen.getByRole("combobox", { name: /store address/i }), "Dallas");
    await user.click(await screen.findByRole("option", { name: /Dallas, TX/ }));
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(screen.getByTestId("decision-banner")).toBeInTheDocument());

    const body = bodies["/api/projections"] as {
      location: { formatted_address: string; place_id: string; query: string };
      inputs: { city: string };
      trade_area: { households_source: string };
    };
    expect(body.location.formatted_address).toBe("Dallas, TX, USA");
    expect(body.location.place_id).toBe("PID_DAL");
    expect(body.location.query).toBe("Dallas, TX, USA");
    expect(body.inputs.city).toBe("Dallas, TX, USA");
    expect(body.trade_area.households_source).toBe("census_acs");
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreateProjectionPage } from "./CreateProjectionPage";
import type { ViewModel } from "../api/viewModel";

// W2 — the full-page Create-Projection wizard shell: one step at a time, a step
// indicator, validation gating Next, Generate on the final step, Start-from-example,
// and households empty-until-resolved (§4). NO client math — every figure on the
// result screen is the server's { display } string (PRD §13).

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

const RESOLVED = {
  location: { place_id: "PID_DAL", lat: 32.78, lng: -96.8, formatted_address: "Dallas, TX, USA" },
  trade_area: {
    basis: "city", households: 512000, geography_name: "Dallas city",
    geography_fips: "4819000", acs_vintage: "2022", households_source: "census_acs", moe: 1500,
    alternatives: {
      city: { geography_name: "Dallas city", fips: "4819000", households: 512000, moe: 1500 },
      county: { geography_name: "Dallas County", fips: "48113", households: 980000, moe: 3000 },
    },
  },
  evidence: { field: "households", label: "", value: 512000, method: "census_acs", source: "", source_date: "2022", confidence: "estimated", geography: "Dallas city" },
};

function jsonResponse(b: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}

/** Wire fetch so autocomplete/resolve/create all answer; capture POST bodies. */
function wireFetch(bodies: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes("/api/places/autocomplete"))
      return jsonResponse({ predictions: [{ description: "Dallas, TX, USA", place_id: "PID_DAL" }] });
    if (url.includes("/api/places/resolve")) return jsonResponse(RESOLVED);
    bodies[url] = JSON.parse(String(init?.body));
    return jsonResponse({ ...VM, owner_token: "tok" });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("CreateProjectionPage shell", () => {
  it("renders the full-page title + a step indicator + Start-from-example", () => {
    render(<CreateProjectionPage />);
    expect(screen.getByRole("heading", { name: /create projection/i })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /create projection steps/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start from example/i })).toBeInTheDocument();
  });

  it("gates Next on the Store step until a name is entered", async () => {
    const user = userEvent.setup();
    render(<CreateProjectionPage />);
    const next = screen.getByRole("button", { name: /^next$/i });
    expect(next).toBeDisabled(); // name empty
    await user.type(screen.getByLabelText(/store name/i), "House of Hope");
    expect(next).toBeEnabled();
    await user.click(next);
    // advanced to Trade area
    expect(screen.getByRole("heading", { name: /trade area/i })).toBeInTheDocument();
  });
});

describe("CreateProjectionPage — Places predictions render", () => {
  it("shows address predictions in the combobox list", async () => {
    const bodies: Record<string, unknown> = {};
    wireFetch(bodies);
    const user = userEvent.setup();
    render(<CreateProjectionPage />);
    await user.type(screen.getByRole("combobox", { name: /store address/i }), "Dallas");
    expect(await screen.findByRole("option", { name: /Dallas, TX/ })).toBeInTheDocument();
  });
});

describe("CreateProjectionPage — households empty-until-resolved (§4)", () => {
  it("households is disabled until an address resolves, then populates from Census", async () => {
    const bodies: Record<string, unknown> = {};
    wireFetch(bodies);
    const user = userEvent.setup();
    render(<CreateProjectionPage />);

    // step to Trade area
    await user.type(screen.getByLabelText(/store name/i), "House of Hope");
    // resolve an address from the Store step first
    await user.type(screen.getByRole("combobox", { name: /store address/i }), "Dallas");
    await user.click(await screen.findByRole("option", { name: /Dallas, TX/ }));
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    const hh = screen.getByLabelText(/households/i) as HTMLInputElement;
    await waitFor(() => expect(hh.value).toBe("512000"));
    expect(hh).toBeEnabled();
    expect(screen.getByText(/U\.S\. Census ACS 2022/i)).toBeInTheDocument();
  });

  it("blocks Generate until households has a value (manual fallback path)", async () => {
    const bodies: Record<string, unknown> = {};
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes("/api/places/autocomplete"))
        return jsonResponse({ predictions: [{ description: "Nowhere", place_id: "PID_X" }] });
      if (url.includes("/api/places/resolve"))
        return Promise.resolve(new Response("{}", { status: 503 }));
      bodies[url] = JSON.parse(String(init?.body));
      return jsonResponse({ ...VM, owner_token: "tok" });
    });
    const user = userEvent.setup();
    render(<CreateProjectionPage />);

    await user.type(screen.getByLabelText(/store name/i), "Manual Co");
    await user.type(screen.getByRole("combobox", { name: /store address/i }), "Nowhere");
    await user.click(await screen.findByRole("option", { name: /Nowhere/ }));
    // resolve fails -> manual fallback; advance to Trade area
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    const hh = screen.getByLabelText(/households/i) as HTMLInputElement;
    await waitFor(() => expect(hh).toBeEnabled());
    expect(screen.getByText(/enter households manually/i)).toBeInTheDocument();
    // Next still blocked (no value yet)
    expect(screen.getByRole("button", { name: /^next$/i })).toBeDisabled();
    await user.type(hh, "25000");
    expect(screen.getByRole("button", { name: /^next$/i })).toBeEnabled();
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("CreateProjectionPage — full flow to Generate", () => {
  it("steps through all five steps and POSTs the create body with the new inputs", async () => {
    const bodies: Record<string, unknown> = {};
    wireFetch(bodies);
    const user = userEvent.setup();
    render(<CreateProjectionPage />);

    // 1. Store
    await user.type(screen.getByLabelText(/store name/i), "House of Hope");
    await user.type(screen.getByRole("combobox", { name: /store address/i }), "Dallas");
    await user.click(await screen.findByRole("option", { name: /Dallas, TX/ }));
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    // 2. Trade area (households resolved)
    await waitFor(() => expect((screen.getByLabelText(/households/i) as HTMLInputElement).value).toBe("512000"));
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    // 3. Donor market (shares pre-seeded; Back/Next works)
    expect(screen.getByRole("heading", { name: /donor market/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^back$/i }));
    expect(screen.getByRole("heading", { name: /trade area/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    // 4. Cost schedule
    expect(screen.getByRole("heading", { name: /cost schedule/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    // 5. Review -> Generate
    expect(screen.getByRole("heading", { name: /review/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /generate/i }));

    await waitFor(() => expect(screen.getByTestId("decision-banner")).toBeInTheDocument());
    const body = bodies["/api/projections"] as {
      inputs: { opening_month_number: number; cost_schedule: unknown[]; target_opening_date: string | null };
      trade_area: { households_source: string };
    };
    expect(body.inputs.opening_month_number).toBe(1);
    expect(Array.isArray(body.inputs.cost_schedule)).toBe(true);
    expect(body.trade_area.households_source).toBe("census_acs");
    // result screen renders the server display string verbatim (no client math)
    const kpis = within(screen.getByTestId("kpi-strip"));
    expect(kpis.getByText("$426,911")).toBeInTheDocument();
  });
});

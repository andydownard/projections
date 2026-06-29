import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreateProjectionPage } from "./CreateProjectionPage";
import type { ViewModel } from "../api/viewModel";

// Phase 2 (Epics B/C) — the full-page Create-Projection wizard: one step at a time
// over a prominent breadcrumb under a subtle "CREATE PROJECTION" eyebrow, the revised
// order Address → Square footage → Households → Donor market share → Startup costs,
// terms implicit on "Generate projections", and Generate landing DIRECTLY on
// /p/<slug>/edit (no in-page result view). NO client math — every figure on the detail
// page is the server's { display } string (PRD §13).

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

// A representative server rent-research result (#245). The wizard pre-fills the rent
// (shown on the startup-costs step) with a verified-vs-estimated badge + sources.
const RESEARCH = {
  rent_per_sqft: 18, estimate: 18, low: 15, high: 22,
  rent_type: "nnn", opex: 3, basis: "$/sq ft/yr",
  confidence: "high", verified: true, provenance: "verified",
  sources: [{ url: "https://broker.example", title: "Longview retail lease", source_date: "2026-05" }],
  ai_enabled: true, cached: false,
};

/** Wire fetch so autocomplete/resolve/research/create all answer; capture POST bodies. */
function wireFetch(bodies: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes("/api/places/autocomplete"))
      return jsonResponse({ predictions: [{ description: "Dallas, TX, USA", place_id: "PID_DAL" }] });
    if (url.includes("/api/places/resolve")) return jsonResponse(RESOLVED);
    if (url.includes("/api/research")) {
      bodies[url] = JSON.parse(String(init?.body));
      return jsonResponse(RESEARCH);
    }
    bodies[url] = JSON.parse(String(init?.body));
    return jsonResponse({ ...VM, owner_token: "tok" });
  });
}

/** Resolve an address on step 1, then advance to the given later step. */
async function resolveAddress(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("combobox", { name: /address/i }), "Dallas");
  await user.click(await screen.findByRole("option", { name: /Dallas, TX/ }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^next$/i })).toBeEnabled(),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  // The wizard is route-driven (each step is /wizard/<slug>, Epic B #261) — reset it
  // between tests so each starts fresh on the first step (Address).
  window.history.replaceState(null, "", "/wizard");
});

describe("CreateProjectionPage shell", () => {
  it("renders the subtle CREATE PROJECTION eyebrow + a step breadcrumb", () => {
    render(<CreateProjectionPage />);
    expect(screen.getByRole("heading", { name: /create projection/i })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /create projection steps/i })).toBeInTheDocument();
  });

  it("offers a subtle, keyboard-accessible 'Back to projections' link to the list (route '/')", async () => {
    const user = userEvent.setup();
    window.history.pushState(null, "", "/wizard");
    render(<CreateProjectionPage />);
    const back = screen.getByTestId("back-to-projections");
    expect(back).toHaveAttribute("href", "/");
    expect(back).toHaveAccessibleName(/back to projections/i);
    await user.click(back);
    expect(window.location.pathname).toBe("/");
    window.history.pushState(null, "", "/");
  });

  it("hides the bottom Back button on the first step (owner Decision 7)", () => {
    render(<CreateProjectionPage />);
    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();
  });

  it("gates Next on the address step until an address resolves (name is optional)", async () => {
    const bodies: Record<string, unknown> = {};
    wireFetch(bodies);
    const user = userEvent.setup();
    render(<CreateProjectionPage />);
    const next = screen.getByRole("button", { name: /^next$/i });
    expect(next).toBeDisabled(); // no address yet
    await resolveAddress(user);
    expect(next).toBeEnabled();
    await user.click(next);
    expect(screen.getByRole("heading", { name: /set square footage/i })).toBeInTheDocument();
  });
});

describe("CreateProjectionPage — Places predictions render", () => {
  it("shows address predictions in the combobox list", async () => {
    const bodies: Record<string, unknown> = {};
    wireFetch(bodies);
    const user = userEvent.setup();
    render(<CreateProjectionPage />);
    await user.type(screen.getByRole("combobox", { name: /address/i }), "Dallas");
    expect(await screen.findByRole("option", { name: /Dallas, TX/ })).toBeInTheDocument();
  });
});

describe("CreateProjectionPage — confirm # of households (§4, owner Decision 25)", () => {
  it("shows the resolved count as static text with a pencil edit icon (not an input)", async () => {
    const bodies: Record<string, unknown> = {};
    wireFetch(bodies);
    const user = userEvent.setup();
    render(<CreateProjectionPage />);

    await resolveAddress(user);
    await user.click(screen.getByRole("button", { name: /^next$/i })); // -> square footage
    await user.click(screen.getByRole("button", { name: /^next$/i })); // -> households

    expect(screen.getByTestId("households-confirm")).toHaveTextContent(/512,000 households/i);
    // No input on load — the pencil reveals it.
    expect(screen.queryByLabelText(/^households$/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: /edit households/i }));
    expect(screen.getByLabelText(/^households$/i)).toBeInTheDocument();
  });

  it("blocks Next until households has a value (manual fallback path)", async () => {
    const bodies: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
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

    await user.type(screen.getByRole("combobox", { name: /address/i }), "Nowhere");
    await user.click(await screen.findByRole("option", { name: /Nowhere/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^next$/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /^next$/i })); // -> square footage
    await user.click(screen.getByRole("button", { name: /^next$/i })); // -> households

    const hh = screen.getByLabelText(/^households$/i) as HTMLInputElement;
    await waitFor(() => expect(hh).toBeEnabled());
    expect(screen.getByText(/enter households manually/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^next$/i })).toBeDisabled();
    await user.type(hh, "25000");
    expect(screen.getByRole("button", { name: /^next$/i })).toBeEnabled();
  });
});

describe("CreateProjectionPage — full flow to Generate", () => {
  it("steps through all steps and POSTs the create body, landing on /p/<slug>/edit", async () => {
    const bodies: Record<string, unknown> = {};
    wireFetch(bodies);
    const user = userEvent.setup();
    render(<CreateProjectionPage />);

    // 1. Address (resolve)
    await resolveAddress(user);
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    // 2. Square footage — defaults 12,500 / 80% (sqft renders comma-grouped, QA P2).
    expect(screen.getByRole("heading", { name: /set square footage/i })).toBeInTheDocument();
    expect((screen.getByLabelText(/building size/i) as HTMLInputElement).value).toBe("12,500");
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    // 3. Confirm # of households (resolved static)
    expect(screen.getByTestId("households-confirm")).toHaveTextContent(/512,000 households/i);
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    // 4. Donor market share (shares pre-seeded; Back/Next works)
    expect(screen.getByRole("heading", { name: /set donor market share/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^back$/i }));
    expect(screen.getByTestId("households-confirm")).toHaveTextContent(/512,000 households/i);
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    // 5. Startup costs — rent pre-filled from /api/research (verified badge + sources)
    expect(screen.getByRole("heading", { name: /set startup costs/i })).toBeInTheDocument();
    await waitFor(() =>
      expect((screen.getByLabelText(/rent \(\$\/sq ft/i) as HTMLInputElement).value).toBe("18"),
    );
    expect(screen.getByTestId("rent-badge")).toHaveAttribute("data-verified", "true");

    // Generate projections — no terms checkbox (implicit acceptance), the disclaimer shows.
    expect(screen.getByTestId("terms-disclaimer")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /generate projections/i }));

    await waitFor(() => expect(window.location.pathname).toBe("/p/p_new/edit"));
    const body = bodies["/api/projections"] as {
      inputs: {
        opening_month_number: number;
        cost_schedule: unknown[];
        target_opening_date: string | null;
        rent_per_sqft: string;
        occupancy_annual: string | null;
      };
      assumptions: { utilities_per_sqft: string };
      trade_area: { households_source: string };
      terms_accepted: boolean;
    };
    expect(body.inputs.opening_month_number).toBe(1);
    expect(Array.isArray(body.inputs.cost_schedule)).toBe(true);
    expect(body.inputs.target_opening_date).toBeNull();
    // #245: occupancy is driven by sq ft × rent — the research pre-fill ($18) flows.
    expect(body.inputs.rent_per_sqft).toBe("18");
    expect(body.inputs.occupancy_annual).toBeNull();
    expect(body.assumptions.utilities_per_sqft).toBe("2.23");
    expect(body.trade_area.households_source).toBe("census_acs");
    // Terms acceptance is implicit-true so the .xlsx / packet exports stay reachable.
    expect(body.terms_accepted).toBe(true);
  });
});

describe("CreateProjectionPage — Generate lands on the editable detail (owner Decision 12)", () => {
  async function stepToLast(user: ReturnType<typeof userEvent.setup>) {
    await resolveAddress(user);
    await user.click(screen.getByRole("button", { name: /^next$/i })); // -> square footage
    await user.click(screen.getByRole("button", { name: /^next$/i })); // -> households
    await user.click(screen.getByRole("button", { name: /^next$/i })); // -> donor market
    await user.click(screen.getByRole("button", { name: /^next$/i })); // -> startup costs
  }

  it("navigates straight to /p/<slug>/edit (no in-page result view, no interstitial)", async () => {
    window.history.pushState(null, "", "/wizard");
    wireFetch({});
    const user = userEvent.setup();
    render(<CreateProjectionPage />);
    await stepToLast(user);
    await user.click(screen.getByRole("button", { name: /generate projections/i }));
    await waitFor(() => expect(window.location.pathname).toBe("/p/p_new/edit"));
    // No legacy in-page result view.
    expect(screen.queryByTestId("open-projection")).toBeNull();
    expect(screen.queryByTestId("kpi-strip")).toBeNull();
  });

  it("announces the in-progress generation via an aria-live status region (a11y #203)", () => {
    wireFetch({});
    render(<CreateProjectionPage />);
    const status = screen.getByTestId("generate-status");
    expect(status).toHaveAttribute("aria-live", "polite");
  });
});

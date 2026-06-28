import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreateProjectionPage } from "./CreateProjectionPage";
import type { ViewModel } from "../api/viewModel";

// W2 — the full-page Create-Projection wizard shell: one step at a time, a step
// indicator, validation gating Next, Generate on the final step, a subtle
// "Back to projections" link, and households empty-until-resolved (§4). NO client
// math — every figure on the result screen is the server's { display } string
// (PRD §13).

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
  it("renders the full-page title + a step indicator (no 'Start from example')", () => {
    render(<CreateProjectionPage />);
    expect(screen.getByRole("heading", { name: /create projection/i })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /create projection steps/i })).toBeInTheDocument();
    // The dead-end "Start from example" affordance was removed entirely.
    expect(screen.queryByRole("button", { name: /start from example/i })).toBeNull();
  });

  it("offers a subtle, keyboard-accessible 'Back to projections' link to the list (route '/')", async () => {
    const user = userEvent.setup();
    window.history.pushState(null, "", "/wizard");
    render(<CreateProjectionPage />);
    const back = screen.getByTestId("back-to-projections");
    expect(back).toHaveAttribute("href", "/");
    expect(back).toHaveAccessibleName(/back to projections/i);
    // A plain left-click SPA-navigates to the list route (no full reload).
    await user.click(back);
    expect(window.location.pathname).toBe("/");
    window.history.pushState(null, "", "/");
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

describe("CreateProjectionPage — disabled Next/Generate states WHY (#147)", () => {
  it("announces the blocking reason in a status region tied to the disabled button", async () => {
    const user = userEvent.setup();
    render(<CreateProjectionPage />);

    const next = screen.getByRole("button", { name: /^next$/i });
    expect(next).toBeDisabled();
    // The reason is surfaced as a status message (announced to AT), not color-only.
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/store name/i);
    expect(status).toHaveAttribute("aria-live", "polite");
    // The disabled button references the reason for assistive tech.
    expect(next).toHaveAttribute("aria-describedby", status.id);

    // Once the requirement is met, the reason clears and Next enables.
    await user.type(screen.getByLabelText(/store name/i), "House of Hope");
    expect(next).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(next).not.toHaveAttribute("aria-describedby");
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
    expect(screen.getByRole("heading", { name: /set donor shares/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^back$/i }));
    expect(screen.getByRole("heading", { name: /trade area/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    // 4. Cost schedule
    expect(screen.getByRole("heading", { name: /plan your costs/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    // 5. Review -> accept terms (explicit, #141/PRD §21) -> Generate
    expect(screen.getByRole("heading", { name: /review/i })).toBeInTheDocument();
    // Generate is gated until the operator actively accepts terms (not pre-checked).
    expect(screen.getByRole("button", { name: /generate/i })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /planning estimates/i }));
    await user.click(screen.getByRole("button", { name: /generate/i }));

    await waitFor(() => expect(screen.getByTestId("decision-banner")).toBeInTheDocument());
    const body = bodies["/api/projections"] as {
      inputs: { opening_month_number: number; cost_schedule: unknown[]; target_opening_date: string | null };
      trade_area: { households_source: string };
      terms_accepted: boolean;
    };
    expect(body.inputs.opening_month_number).toBe(1);
    expect(Array.isArray(body.inputs.cost_schedule)).toBe(true);
    expect(body.trade_area.households_source).toBe("census_acs");
    // #141: the operator's acceptance travels in the create body so the server can
    // persist terms_accepted_at and the .xlsx / packet exports are reachable.
    expect(body.terms_accepted).toBe(true);
    // result screen renders the server display string verbatim (no client math)
    const kpis = within(screen.getByTestId("kpi-strip"));
    expect(kpis.getByText("$426,911")).toBeInTheDocument();
  });
});

// The post-Generate result must offer a way INTO the full editable projection so
// the create → review → refine loop closes here (act on a "Revise"/"Find cheaper
// rent" verdict) instead of routing through Home. The link targets the owner-
// authorized edit surface (/p/<slug>/edit) and SPA-navigates (no full reload).
describe("CreateProjectionPage — open full projection link (refine loop)", () => {
  async function stepToResult(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/store name/i), "House of Hope");
    await user.type(screen.getByRole("combobox", { name: /store address/i }), "Dallas");
    await user.click(await screen.findByRole("option", { name: /Dallas, TX/ }));
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await waitFor(() =>
      expect((screen.getByLabelText(/households/i) as HTMLInputElement).value).toBe("512000"),
    );
    await user.click(screen.getByRole("button", { name: /^next$/i })); // -> donor market
    await user.click(screen.getByRole("button", { name: /^next$/i })); // -> cost schedule
    await user.click(screen.getByRole("button", { name: /^next$/i })); // -> review
    await user.click(screen.getByRole("checkbox", { name: /planning estimates/i }));
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(screen.getByTestId("decision-banner")).toBeInTheDocument());
  }

  it("links the result to the editable full projection at /p/<slug>/edit", async () => {
    window.history.pushState(null, "", "/wizard");
    wireFetch({});
    const user = userEvent.setup();
    render(<CreateProjectionPage />);
    await stepToResult(user);

    const open = screen.getByTestId("open-projection");
    // The real href is the owner-authorized edit surface (works for new tab / right-click).
    expect(open).toHaveAttribute("href", "/p/p_new/edit");
    // A plain left-click SPA-navigates (no full reload) to that route.
    await user.click(open);
    expect(window.location.pathname).toBe("/p/p_new/edit");
    window.history.pushState(null, "", "/");
  });
});

// #203 — on Generate, swapping the form for the result must NOT strand focus
// (the Generate button unmounts → focus reverts to <body>) and must announce
// completion to AT (no aria-live → a screen-reader user never hears the
// projection — the entire point of the app — was produced). WCAG 2.4.3 / 4.1.3.
describe("CreateProjectionPage — create-result focus + announce (a11y #203)", () => {
  async function stepToResult(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/store name/i), "House of Hope");
    await user.type(screen.getByRole("combobox", { name: /store address/i }), "Dallas");
    await user.click(await screen.findByRole("option", { name: /Dallas, TX/ }));
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await waitFor(() =>
      expect((screen.getByLabelText(/households/i) as HTMLInputElement).value).toBe("512000"),
    );
    await user.click(screen.getByRole("button", { name: /^next$/i })); // -> donor market
    await user.click(screen.getByRole("button", { name: /^next$/i })); // -> cost schedule
    await user.click(screen.getByRole("button", { name: /^next$/i })); // -> review
    await user.click(screen.getByRole("checkbox", { name: /planning estimates/i }));
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(screen.getByTestId("decision-banner")).toBeInTheDocument());
  }

  it("renders a result h1 and moves focus to it (no stranded focus)", async () => {
    wireFetch({});
    const user = userEvent.setup();
    render(<CreateProjectionPage />);
    await stepToResult(user);

    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent(/House of Hope/i);
    // Focus moved to the result heading (was lost to <body> before the fix).
    await waitFor(() => expect(h1).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("announces completion via an aria-live status region", async () => {
    wireFetch({});
    const user = userEvent.setup();
    render(<CreateProjectionPage />);
    await stepToResult(user);

    const status = screen.getByTestId("generate-status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent(/projection ready/i);
  });
});

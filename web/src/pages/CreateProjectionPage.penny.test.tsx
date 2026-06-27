// web/src/pages/CreateProjectionPage.penny.test.tsx — PE8 (issue #127), Spec B §5.2.
//
// Penny in the full-page /wizard, in DRAFT mode: the same left drawer, every edit
// acting on the in-memory wizard draft via POST /api/penny/draft. She can fill any
// wizard field; her edits flow back into the live wizard inputs; nothing is
// persisted until Generate, at which point the draft (incl. any Penny-built cost
// schedule WITH provenance) is sent to POST /api/projections. AI-disabled hides
// Penny (muted FAB) and every manual wizard path stays fully intact. No client math
// — Penny's returned draft is mapped onto the wizard inputs verbatim. fetch is
// mocked (no real api.anthropic.com / api.openai.com call, ever).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreateProjectionPage } from "./CreateProjectionPage";
import type { ViewModel } from "../api/viewModel";

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

/** Wire fetch: places + create answer normally; /penny/draft returns `draftReply`
 *  and records the body Penny sent; the create body is captured for assertions. */
function wireFetch(opts: { draftReply?: unknown; bodies?: Record<string, unknown> } = {}) {
  const bodies = opts.bodies ?? {};
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes("/api/places/autocomplete"))
      return jsonResponse({ predictions: [{ description: "Dallas, TX, USA", place_id: "PID_DAL" }] });
    if (url.includes("/api/places/resolve")) return jsonResponse(RESOLVED);
    if (url.includes("/api/penny/draft")) {
      bodies["/api/penny/draft"] = JSON.parse(String(init?.body));
      return jsonResponse(opts.draftReply ?? {});
    }
    bodies[url] = JSON.parse(String(init?.body));
    return jsonResponse({ ...VM, owner_token: "tok" });
  });
  return { spy, bodies };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("CreateProjectionPage — Penny mounts in the wizard (Spec §5.2)", () => {
  it("renders the enabled Penny FAB in the full-page wizard", () => {
    render(<CreateProjectionPage />);
    const fab = screen.getByTestId("penny-fab");
    expect(fab).toHaveAttribute("data-state", "ai-enabled");
    expect(fab).toHaveAccessibleName(/ask penny/i);
  });

  it("AI-disabled → Penny is hidden (muted FAB); the manual wizard is untouched", () => {
    render(<CreateProjectionPage aiOff />);
    expect(screen.getByTestId("penny-fab")).toHaveAttribute("data-state", "ai-disabled");
    // The manual wizard remains fully intact.
    expect(screen.getByRole("heading", { name: /create projection/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/store name/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start from example/i })).toBeInTheDocument();
  });
});

describe("CreateProjectionPage — a Penny draft edit flows into the wizard field", () => {
  it("Penny sets the store name on the draft; the wizard's name input updates", async () => {
    wireFetch({
      draftReply: {
        draft: { name: "House of Hope" },
        narration: "I named the store House of Hope.",
        provider: "anthropic",
        applied: [
          { tool: "set_input", version: null, actor: "penny", changed: [{ field: "name", was: "", now: "House of Hope" }] },
        ],
      },
    });
    const user = userEvent.setup();
    render(<CreateProjectionPage />);

    await user.click(screen.getByRole("button", { name: /ask penny/i }));
    await user.type(screen.getByRole("textbox", { name: /ask penny/i }), "Name my store House of Hope");
    await user.keyboard("{Enter}");

    // The mutated draft flows back into the LIVE wizard input (no client math).
    // Query by the textbox role so the FieldChange undo's aria-label ("Undo change
    // to Store name…") doesn't collide with the store-name field.
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: /store name/i }) as HTMLInputElement).value).toBe(
        "House of Hope",
      ),
    );
    // She narrated the edit, and it's per-field undoable (FieldChange).
    expect(screen.getByText(/named the store house of hope/i)).toBeInTheDocument();
    expect(screen.getByTestId("field-change-undo")).toBeInTheDocument();
  });

  it("the /penny/draft body carries the current in-memory draft_state (not a projection)", async () => {
    const { bodies } = wireFetch({
      draftReply: { draft: {}, narration: "ok", provider: "anthropic", applied: [] },
    });
    const user = userEvent.setup();
    render(<CreateProjectionPage />);
    await user.type(screen.getByLabelText(/store name/i), "Seed Co");

    await user.click(screen.getByRole("button", { name: /ask penny/i }));
    await user.type(screen.getByRole("textbox", { name: /ask penny/i }), "What should my shares be?");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(bodies["/api/penny/draft"]).toBeDefined());
    const body = bodies["/api/penny/draft"] as { draft_state: { name: string; assumptions: Record<string, string> } };
    expect(body.draft_state.name).toBe("Seed Co");
    expect(body.draft_state.assumptions.share_y1).toBe("6"); // the seeded wizard default
  });
});

describe("CreateProjectionPage — Generate persists a Penny-built schedule with provenance", () => {
  it("a cost schedule Penny built (with provenance) is sent to POST /api/projections on Generate", async () => {
    const pennyRows = [
      { category: "Thrift Store Consultant", month: 1, amount: 100000, provenance: { source: "ai", turn_id: "t1" } },
      { category: "Build-out", month: 3, amount: 50000, provenance: { source: "ai", turn_id: "t1" } },
    ];
    const { bodies } = wireFetch({
      draftReply: {
        draft: { cost_schedule: pennyRows },
        narration: "I built your cost schedule from the proposal.",
        provider: "anthropic",
        applied: [{ tool: "edit_cost_schedule", version: null, actor: "penny", changed: [] }],
      },
    });
    const user = userEvent.setup();
    render(<CreateProjectionPage />);

    // 1. Store — name + resolve an address (households come from Census).
    await user.type(screen.getByLabelText(/store name/i), "House of Hope");
    await user.type(screen.getByRole("combobox", { name: /store address/i }), "Dallas");
    await user.click(await screen.findByRole("option", { name: /Dallas, TX/ }));

    // Penny builds the cost schedule on the draft.
    await user.click(screen.getByRole("button", { name: /ask penny/i }));
    await user.type(screen.getByRole("textbox", { name: /ask penny/i }), "Build my cost schedule");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(bodies["/api/penny/draft"]).toBeDefined());
    // close Penny so the wizard's Next buttons aren't under the modal scrim
    await user.click(screen.getByRole("button", { name: /close penny/i }));

    // 2. → Trade area (households resolved)
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await waitFor(() => expect((screen.getByLabelText(/households/i) as HTMLInputElement).value).toBe("512000"));
    // 3. → Donor market, 4. → Cost, 5. → Review
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByRole("heading", { name: /review/i })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /planning estimates/i }));
    await user.click(screen.getByRole("button", { name: /generate/i }));

    await waitFor(() => expect(bodies["/api/projections"]).toBeDefined());
    const created = bodies["/api/projections"] as {
      inputs: { cost_schedule: Array<{ category: string; month: number; amount: number; provenance?: { source: string } }> };
    };
    const built = created.inputs.cost_schedule.find((r) => r.category === "Build-out");
    expect(built).toBeDefined();
    expect(built?.provenance?.source).toBe("ai");
  });
});

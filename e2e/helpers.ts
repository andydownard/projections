// e2e/helpers.ts — shared E2E helpers (NOT a spec; testMatch is **/*.spec.ts).
//
// The shipped /wizard is the 5-step Create-Projection wizard (CreateProjectionPage).
// Its trade-area households field is empty + DISABLED until an address resolves
// through the server's Google Places + Census proxy (/api/places/*). In CI those
// keys are unset, so that proxy legitimately returns no predictions and the field
// never unlocks. We stub ONLY that external-API proxy here — exactly the upstream
// you would never call from CI — so the wizard UI is drivable. Everything that
// matters to the regression (the create POST, the engine compute, the Appendix-D
// view-model render, and the .xlsx export) still hits the REAL booted backend.
import { expect, type Page } from "@playwright/test";

// A deterministic Places->Census resolve for the seeded design-parity trade area
// (House of Hope / Longview, TX — 31,798 households). Shape mirrors
// api/places.ts `TradeAreaResolved` (the fields useWizardState + the create body
// actually read).
const RESOLVED_TRADE_AREA = {
  location: {
    place_id: "test-place-1",
    lat: 32.5007,
    lng: -94.7405,
    formatted_address: "Longview, TX, USA",
  },
  trade_area: {
    basis: "city",
    households: 31798,
    geography_name: "Longview city",
    geography_fips: "4843012",
    acs_vintage: "2022",
    households_source: "census_acs",
    moe: 412,
    alternatives: {
      city: { geography_name: "Longview city", fips: "4843012", households: 31798, moe: 412 },
      county: { geography_name: "Gregg County", fips: "48183", households: 48000, moe: 600 },
    },
  },
  evidence: {
    field: "households",
    label: "Trade-area households",
    value: 31798,
    method: "census_acs",
    source: "U.S. Census ACS",
    source_date: "2022",
    confidence: "high",
    geography: "Longview city",
  },
};

const PREDICTIONS = {
  predictions: [{ description: "123 Main St, Longview, TX, USA", place_id: "test-place-1" }],
};

// A deterministic rent-research result (#245). CI has no AI key, so the server
// already returns the labeled $12 benchmark — this stub just makes the Space & rent
// step's pre-fill deterministic and instant regardless of provider config.
const RESEARCH_BENCHMARK = {
  rent_per_sqft: 12.0, estimate: 12.0, low: 8.0, high: 16.0,
  rent_type: "nnn", opex: 3.0, basis: "$/sq ft/yr",
  confidence: "low", verified: false, provenance: "estimated",
  sources: [], ai_enabled: false, cached: false,
};

/** Stub the server-proxied Places + Census endpoints (CI has no Google/Census key). */
export async function mockPlaces(page: Page): Promise<void> {
  await page.route("**/api/places/autocomplete", (route) =>
    route.fulfill({ json: PREDICTIONS }),
  );
  await page.route("**/api/places/resolve", (route) =>
    route.fulfill({ json: RESOLVED_TRADE_AREA }),
  );
  // The Space & rent step (#245) pre-fills rent from POST /api/research.
  await page.route("**/api/research", (route) =>
    route.fulfill({ json: RESEARCH_BENCHMARK }),
  );
}

/**
 * Drive the shipped 5-step wizard to Generate a FRESH projection (not the seeded
 * `example`). The revised order (owner Decision 11) is Address → Square footage →
 * Households → Donor market share → Startup costs, with "Generate projections" on the
 * last step landing DIRECTLY on /p/<slug>/edit. Returns once that click is issued.
 * Requires `mockPlaces(page)` to have been called first.
 */
export async function createProjectionViaWizard(
  page: Page,
  storeName = "Wizard E2E Store",
): Promise<void> {
  await page.goto("/wizard");

  // Step 1 — Address: resolve an address (the resolve fills households). The store
  // name is OPTIONAL and sits beneath the address; we set it for a recognisable label.
  await page.getByRole("combobox", { name: "Address" }).fill("123 Main St");
  await page.getByRole("option").first().click();
  await page.getByLabel("Store name (optional)").fill(storeName);
  await page.getByRole("button", { name: "Next" }).click();

  // Step 2 — Square footage: defaults 12,500 sq ft / 80% sales floor pass straight
  // through (the building-size assertion is the resolve synchronisation point). The
  // field renders comma-grouped for display consistency (QA P2).
  await expect(page.getByLabel(/building size/i)).toHaveValue("12,500");
  await page.getByRole("button", { name: "Next" }).click();

  // Step 3 — Confirm # of households: the resolved count renders as static text.
  await expect(page.getByTestId("households-confirm")).toContainText("31,798 households");
  await page.getByRole("button", { name: "Next" }).click();

  // Step 4 — Donor market share: three explicit shares are pre-filled (6/8/10).
  await page.getByRole("button", { name: "Next" }).click();

  // Step 5 — Startup costs: rent pre-fills from the (stubbed) research benchmark and
  // the seeded cost rows render in the ROWS × MONTHS grid (Epic D #263). The server
  // preview (POST /api/cost-schedule/preview) totals the grid — the grand total comes
  // back as a server display string (no client math) — and a draggable "grand opening"
  // marker sets the opening month. Terms acceptance is IMPLICIT on Generate (owner
  // Decision 5) — no checkbox; the disclaimer shows and the server stamps
  // EXPORT_DISCLAIMER so the .xlsx export stays a 200 (not 403).
  await expect(page.getByTestId("cost-schedule-editor")).toBeVisible();
  await expect(page.getByTestId("grand-opening-handle")).toBeVisible();
  await expect(page.getByTestId("cost-grand-total")).toContainText("$");
  await page.getByRole("button", { name: "Generate projections" }).click();
}

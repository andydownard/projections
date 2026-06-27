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

/** Stub the server-proxied Places + Census endpoints (CI has no Google/Census key). */
export async function mockPlaces(page: Page): Promise<void> {
  await page.route("**/api/places/autocomplete", (route) =>
    route.fulfill({ json: PREDICTIONS }),
  );
  await page.route("**/api/places/resolve", (route) =>
    route.fulfill({ json: RESOLVED_TRADE_AREA }),
  );
}

/**
 * Drive the shipped 5-step wizard to Generate a FRESH projection (not the seeded
 * `example`). Returns when the server view-model has rendered the result.
 * Requires `mockPlaces(page)` to have been called first.
 */
export async function createProjectionViaWizard(
  page: Page,
  storeName = "Wizard E2E Store",
): Promise<void> {
  await page.goto("/wizard");

  // Step 1 — Store: name + resolve an address (the resolve fills households).
  await page.getByLabel("Store name", { exact: true }).fill(storeName);
  await page.getByRole("combobox", { name: "Store address" }).fill("123 Main St");
  await page.getByRole("option").first().click();
  await page.getByRole("button", { name: "Next" }).click();

  // Step 2 — Trade area: households filled from the (stubbed) Census resolve. This
  // assertion is the real synchronisation point — it waits for the resolve to land.
  await expect(page.getByLabel("Households (trade area)")).toHaveValue("31798");
  await page.getByRole("button", { name: "Next" }).click();

  // Step 3 — Donor market: three explicit shares are pre-filled (6/8/10).
  await page.getByRole("button", { name: "Next" }).click();

  // Step 4 — Cost schedule: the default month-1 lump rows are valid.
  await page.getByRole("button", { name: "Next" }).click();

  // Step 5 — Review: terms is an EXPLICIT, active accept (#141 / PRD §21) that
  // gates Generate; the seeded `example` predates this, so a fresh create is the
  // only path that exercises terms_accepted -> a 200 (not 403) .xlsx export.
  await page.getByRole("checkbox", { name: /planning estimates/i }).check();
  await page.getByRole("button", { name: "Generate" }).click();
}

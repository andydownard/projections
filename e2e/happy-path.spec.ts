import { expect, test } from "@playwright/test";

import { createProjectionViaWizard, mockPlaces } from "./helpers";

// E2E flow 1 — the "M2 IS the product" happy path (QA-7 / BUILD_PLAN M2, #58):
// wizard -> Generate -> the SERVER decision banner + milestones + monthly cash-flow
// -> export a real .xlsx (the #141 regression) -> reopen by view_slug (identical
// server numbers, no client math).
//
// This runs for real against the booted app (FastAPI + engine + Vite). It is NOT
// gated behind a per-spec env flag any more (#198): the M2/M6 UI shipped, so the
// gate runs every time and actually asserts the create->decision->export contract.
// The only thing stubbed is the external Google Places + Census proxy (CI has no
// key) — every projection number, and the .xlsx, comes from the real backend.
test.describe("happy path: create -> decision -> milestones -> export -> reopen", () => {
  test("app shell renders and the page is no-indexed", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByText("Store Projections")).toBeVisible();
    // No-index is a real assertion (the shared shell ships robots: noindex).
    await expect(page).toHaveTitle(/Thrift Store Projection/i);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/i);
  });

  test("wizard generates a fresh projection: decision banner + milestones + .xlsx", async ({
    page,
  }) => {
    await mockPlaces(page);
    await createProjectionViaWizard(page, "Happy Path Store");

    // "Generate projections" lands DIRECTLY on the editable detail page (owner
    // Decision 12) — no in-wizard result view, no "projection ready" interstitial.
    await expect(page).toHaveURL(/\/p\/.+\/edit/);

    // The decision artifact ships together (PRD §12): a verdict banner + the
    // decision metric tiles, all rendered from the server view-model. The owner
    // detail page intentionally drops the first-year cash-gap tile (owner Decision 2
    // / Epic G) — `metrics.cashGap` stays in computed_json but is not tiled here.
    await expect(page.getByTestId("decision-banner")).toBeVisible();
    await expect(page.getByTestId("metric-capital")).toBeVisible();
    await expect(page.getByTestId("metric-breakeven")).toBeVisible();
    // The milestone tile (issue #117) — present only when the server emits the
    // milestones block, so it proves milestones rendered, not a legacy snapshot.
    await expect(page.getByTestId("metric-payback")).toBeVisible();

    // The monthly cash-flow chart renders on the default Projection tab.
    await expect(page.getByTestId("cashflow-chart")).toBeVisible();
    // Server KPIs moved into the KPIs tab (Epic G / Decision G3) — switch to it,
    // then the revenue KPI renders from `computed_json`.
    await page.getByRole("tab", { name: "KPIs" }).click();
    await expect(page.getByTestId("kpi-revenue")).toBeVisible();

    // #141 regression: exports 403'd for EVERY freshly-created projection because
    // the wizard's terms_accepted:true was dropped server-side. This drives a FRESH
    // projection (not the seeded `example`, which already has terms_accepted_at) all
    // the way to a real .xlsx download — a 403 surfaces as a JSON blob and never a
    // download event, so waitForEvent("download") firing is the proof of the fix.
    // D9: the .xlsx download moved to the header next to the name and reads "Excel"
    // (testid download-xlsx) — a role=button anchor with href + download.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("download-xlsx").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  });

  test("reopen by view_slug shows identical server numbers (no client math)", async ({ page }) => {
    // Open the seeded `example` projection directly at its view_slug route.
    await page.goto("/p/example");
    await expect(page).toHaveURL(/\/p\/example/);

    const revenue = page.getByTestId("kpi-revenue");
    await expect(revenue).toBeVisible();
    const before = ((await revenue.innerText()).match(/\$[\d,]+/) ?? ["$0"])[0];
    expect(before).toMatch(/^\$[\d,]+$/);

    const url = page.url();
    await page.goto(url); // reopen by view_slug
    await expect(page.getByTestId("kpi-revenue")).toContainText(before);
  });
});

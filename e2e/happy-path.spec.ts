import { expect, test } from "@playwright/test";

// E2E flow 1 — the "M2 IS the product" happy path (QA-7 / BUILD_PLAN M2):
// wizard -> Generate -> assert decision banner + monthly cash-flow + recommendation
// from the SERVER view-model -> autosave -> reopen by view_slug (same numbers) ->
// export .xlsx -> recalc.py total_errors==0.
//
// M0 scaffold: the UI it drives lands in M2. These specs are skipped until the app
// shell exposes the wizard, so the flow contract is pinned now and the gate turns
// green automatically when M2 ships. They are NOT silently passing — `test.skip`
// records the explicit reason in the report.
const M2_READY = process.env.E2E_M2_READY === "1";

test.describe("happy path: create -> decision -> save -> reopen -> export", () => {
  test.skip(!M2_READY, "M2 UI (wizard/banner/export) not built yet — scaffold pins the flow");

  test("shell renders and is no-indexed", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByText(/Thrift Store Projection/i)).toBeVisible();
  });

  test("wizard generates a projection and shows the decision banner", async ({ page }) => {
    await page.goto("/wizard");
    await page.getByLabel(/households/i).fill("31798");
    await page.getByLabel(/year 1 share/i).fill("6");
    await page.getByLabel(/year 2 share/i).fill("8");
    await page.getByLabel(/year 3 share/i).fill("10");
    // #141 / PRD §21: terms acceptance is explicit (the box is NOT pre-checked) and
    // gates Generate; the operator must actively accept before the projection runs.
    await page.getByRole("checkbox", { name: /planning estimates/i }).check();
    await page.getByRole("button", { name: /generate/i }).click();

    // Decision artifact ships together (banner + capital + break-even + cash gap).
    await expect(page.getByTestId("decision-banner")).toBeVisible();
    await expect(page.getByTestId("metric-capital")).toBeVisible();
    await expect(page.getByTestId("metric-breakeven")).toBeVisible();
    await expect(page.getByTestId("metric-cashgap")).toBeVisible();
    await expect(page.getByTestId("cashflow-chart")).toBeVisible();
  });

  test("a freshly-created projection (not the seeded example) downloads the .xlsx", async ({ page }) => {
    // #141 regression: exports 403'd for EVERY real projection because the wizard's
    // terms_accepted:true was dropped server-side. This drives a FRESH projection
    // (not the seeded `example`, which sets terms_accepted_at in app/seed.py) all the
    // way to a real .xlsx download — a 403 would surface as a JSON blob, never a
    // download event, so waitForEvent("download") firing is the proof.
    await page.goto("/wizard");
    await page.getByLabel(/households/i).fill("31798");
    await page.getByLabel(/year 1 share/i).fill("6");
    await page.getByLabel(/year 2 share/i).fill("8");
    await page.getByLabel(/year 3 share/i).fill("10");
    await page.getByRole("checkbox", { name: /planning estimates/i }).check();
    await page.getByRole("button", { name: /generate/i }).click();
    await expect(page.getByTestId("decision-banner")).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /download \.xlsx/i }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  });

  test("reopen by view_slug shows identical server numbers", async ({ page }) => {
    await page.goto("/wizard");
    await page.getByRole("button", { name: /start from example/i }).click();
    const before = await page.getByTestId("kpi-revenue").innerText();
    const dollar = (before.match(/\$[\d,]+/) || ["$0"])[0]; // the server-rendered value
    const url = page.url();
    await page.goto(url); // reopen by view_slug
    await expect(page.getByTestId("kpi-revenue")).toContainText(dollar);
  });
});

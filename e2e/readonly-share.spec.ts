import { expect, test } from "@playwright/test";

// E2E flow 3 — read-only share link (view_slug) cannot edit (DoD Tier-2 / rule 6).
// The read view renders the decision verbatim (role views travel the verdict, not a
// reduced summary — M5-G3) but every editable affordance is absent/disabled.
//
// #198: no longer gated behind an env flag CI never sets — the M2 read view + the
// M5 role link shipped, so this runs for real against the booted app.
test.describe("read-only share link", () => {
  test("view_slug renders the decision but offers no edit controls", async ({ page }) => {
    await page.goto("/p/example"); // view_slug path, no edit fragment
    await expect(page.getByTestId("decision-banner")).toBeVisible();
    // No editable cells in read-only mode: the Settings tab + labour control only
    // exist in /edit mode.
    await expect(page.getByTestId("settings-tab")).toHaveCount(0);
    await expect(page.getByLabel(/labor %/i)).toHaveCount(0);
  });

  test("a read-only user may still export (export is a business-model toggle)", async ({ page }) => {
    await page.goto("/p/example");
    // D9: the .xlsx download lives in the header (reads "Excel", testid download-xlsx)
    // and is present in the read-only view too (export is a business-model toggle).
    await expect(page.getByTestId("download-xlsx")).toBeVisible();
  });

  test("role view renders the identical banner verdict", async ({ page }) => {
    await page.goto("/r/board-slug");
    await expect(page.getByTestId("decision-banner")).toBeVisible();
    await expect(page.getByTestId("metric-capital")).toBeVisible();
  });
});

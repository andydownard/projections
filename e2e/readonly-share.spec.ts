import { expect, test } from "@playwright/test";

// E2E flow 3 — read-only share link (view_slug) cannot edit (DoD Tier-2 / rule 6).
// The read view renders the decision verbatim (role views travel the verdict, not a
// reduced summary — M5-G3) but every editable affordance is absent/disabled.
const M2_READY = process.env.E2E_M2_READY === "1";

test.describe("read-only share link", () => {
  test.skip(!M2_READY, "M2 read view / M4 role links not built yet — scaffold pins the flow");

  test("view_slug renders the decision but offers no edit controls", async ({ page }) => {
    await page.goto("/p/example"); // view_slug path, no edit fragment
    await expect(page.getByTestId("decision-banner")).toBeVisible();
    // No editable cells in read-only mode.
    await expect(page.getByTestId("settings-tab")).toHaveCount(0);
    await expect(page.getByLabel(/labor %/i)).toHaveCount(0);
  });

  test("a read-only user may still export (export is a business-model toggle)", async ({ page }) => {
    await page.goto("/p/example");
    await expect(page.getByRole("button", { name: /download \.xlsx/i })).toBeVisible();
  });

  test("role view renders the identical banner verdict", async ({ page }) => {
    await page.goto("/r/board-slug");
    await expect(page.getByTestId("decision-banner")).toBeVisible();
    await expect(page.getByTestId("metric-capital")).toBeVisible();
  });
});

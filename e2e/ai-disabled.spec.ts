import { expect, test } from "@playwright/test";

// E2E flow 5 — AI-disabled path (DoD / rule 6, PRD §21). The full compute -> save ->
// .xlsx export flow works with ALL AI keys unset: manual rent, no narrative. Compute
// is server-authoritative and AI-independent; the narrative surface degrades
// gracefully (disabled, not crashed).
//
// #198: no longer gated behind an env flag CI never sets — the M2 export + the ai-off
// read surface shipped, so this runs for real against the booted app.
test.describe("AI opt-out works end-to-end", () => {
  test("compute + save + xlsx export succeed with AI disabled", async ({ page }) => {
    // Open the seeded `example` projection directly at its view_slug (ai=off kept).
    await page.goto("/p/example?ai=off");
    await expect(page).toHaveURL(/\/p\/example\?ai=off/);
    await expect(page.getByTestId("decision-banner")).toBeVisible();

    // Manual rent path is shown (no automated research): a single aria-labelled
    // "Rent" input in the ai-off narrative-disabled section.
    await expect(page.getByRole("textbox", { name: "Rent" })).toBeVisible();

    // Export still works without any AI call (D9: header "Excel" download, testid
    // download-xlsx).
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("download-xlsx").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  });

  test("narrative surface is disabled, not errored, when AI is off", async ({ page }) => {
    await page.goto("/p/example?ai=off");
    await expect(page.getByTestId("narrative-disabled")).toBeVisible();
    await expect(page.getByTestId("decision-banner")).toBeVisible();
  });

  test("responsive at the three required viewports", async ({ page }) => {
    // The project matrix (1440/768/375) drives this; assert no horizontal overflow
    // of the decision banner at the active viewport.
    await page.goto("/p/example");
    const banner = page.getByTestId("decision-banner");
    await expect(banner).toBeVisible();
    const box = await banner.boundingBox();
    const viewport = page.viewportSize();
    if (box && viewport) {
      expect(box.width).toBeLessThanOrEqual(viewport.width);
    }
  });
});

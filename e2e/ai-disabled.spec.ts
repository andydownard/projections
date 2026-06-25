import { expect, test } from "@playwright/test";

// E2E flow 5 — AI-disabled path (DoD / rule 6, PRD §21). The full create -> compute
// -> save -> .xlsx export flow works with ALL AI keys unset: manual rent, no
// narrative. Compute is server-authoritative and AI-independent. The narrative
// surface degrades gracefully (disabled, not crashed).
const AI_DISABLED_READY = process.env.E2E_AI_DISABLED_READY === "1";

test.describe("AI opt-out works end-to-end", () => {
  test.skip(!AI_DISABLED_READY, "M2 export + M3/M5 AI surfaces not built yet — scaffold pins the flow");

  test("compute + save + xlsx export succeed with AI disabled", async ({ page }) => {
    await page.goto("/wizard?ai=off");
    await page.getByRole("button", { name: /start from example/i }).click();
    await expect(page.getByTestId("decision-banner")).toBeVisible();

    // Manual rent path is shown (no automated research). Target the manual rent
    // INPUT specifically (the 3-year table also has "Rent, Year N" cells).
    await expect(page.getByRole("textbox", { name: "Rent" })).toBeVisible();

    // Export still works without any AI call.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /download \.xlsx/i }).click(),
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

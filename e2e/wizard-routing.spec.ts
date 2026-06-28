import { expect, test } from "@playwright/test";

import { mockPlaces } from "./helpers";

// E2E — Epic B (#261), page-per-step router FOUNDATION. Each wizard step is its
// OWN route (/wizard/<step-slug>), so the browser Back/Forward buttons navigate
// between steps, every step is deep-linkable/refreshable, and the in-progress
// draft survives navigation (the wizard layout never unmounts on a /wizard route).
// FOUNDATION ONLY: today's step set + labels are unchanged — only the routing is
// added. The external Places/Census proxy is stubbed (CI has no key); the routing
// itself is the real booted app.
test.describe("wizard page-per-step routing: deep-link + browser back/forward (#261)", () => {
  test("bare /wizard canonicalizes to the first step's route", async ({ page }) => {
    await mockPlaces(page);
    await page.goto("/wizard");
    // The bare /wizard is replaced with the first step's slug so every step has a
    // real, deep-linkable URL (the invalid/bare-slug guard, no junk history entry).
    await expect(page).toHaveURL(/\/wizard\/store$/);
    await expect(page.getByLabel("Store name", { exact: true })).toBeVisible();
  });

  test("a wizard step is deep-linkable straight by its URL", async ({ page }) => {
    await mockPlaces(page);
    // Land directly on the Space & rent step by slug — its own field renders, not
    // the first step (the cursor starts on the deep-linked step, no flicker).
    await page.goto("/wizard/space");
    await expect(page).toHaveURL(/\/wizard\/space$/);
    await expect(page.getByLabel(/building size/i)).toBeVisible();
  });

  test("Next pushes a per-step route; browser Back/Forward navigate steps and keep the draft", async ({
    page,
  }) => {
    await mockPlaces(page);
    await page.goto("/wizard");
    await expect(page).toHaveURL(/\/wizard\/store$/);

    // Type the store name, then advance: Next pushes a NEW /wizard/<slug> entry.
    await page.getByLabel("Store name", { exact: true }).fill("Routing Store");
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page).toHaveURL(/\/wizard\/trade-area$/);
    await expect(page.getByRole("heading", { name: /trade area/i })).toBeVisible();

    // Browser BACK returns to the store step — and the typed name is still there
    // (the draft is preserved across the route change; no lost inputs).
    await page.goBack();
    await expect(page).toHaveURL(/\/wizard\/store$/);
    await expect(page.getByLabel("Store name", { exact: true })).toHaveValue("Routing Store");

    // Browser FORWARD returns to the trade-area step.
    await page.goForward();
    await expect(page).toHaveURL(/\/wizard\/trade-area$/);
    await expect(page.getByRole("heading", { name: /trade area/i })).toBeVisible();
  });
});

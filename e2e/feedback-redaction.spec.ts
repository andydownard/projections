import { expect, test } from "@playwright/test";

// E2E flow 4 — feedback files a redacted issue, no projection data (DoD / rule 6,
// SECURITY.md §9, the product's #1 data-leak risk). The success UI shows only a
// random support_id; the outbound payload carries NO view_slug / token / financial
// field. The server-side redaction is also a non-regressable CI unit test (M6.1/QA-8);
// this E2E proves the UX surfaces only the support_id.
const M6_READY = process.env.E2E_M6_READY === "1";

test.describe("feedback redaction", () => {
  test.skip(!M6_READY, "M6 feedback modal not built yet — scaffold pins the flow");

  test("submitting feedback shows a support_id and no projection link", async ({ page }) => {
    await page.goto("/p/example/edit#edit-secret");
    await page.getByRole("button", { name: /feedback/i }).click();
    await page.getByLabel(/title/i).fill("Break-even marker off by one");
    await page.getByLabel(/description/i).fill("Banner says month 5 but chart marks 6.");
    await page.getByRole("button", { name: /send/i }).click();

    const success = page.getByTestId("feedback-success");
    await expect(success).toBeVisible();
    await expect(success).toContainText(/SUP-/);
    // The success surface must NOT leak a resolvable projection link.
    await expect(success).not.toContainText("/p/");
    await expect(success).not.toContainText("view_slug");
  });

  test("the modal warns against pasting financial details", async ({ page }) => {
    await page.goto("/p/example/edit#edit-secret");
    await page.getByRole("button", { name: /feedback/i }).click();
    await expect(page.getByText(/don.t (include|paste) sensitive financial/i)).toBeVisible();
  });
});

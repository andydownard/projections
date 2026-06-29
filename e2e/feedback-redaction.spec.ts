import { expect, test } from "@playwright/test";

// E2E flow 4 — feedback files a redacted issue, no projection data (DoD / rule 6,
// SECURITY.md §9, the product's #1 data-leak risk). The success UI shows only a
// random support_id; the outbound payload carries NO view_slug / token / financial
// field. Server-side redaction is also a non-regressable CI unit test (M6.1/QA-8);
// this E2E proves the UX surfaces only the support_id.
//
// #198: no longer gated behind an env flag CI never sets — the M6 feedback modal
// shipped (the always-present "idea fab" in the shared top bar), so this runs for
// real against the booted app.
test.describe("feedback redaction", () => {
  test("submitting an idea shows a support_id and no projection link", async ({ page }) => {
    await page.goto("/p/example");
    // The idea-fab in the shared top bar opens the FeedbackModal on every route.
    await page.getByTestId("idea-fab").click();
    // An idea is just a description — no title field on this form.
    await page.getByLabel(/description/i).fill("Banner says month 5 but chart marks 6.");
    // Exact "Send" so we don't also match the "App suggestion" idea-fab trigger.
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const success = page.getByTestId("feedback-success");
    await expect(success).toBeVisible();
    await expect(success).toContainText(/SUP-/);
    // The success surface must NOT leak a resolvable projection link.
    await expect(success).not.toContainText("/p/");
    await expect(success).not.toContainText("view_slug");
  });

  test("the idea form is a simple suggestion (no title, no warning)", async ({ page }) => {
    await page.goto("/p/example");
    await page.getByTestId("idea-fab").click();
    const dialog = page.getByRole("dialog", { name: /share an idea/i });
    await expect(dialog.getByLabel(/description/i)).toBeVisible();
    // No title field and no financial-warning copy — redaction is server-enforced.
    await expect(dialog.getByLabel("Title")).toHaveCount(0);
    await expect(dialog.getByText(/sensitive financial/i)).toHaveCount(0);
  });
});

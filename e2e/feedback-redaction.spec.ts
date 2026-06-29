import { expect, test } from "@playwright/test";

// E2E flow 4 — feedback files a redacted issue, no projection data (DoD / rule 6,
// SECURITY.md §9, the product's #1 data-leak risk). The outbound payload carries NO
// view_slug / token / financial field; server-side redaction is also a non-regressable
// CI unit test (M6.1/QA-8). This E2E proves the UX surfaces only a safe, non-resolvable
// success signal.
//
// v2 redesign (FeedbackModal.tsx, Toast.tsx): the app-suggestion (idea) path was
// rewritten — one "Your suggestion" textarea, no title, no email. On success it CLOSES
// the modal and shows a polite TOAST ("Thanks! Your suggestion makes the app better.")
// and NEVER renders a support_id (the SUP- id surface is the bug path only). Regression
// #7 invariant re-expressed against the toast: NO SUP- id, NO /p/ link, NO view_slug.
//
// #198: no longer gated behind an env flag CI never sets — the M6 feedback modal
// shipped (the always-present "idea fab" in the shared top bar), so this runs for
// real against the booted app.
test.describe("feedback redaction", () => {
  test("submitting an idea shows a toast and never a support_id or projection link", async ({
    page,
  }) => {
    await page.goto("/p/example");
    // The idea-fab in the shared top bar opens the FeedbackModal (idea mode) on every route.
    await page.getByTestId("idea-fab").click();
    // An idea is just a description in one "Your suggestion" textarea — no title/email.
    await page.getByLabel("Your suggestion").fill("Banner says month 5 but chart marks 6.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // AS4: success CLOSES the modal and shows a polite toast — the support_id is NEVER
    // shown for an idea (Regression #7, the product's #1 data-leak risk).
    const toast = page.getByTestId("toast");
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute("role", "status");
    await expect(toast).toContainText("Thanks! Your suggestion makes the app better.");
    // The redaction invariant, re-expressed against the toast + the closed modal: no
    // SUP- support id surface, no resolvable projection link, no view_slug — anywhere.
    await expect(page.getByTestId("feedback-modal")).toHaveCount(0);
    await expect(page.getByTestId("feedback-success")).toHaveCount(0);
    await expect(toast).not.toContainText("SUP-");
    await expect(toast).not.toContainText("/p/");
    await expect(toast).not.toContainText("view_slug");
  });

  test("the idea form is a simple App suggestion (no title, no email, no warning)", async ({
    page,
  }) => {
    await page.goto("/p/example");
    await page.getByTestId("idea-fab").click();
    // AS1: the idea dialog is titled "App suggestion" (role=dialog via aria-labelledby).
    const dialog = page.getByRole("dialog", { name: /app suggestion/i });
    await expect(dialog.getByLabel("Your suggestion")).toBeVisible();
    // No title field, no email field, and no financial-warning copy — redaction is
    // server-enforced; the idea path collects only a description.
    await expect(dialog.getByLabel("Title")).toHaveCount(0);
    await expect(dialog.getByLabel(/email/i)).toHaveCount(0);
    await expect(dialog.getByText(/sensitive financial/i)).toHaveCount(0);
  });
});

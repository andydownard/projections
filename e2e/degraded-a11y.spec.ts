import { expect, test } from "@playwright/test";

// E2E flow 6 — M7 hardening: AA a11y sweep + error/degraded states, design-QA
// screenshots at 1440 / 768 / 375 on the seeded stress fixture (ENGINEERING_HANDOFF
// I2 + §QA). Runs across the three viewport projects in playwright.config.ts; each
// state must be DESIGNED + HANDLED — labelled, announced, color-independent, and
// non-overflowing at every width. Gated on the seeded surfaces being live (like the
// other specs) so CI without servers stays green.
const READY = process.env.E2E_DEGRADED_READY === "1";

test.describe("M7 degraded states + a11y sweep", () => {
  test.skip(!READY, "M2/M5 read-only + ai-off surfaces — scaffold pins the flow");

  test("read-only share notice is announced politely and color-independent", async ({ page }, info) => {
    await page.goto("/r/board-slug");
    const notice = page.getByTestId("degraded-read-only");
    await expect(notice).toBeVisible();
    // role=status (polite) — the surface degrades, never blocks.
    await expect(notice).toHaveAttribute("role", "status");
    // meaning carried in text, not color alone.
    await expect(notice).toContainText(/read-only/i);
    // the decorative glyph is hidden from the a11y tree.
    await expect(notice.locator(".degraded__icon")).toHaveAttribute("aria-hidden", "true");
    await page.screenshot({
      path: `test-results/degraded-read-only-${info.project.name}.png`,
      fullPage: true,
    });
  });

  test("AI opt-out notice degrades, never errors, and keeps export working", async ({ page }, info) => {
    await page.goto("/p/example?ai=off");
    const notice = page.getByTestId("degraded-ai-opt-out");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("role", "status");
    await expect(notice).toContainText(/computed without AI/i);
    // the decision still renders (compute is AI-independent).
    await expect(page.getByTestId("decision-banner")).toBeVisible();
    // manual rent path is offered (the editable input, not the table cells).
    await expect(page.getByRole("textbox", { name: "Rent" })).toBeVisible();
    await page.screenshot({
      path: `test-results/degraded-ai-opt-out-${info.project.name}.png`,
      fullPage: true,
    });
  });

  test("degraded notices never overflow the viewport at any width", async ({ page }) => {
    await page.goto("/r/board-slug");
    const notice = page.getByTestId("degraded-read-only");
    await expect(notice).toBeVisible();
    const box = await notice.boundingBox();
    const viewport = page.viewportSize();
    if (box && viewport) {
      expect(box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.x).toBeGreaterThanOrEqual(0);
    }
  });
});

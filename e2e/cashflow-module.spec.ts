import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

// E2E — the redesigned "Cash flow" module (spec 2026-07-04): the dual-axis chart
// + year-grouped expand/collapse monthly table + CSV export, driven against the
// REAL booted app on the seeded `example` projection (full 60-month series, terms
// already accepted at seed). Runs at 1440 / 768 / 375 (the three Playwright
// projects) and archives a module screenshot per viewport as design evidence.
const here = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(here, "..", "docs", "plans", "assets", "2026-07-04-cashflow-redesign");

// desktop-1440 / tablet-768 / mobile-375 -> the numeric width for the filename.
const VIEWPORT_TAG: Record<string, string> = {
  "desktop-1440": "1440",
  "tablet-768": "768",
  "mobile-375": "375",
};

test.describe("cash-flow module", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/p/example");
    await expect(page.getByTestId("cashflow-module")).toBeVisible();
    await expect(page.getByTestId("cashflow-chart")).toBeVisible();
  });

  test("expands/collapses a year group", async ({ page }) => {
    const toggle = page.getByTestId("cashflow-group-toggle-year-2");
    await expect(toggle).toBeVisible();
    const before = await toggle.getAttribute("aria-expanded");
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    const after = await toggle.getAttribute("aria-expanded");
    // The disclosure flips to the opposite state (robust to whichever group holds
    // break-even, which starts expanded).
    expect(after).not.toBe(before);
  });

  test("hovering a table row highlights the chart point (row -> chart link)", async ({ page }) => {
    const row = page.getByTestId("cashflow-month-1"); // always in the first, expanded group
    await expect(row).toBeVisible();
    // No active point before hover.
    await expect(page.locator(".cashflow-chart__point")).toHaveCount(0);
    await row.hover();
    await expect(row).toHaveClass(/cashflow-table__row--active/);
    await expect(page.locator(".cashflow-chart__point")).toHaveCount(1);
    await expect(page.locator(".cashflow-chart__crosshair")).toHaveCount(1);
  });

  test("the CSV button downloads a '… Cash Flow.csv' file", async ({ page }) => {
    const csv = page.getByTestId("cashflow-export");
    await expect(csv).toBeVisible();
    await expect(csv).toHaveAttribute("href", /\/api\/projections\/example\/cashflow\.csv$/);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      csv.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/Cash Flow\.csv$/);
  });

  test("archives a module screenshot for this viewport", async ({ page }, testInfo) => {
    mkdirSync(ASSETS, { recursive: true });
    const tag = VIEWPORT_TAG[testInfo.project.name] ?? testInfo.project.name;
    const module = page.getByTestId("cashflow-module");
    await module.scrollIntoViewIfNeeded();
    await module.screenshot({ path: join(ASSETS, `cashflow-module-${tag}.png`) });
    await expect(module).toBeVisible();
  });
});

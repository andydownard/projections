import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

// E2E — the redesigned "Cash flow" module (spec 2026-07-04): the dual-axis chart
// + year-grouped expand/collapse monthly table + CSV export + BIDIRECTIONAL
// plot↔row hover + tap-to-pin, driven against the REAL booted app. Interaction
// tests run on the seeded `example` (stable slug/milestones); the evidence
// screenshots are taken from a FRESH 60%-LABOR projection — the canonical
// product-default shape (payback N/A → cumulative never recovers past $0),
// which is exactly the shape review-C1 proved degenerate before the fix. Runs
// at 1440 / 768 / 375 (the three Playwright projects).
const here = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(here, "..", "docs", "plans", "assets", "2026-07-04-cashflow-redesign");

// desktop-1440 / tablet-768 / mobile-375 -> the numeric width for the filename.
const VIEWPORT_TAG: Record<string, string> = {
  "desktop-1440": "1440",
  "tablet-768": "768",
  "mobile-375": "375",
};

// The canonical 60%-labor House-of-Hope shape (mirrors the backend test body +
// the engine golden house_of_hope_canonical_60.json). terms_accepted so the CSV
// link is live on the created projection too.
const CANONICAL_60_BODY = {
  name: "Canonical Sixty Labor",
  inputs: {
    org_name: "Canonical Sixty Labor",
    city: "Longview, Texas",
    opening_status: "pre_launch",
    share_y1: "0.06",
    share_y2: "0.08",
    share_y3: "0.10",
    donation_value: "74",
    building_sqft: "10000",
    salesfloor_pct: "0.70",
    source_of_funds: "300000",
    occupancy_annual: "120000",
    lease_type: "nnn",
    nnn_opex_annual: "0",
  },
  trade_area: { basis: "city", households: "31798" },
  assumptions: { labor_pct: "0.60" },
  terms_accepted: true,
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

  test("hovering the plot highlights the corresponding table row (plot -> row link, review C2)", async ({ page }) => {
    const scrubber = page.getByTestId("cashflow-scrubber");
    await scrubber.scrollIntoViewIfNeeded();
    const box = (await scrubber.boundingBox())!;
    // The seeded example is a 60-month series; aim at the CENTER of month 1's band.
    await page.mouse.move(box.x + box.width * (0.5 / 60), box.y + box.height / 2);
    await expect(page.getByTestId("cashflow-month-1")).toHaveClass(/cashflow-table__row--active/);
    await expect(page.locator(".cashflow-chart__point")).toHaveCount(1);
    await expect(page.locator(".cashflow-chart__crosshair")).toHaveCount(1);
    await expect(page.getByTestId("cashflow-tooltip")).toBeVisible();
    // Move to month 3's band — the linked highlight follows.
    await page.mouse.move(box.x + box.width * (2.5 / 60), box.y + box.height / 2);
    await expect(page.getByTestId("cashflow-month-3")).toHaveClass(/cashflow-table__row--active/);
    await expect(page.getByTestId("cashflow-month-1")).not.toHaveClass(/cashflow-table__row--active/);
  });

  test("click pins the readout; it survives the pointer leaving; second click unpins (review I1)", async ({ page }) => {
    const scrubber = page.getByTestId("cashflow-scrubber");
    await scrubber.scrollIntoViewIfNeeded();
    const box = (await scrubber.boundingBox())!;
    const month2X = box.x + box.width * (1.5 / 60);
    const midY = box.y + box.height / 2;
    await page.mouse.click(month2X, midY);
    await expect(page.getByTestId("cashflow-month-2")).toHaveClass(/cashflow-table__row--active/);
    // Leave the plot entirely — a PIN persists (a transient hover would clear).
    await page.mouse.move(box.x - 40, Math.max(0, box.y - 40));
    await expect(page.getByTestId("cashflow-month-2")).toHaveClass(/cashflow-table__row--active/);
    await expect(page.getByTestId("cashflow-tooltip")).toBeVisible();
    // Second tap on the same month unpins + dismisses.
    await page.mouse.click(month2X, midY);
    await page.mouse.move(box.x - 40, Math.max(0, box.y - 40));
    await expect(page.getByTestId("cashflow-month-2")).not.toHaveClass(/cashflow-table__row--active/);
    await expect(page.getByTestId("cashflow-tooltip")).toHaveCount(0);
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
});

test.describe("evidence screenshots — canonical 60%-labor default", () => {
  test("the canonical default renders visible, varying net bars; archive the module screenshot", async ({ page }, testInfo) => {
    // Create the 60%-labor projection through the REAL create endpoint (the
    // seeded `example` is the 40% design-parity twin, which masked review-C1).
    const resp = await page.request.post("/api/projections", { data: CANONICAL_60_BODY });
    expect(resp.status()).toBe(201);
    const { view_slug } = await resp.json();
    await page.goto(`/p/${view_slug}`);
    await expect(page.getByTestId("cashflow-module")).toBeVisible();
    await expect(page.getByTestId("cashflow-chart")).toBeVisible();

    // Real-browser C1 regression: on the payback-N/A default the net bars must
    // NOT collapse to the 0.5px degenerate floor — they vary and the month-1
    // startup-loss bar is tall (heights are viewBox units).
    const heights = await page
      .locator(".cashflow-chart__bar")
      .evaluateAll((els) => els.map((e) => parseFloat(e.getAttribute("height") || "0")));
    expect(heights).toHaveLength(60);
    expect(new Set(heights.map((h) => h.toFixed(1))).size).toBeGreaterThan(1);
    expect(Math.max(...heights)).toBeGreaterThan(20);

    mkdirSync(ASSETS, { recursive: true });
    const tag = VIEWPORT_TAG[testInfo.project.name] ?? testInfo.project.name;
    const module = page.getByTestId("cashflow-module");
    await module.scrollIntoViewIfNeeded();
    await module.screenshot({ path: join(ASSETS, `cashflow-module-${tag}.png`) });
    await expect(module).toBeVisible();
  });
});

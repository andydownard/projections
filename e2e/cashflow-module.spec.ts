import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Locator, type Page } from "@playwright/test";

// Design-review follow-up (2026-07-04 third pass): the milestone chip stack
// (commit 47bda6f) was drawn on a translucent panel OVERLAID INSIDE the plot's
// top-left corner — real-browser evidence showed "Payback · Month 32" running
// through the "$100,000" tick label, the panel hiding the left "$0" tick and
// crossing gridlines, and ~a third of the plot (incl. bars) covered at 375px.
// The fix (see CashflowChart.tsx) reserves a BAND above the plot sized to the
// actual chip count and pushes the plot's top edge down by that amount, so
// chips and plot content occupy disjoint y-ranges by construction. This
// bbox-intersection check is the real-browser lock for that: every chip's
// rendered rect must be fully disjoint from the plot rect, from every
// tick-label rect, AND from the two rotated axis titles ("Monthly net" /
// "Cumulative cash") at whatever viewport/shape is under test — the last of
// those matters most at 375px (owner feedback, 2026-07-04 fourth pass: the
// chip stack moved from the plot's left edge to the MODULE TITLE's left edge,
// which is further left and closer to the rotated "Monthly net" title's
// gutter, so this is the real regression lock proving they still never touch).
//
// `minChips` defaults to 1 (every real projection resolves at least Grand
// Opening); the synthetic legacy 12-row shape (no milestones, no break-even)
// now renders ZERO chips — "Lowest cash" was the only callout it ever had, and
// that callout is removed (owner feedback: redundant with break-even,
// negatively toned) — so that call site passes `{ minChips: 0 }`.
async function assertChipsNeverOverlapPlot(page: Page, shape: string, opts: { minChips?: number } = {}) {
  const minChips = opts.minChips ?? 1;
  const result = await page.evaluate(() => {
    const disjoint = (a: DOMRect, b: DOMRect) =>
      a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
    const chips = Array.from(document.querySelectorAll(".cashflow-chart__milestone-chip"));
    const plot = document.querySelector(".cashflow-chart__scrubber");
    const ticks = Array.from(
      document.querySelectorAll(".cashflow-chart__axis-tick--left, .cashflow-chart__axis-tick--right"),
    );
    const axisTitles = Array.from(
      document.querySelectorAll(".cashflow-chart__axis-label--net, .cashflow-chart__axis-label--cum"),
    );
    if (!plot) return { ok: false, bad: ["no .cashflow-chart__scrubber found"], chipCount: chips.length };
    const plotRect = plot.getBoundingClientRect();
    const bad: string[] = [];
    for (const chip of chips) {
      const c = chip.getBoundingClientRect();
      const id = chip.getAttribute("data-testid") ?? "(chip)";
      if (!disjoint(c, plotRect)) bad.push(`${id} intersects the plot rect`);
      for (const tick of ticks) {
        const t = tick.getBoundingClientRect();
        if (!disjoint(c, t)) bad.push(`${id} intersects tick label "${tick.textContent}"`);
      }
      for (const title of axisTitles) {
        const t = title.getBoundingClientRect();
        if (!disjoint(c, t)) {
          bad.push(`${id} intersects the rotated axis title "${title.getAttribute("class")}"`);
        }
      }
    }
    return { ok: bad.length === 0, bad, chipCount: chips.length };
  });
  expect(
    result.chipCount ?? 0,
    `${shape}: expected at least ${minChips} milestone chip(s)`,
  ).toBeGreaterThanOrEqual(minChips);
  expect(result.ok, `${shape}: chip/plot overlaps found: ${JSON.stringify(result.bad)}`).toBe(true);
}

// The reserved chip band (this fix) makes the module taller — at 1440x900 the
// full module (chart + table) now exceeds the viewport height by more than it
// used to. Playwright's element screenshot can capture an element taller than
// the viewport, but doing so for an element that overflows by a wide margin
// mis-renders the app's sticky `position: fixed` topbar INTO the captured
// image (a Playwright/CDP artifact of capturing beyond the viewport with a
// fixed-position ancestor — confirmed NOT a real rendering bug: a real user
// scroll to the same position renders cleanly). The fix for evidence capture:
// briefly grow the PAGE viewport to fit the whole module before shooting, so
// no beyond-viewport capture is ever needed, then restore the original
// viewport for the next shape/assertion.
async function screenshotWholeModule(page: Page, module: Locator, path: string) {
  const original = page.viewportSize();
  const box = await module.boundingBox();
  if (!original || !box) {
    await module.scrollIntoViewIfNeeded();
    await module.screenshot({ path });
    return;
  }
  // The sticky `.topbar` can wrap to two lines at narrow widths (up to ~73px
  // tall — see the `.cashflow-module { scroll-margin-top }` comment in
  // tokens.css); read its REAL height rather than assuming the desktop value.
  const topbarH = await page.evaluate(
    () => document.querySelector(".topbar")?.getBoundingClientRect().height ?? 45,
  );
  const safeTop = Math.ceil(topbarH) + 16; // clearance below the topbar
  const neededHeight = Math.ceil(box.height) + safeTop + 20;
  if (neededHeight > original.height) {
    await page.setViewportSize({ width: original.width, height: neededHeight });
  }
  // Deterministic scroll: land the module's top at a fixed offset clear of the
  // topbar, computed directly rather than via `scrollIntoViewIfNeeded()`'s
  // "nearest" + CSS `scroll-margin-top` — empirically inconsistent for an
  // element this tall (it can leave the module's top scrolled behind the
  // topbar, or even off-screen, depending on viewport/shape). This ALSO fixes
  // the reserved chip band making the module taller: a Playwright element
  // screenshot of something taller than the viewport can otherwise mis-render
  // the app's `position: fixed` topbar INTO the captured image (a Playwright/
  // CDP "capture beyond viewport" artifact — confirmed not a real rendering
  // bug: a real user scrolled to the same position renders cleanly).
  await page.evaluate(
    ({ testId, top }) => {
      const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      window.scrollBy(0, rect.top - top);
    },
    { testId: "cashflow-module", top: safeTop },
  );
  await module.screenshot({ path });
  if (original.height !== neededHeight) {
    await page.setViewportSize(original);
    // Re-settle scroll at the restored (original) viewport size — the grown
    // viewport's scroll offset can otherwise leave content off-screen once
    // shrunk back down, which would affect any capture right after this call.
    await module.scrollIntoViewIfNeeded();
  }
}

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

  // Owner item 1 (live review 2026-07-04): "label the right and left axes and
  // have the appropriate symbol ... to indicate what it's for." Both titles
  // exist in the DOM at every viewport, but at 375px the wide layout's fixed
  // right-anchor offset for the cumulative title collided with the net
  // title's text at ZERO gap (confirmed via getBoundingClientRect: the two
  // ran together with no visible separation) — which is exactly why an owner
  // scanning the live page read the axes as unlabeled. This runs at all three
  // Playwright projects (desktop-1440/tablet-768/mobile-375) via the project
  // matrix, so it is the real regression lock for the narrow-width fix.
  test("both axis titles are visible and never overlap, at this viewport (owner item 1)", async ({ page }) => {
    const chart = page.getByTestId("cashflow-chart");
    await chart.scrollIntoViewIfNeeded();
    const rects = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const net = r(".cashflow-chart__axis-label--net");
      const cum = r(".cashflow-chart__axis-label--cum");
      return { net: { ...net.toJSON() }, cum: { ...cum.toJSON() } };
    });
    // Both present and non-degenerate (real width/height, not display:none).
    expect(rects.net.width).toBeGreaterThan(0);
    expect(rects.net.height).toBeGreaterThan(0);
    expect(rects.cum.width).toBeGreaterThan(0);
    expect(rects.cum.height).toBeGreaterThan(0);
    // Rectangles do not intersect (works whether stacked vertically or laid
    // out side by side): disjoint on at least one axis.
    const disjoint =
      rects.net.right <= rects.cum.left ||
      rects.cum.right <= rects.net.left ||
      rects.net.bottom <= rects.cum.top ||
      rects.cum.bottom <= rects.net.top;
    expect(disjoint).toBe(true);
  });

  // Owner item 1, second finding: `scrollIntoViewIfNeeded()` (the "nearest"
  // scroll strategy — a close proxy for a real user scrolling down until the
  // module comes into view, rather than snapping it flush to the very top)
  // left the module's top ~28px ABOVE the viewport top on a 1440x900 window,
  // because the module (full 60-month chart + table) is taller than the
  // viewport. That put the axis-title row (y ~33-50) almost entirely BEHIND
  // the sticky `.topbar` (y 0-45, z-index 20) — confirmed via
  // getBoundingClientRect against the real seeded page, not simulated. This is
  // the "dropped at some viewport" the owner saw live. `scroll-margin-top` on
  // `.cashflow-module` is the fix (CSS-only, module-scoped, no TopBar change).
  test("scrolling the module into view never lands the axis titles behind the sticky topbar (owner item 1)", async ({ page }) => {
    const module = page.getByTestId("cashflow-module");
    await module.scrollIntoViewIfNeeded();
    const rects = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().toJSON();
      return { topbar: r(".topbar"), net: r(".cashflow-chart__axis-label--net"), cum: r(".cashflow-chart__axis-label--cum") };
    });
    expect(rects.net.top).toBeGreaterThanOrEqual(rects.topbar.bottom);
    expect(rects.cum.top).toBeGreaterThanOrEqual(rects.topbar.bottom);
  });

  // Owner feedback (2026-07-04 fourth pass): "align the legend with the
  // milestones, left, with the title." A real-browser lock: the unit test can
  // only assert the SVG viewBox coordinate (x=0); this proves the RENDERED
  // pixel column that coordinate lands in matches the <h2> module title's own
  // left text edge, given the shared `.cashflow-module` padding (tokens.css).
  //
  // This compares the <svg> element's own rendered box (where chipStackX=0
  // geometrically lands) rather than an individual chip <text>'s ink bounding
  // box: real-browser measurement showed the milestone glyphs (⚑ ▲ ★) carry
  // large, GLYPH-DEPENDENT left side-bearing under font substitution — each
  // one's ink box starts tens of pixels left of its x=0 anchor, by a different
  // amount per glyph — which is a font-rendering artifact orthogonal to the
  // layout fix under test and would make an ink-box assertion flaky/
  // environment-dependent. The SVG element's own box is a stable, scale-exact
  // proxy for "where x=0 renders" (its left edge IS x=0 in viewBox space).
  test("the milestone chip stack's left edge aligns with the module title's left edge (owner item)", async ({ page }) => {
    const module = page.getByTestId("cashflow-module");
    await module.scrollIntoViewIfNeeded();
    const rects = await page.evaluate(() => {
      const title = document.querySelector(".cashflow-module__title")!.getBoundingClientRect();
      const svg = document.querySelector(".cashflow-chart__svg")!.getBoundingClientRect();
      return { titleLeft: title.left, svgLeft: svg.left };
    });
    expect(Math.abs(rects.svgLeft - rects.titleLeft)).toBeLessThan(1);
  });
});

// A server money value {raw, display} (whole dollars, "$", parens for negatives),
// mirroring the backend/unit convention — the chart renders `display` verbatim.
function sv(raw: number) {
  const abs = Math.abs(Math.round(raw));
  const grouped = abs.toLocaleString("en-US");
  return { raw, display: raw < 0 ? `($${grouped})` : `$${grouped}` };
}

// A LEGACY 2.6.0-era snapshot: 12 monthly rows, NO milestones. A big M1 startup
// (net M1 ≈ the cumulative trough) so the two nice domains agree at both ends and
// UNIFY into one identical ladder on both axes (owner defect 1(c) — the case that
// otherwise read "left ending −$300k, right −$400k" as an error).
function legacyMonthly() {
  const rows = [];
  let cum = 0;
  for (let m = 1; m <= 12; m++) {
    const net = m === 1 ? -300_000 : 25_000;
    cum += net;
    rows.push({
      month: m,
      revenue: sv(40_000),
      expenses: sv(m === 1 ? 340_000 : 15_000),
      net: sv(net),
      cumulativeCash: sv(cum),
    });
  }
  return rows;
}

test.describe("evidence screenshots — three data shapes", () => {
  test("archive the cash-flow module for canonical 60% + design-parity 40% + a legacy 12-row snapshot", async ({
    page,
  }, testInfo) => {
    mkdirSync(ASSETS, { recursive: true });
    const tag = VIEWPORT_TAG[testInfo.project.name] ?? testInfo.project.name;
    const module = page.getByTestId("cashflow-module");

    // ── Shape 1: canonical 60%-labor default, created through the REAL endpoint
    // (the seeded `example` is the 40% design-parity twin, which masked review-C1).
    const resp = await page.request.post("/api/projections", { data: CANONICAL_60_BODY });
    expect(resp.status()).toBe(201);
    const { view_slug } = await resp.json();
    await page.goto(`/p/${view_slug}`);
    await expect(module).toBeVisible();
    await expect(page.getByTestId("cashflow-chart")).toBeVisible();

    // Real-browser C1 regression: on the payback-N/A default the net bars must NOT
    // collapse to the 0.5px degenerate floor — they vary and the month-1 loss bar
    // is tall (heights are viewBox units).
    const heights = await page
      .locator(".cashflow-chart__bar")
      .evaluateAll((els) => els.map((e) => parseFloat(e.getAttribute("height") || "0")));
    expect(heights).toHaveLength(60);
    expect(new Set(heights.map((h) => h.toFixed(1))).size).toBeGreaterThan(1);
    expect(Math.max(...heights)).toBeGreaterThan(20);

    // Owner defect 1: the RIGHT (cumulative) axis ladder now spans the full plot
    // height (was crammed into a sliver). Assert the tick-y span is ≥90% of the
    // plot height in the REAL browser, then archive the module.
    const rightSpan = await page
      .locator(".cashflow-chart__axis-tick--right")
      .evaluateAll((els) => {
        const ys = els.map((e) => parseFloat(e.getAttribute("y") || "NaN"));
        return Math.max(...ys) - Math.min(...ys);
      });
    expect(rightSpan).toBeGreaterThanOrEqual(0.9 * 228);

    await module.scrollIntoViewIfNeeded();
    await assertChipsNeverOverlapPlot(page, `canonical-${tag}`);
    await screenshotWholeModule(page, module, join(ASSETS, `cashflow-module-canonical-${tag}.png`));

    // Fresh close-up crops of the two ROTATED axis titles (geometry moved this
    // pass): real-browser evidence each renders rotated, glyph-riding-with-text.
    for (const [key, groupClass] of [
      ["net", ".cashflow-chart__axis-label--net"],
      ["cum", ".cashflow-chart__axis-label--cum"],
    ] as const) {
      const title = page.locator(groupClass);
      await expect(title).toBeVisible();
      const box = (await title.boundingBox())!;
      const pad = 6;
      await page.screenshot({
        path: join(ASSETS, `cashflow-axis-title-${key}-${tag}-closeup.png`),
        clip: {
          x: Math.max(0, box.x - pad),
          y: Math.max(0, box.y - pad),
          width: box.width + pad * 2,
          height: box.height + pad * 2,
        },
      });
    }

    // ── Shape 2: design-parity 40% — the seeded `example` twin.
    await page.goto("/p/example");
    await expect(module).toBeVisible();
    await expect(page.getByTestId("cashflow-chart")).toBeVisible();
    await module.scrollIntoViewIfNeeded();
    await assertChipsNeverOverlapPlot(page, `parity-${tag}`);
    await screenshotWholeModule(page, module, join(ASSETS, `cashflow-module-parity-${tag}.png`));

    // ── Shape 3: a LEGACY 12-row snapshot (no milestones). Injected by rewriting
    // the `example` view-model's monthly series + dropping milestones — the real
    // SPA renders the real CashflowChart, exercising the G=1 legacy fallback and
    // the unified-ladder path in a real browser.
    const baseVm = await (await page.request.get("/api/projections/example")).json();
    const legacyVm = { ...baseVm, monthly: legacyMonthly(), breakevenMonth: null };
    delete legacyVm.milestones;
    await page.route("**/api/projections/example", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(legacyVm) })
        : route.continue(),
    );
    await page.goto("/p/example");
    await expect(module).toBeVisible();
    await expect(page.getByTestId("cashflow-chart")).toBeVisible();
    // 12 bars, and the unified ladder: left + right tick labels are identical.
    await expect(page.locator(".cashflow-chart__bar")).toHaveCount(12);
    const [leftTicks, rightTicks] = await Promise.all([
      page.locator(".cashflow-chart__axis-tick--left").allTextContents(),
      page.locator(".cashflow-chart__axis-tick--right").allTextContents(),
    ]);
    expect(leftTicks.length).toBeGreaterThan(1);
    expect(leftTicks).toEqual(rightTicks);
    await module.scrollIntoViewIfNeeded();
    // No milestones + no break-even → zero chips now that "Lowest cash" (the
    // only callout this shape ever had) is removed.
    await assertChipsNeverOverlapPlot(page, `legacy-${tag}`, { minChips: 0 });
    await screenshotWholeModule(page, module, join(ASSETS, `cashflow-module-legacy-${tag}.png`));
    await page.unroute("**/api/projections/example");
  });
});

import { expect, test } from "@playwright/test";

// E2E flow 2 — edit/override -> recompute -> 409 conflict (DoD Tier-2 / rule 6).
// Two editors race; the stale writer gets the Save-conflict modal (Reload latest /
// Overwrite / Save as copy). The client tracks the server `version` and never blind-
// overwrites (PRD §19.4 / SECURITY.md §6.1).
//
// #198: no longer gated behind an env flag CI never sets — the edit/Settings tab,
// the server recompute, and the 409 conflict modal shipped, so this runs for real
// against the booted app. It is the one stateful flow (it mutates the seeded
// `example`), so it reseeds before each test via the E2E-only /api/_test/reseed.
test.describe("override + 409 optimistic-concurrency", () => {
  // This flow MUTATES the seeded `example` projection (labor, name, version) and
  // reseeds per test. The whole suite already runs workers:1 (one shared in-memory
  // DB — playwright.config.ts); this serial guard is belt-and-suspenders.
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ request }) => {
    await request.post("/api/_test/reseed");
  });

  test("editing a settings slider recomputes via the server (no client math)", async ({ page }) => {
    await page.goto("/p/example/edit#edit-secret");
    // Fragment secret is scrubbed from the URL after read (SECURITY.md §2.5).
    await expect(page).not.toHaveURL(/#edit-secret/);
    const capitalBefore = await page.getByTestId("metric-capital").textContent();
    // Epic G (#41): Settings is MERGED into the KPIs tab (no standalone Settings
    // page); the KPI strip + the sliders both live there. The pct field is 0-1.
    await page.getByRole("tab", { name: /kpis/i }).click();
    await page.getByLabel(/labor %/i).fill("0.5"); // change from the seed's 40%
    // The SERVER recompute (no client math) shows in the KPIs tab — the Labor-ratio
    // KPI reads 50%, never computed on the client.
    await expect(page.getByTestId("kpi-Labor ratio")).toContainText("50.0%");
    // Back on Projection: the Settings panel is truly hidden, and a downstream
    // figure (the capital tile) changed — also a server recompute, not client math.
    await page.getByRole("tab", { name: /projection/i }).click();
    await expect(page.getByTestId("settings-tab")).toBeHidden();
    await expect(page.getByTestId("metric-capital")).not.toHaveText(capitalBefore ?? "");
  });

  test("a stale PATCH surfaces the 409 save-conflict modal", async ({ page, context }) => {
    await page.goto("/p/example/edit#edit-secret");
    const other = await context.newPage();
    await other.goto("/p/example/edit#edit-secret");

    // Editor A saves first (version bumps); editor B's save is now stale.
    await page.getByLabel(/store name/i).fill("Edited by A");
    await expect(page.getByTestId("save-label")).toHaveText(/all changes saved/i);

    await other.getByLabel(/store name/i).fill("Edited by B");
    await expect(other.getByTestId("save-conflict-modal")).toBeVisible();
    await expect(other.getByRole("button", { name: /reload latest/i })).toBeVisible();
    await expect(other.getByRole("button", { name: /overwrite/i })).toBeVisible();
    await expect(other.getByRole("button", { name: /save as copy/i })).toBeVisible();
  });

  test("pinning a derived/total row is rejected (non-pinnable)", async ({ page }) => {
    await page.goto("/p/example/edit#edit-secret");
    // Net profit is a derived total — the cell is not editable (non-pinnable, §14).
    const netCell = page.getByTestId("row-net_profit-y1");
    await expect(netCell).toHaveAttribute("aria-disabled", "true");
  });

  // Epic G2 (#42): the standalone right-edge Override Inspector is ELIMINATED — its
  // function (the overrides audit + the justification capture) moved into Penny's
  // drawer + the KPIs tab. The forensic FAB/panel must no longer exist; Penny remains
  // the only side panel and the relocated audit lives in the KPIs tab.
  test("the standalone Override Inspector is gone; the audit lives in the KPIs tab", async ({ page }) => {
    await page.goto("/p/example/edit#edit-secret");
    await expect(page.getByTestId("penny-fab")).toBeVisible();
    await expect(page.getByTestId("inspector-fab")).toHaveCount(0);
    await expect(page.getByTestId("inspector-panel")).toHaveCount(0);
    // The relocated "what's currently overridden" audit is in the KPIs tab.
    await page.getByRole("tab", { name: /kpis/i }).click();
    await expect(page.getByTestId("kpis-override-audit")).toBeVisible();
  });
});

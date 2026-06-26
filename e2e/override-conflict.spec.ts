import { expect, test } from "@playwright/test";

// E2E flow 2 — edit/override -> recompute -> 409 conflict (DoD Tier-2 / rule 6).
// Two editors race; the stale writer gets the Save-conflict modal (Reload latest /
// Overwrite / Save as copy). The client tracks the server `version` and never blind-
// overwrites (PRD §19.4 / SECURITY.md §6.1).
const M2_READY = process.env.E2E_M2_READY === "1";

test.describe("override + 409 optimistic-concurrency", () => {
  test.skip(!M2_READY, "M4 override UI / M2 conflict modal not built yet — scaffold pins the flow");

  // This flow MUTATES the seeded `example` projection (labor, name, version) and
  // reseeds per test, so run it SERIALLY — the suite is otherwise fullyParallel and
  // a parallel sibling would clobber the shared example row mid-test.
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ request }) => {
    await request.post("/api/_test/reseed");
  });

  test("editing a settings slider recomputes via the server (no client math)", async ({ page }) => {
    await page.goto("/p/example/edit#edit-secret");
    // Fragment secret is scrubbed from the URL after read (SECURITY.md §2.5).
    await expect(page).not.toHaveURL(/#edit-secret/);
    const capitalBefore = await page.getByTestId("metric-capital").textContent();
    // Settings controls live behind the Settings tab; the pct field is 0-1.
    await page.getByRole("tab", { name: /settings/i }).click();
    await page.getByLabel(/labor %/i).fill("0.5"); // change from the seed's 40%
    // Back on Projection: the Settings panel is truly hidden, and the SERVER
    // recompute (no client math) shows — the Labor-ratio KPI is 50% AND a
    // downstream figure (capital) changed; neither was computed on the client.
    await page.getByRole("tab", { name: /projection/i }).click();
    await expect(page.getByTestId("settings-tab")).toBeHidden();
    await expect(page.getByTestId("kpi-Labor ratio")).toContainText("50.0%");
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
});

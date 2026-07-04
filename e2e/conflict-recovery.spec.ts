import { expect, test } from "@playwright/test";

// Task 4.5 — the 409 save-conflict modal has three resolution actions (Reload
// latest / Overwrite / Save as copy); override-conflict.spec.ts only proves the
// modal APPEARS with all three buttons visible. This spec drives each action to
// completion and asserts its distinct, documented outcome (SaveConflictModal.tsx /
// ProjectionDetail.tsx resolveReload/resolveOverwrite/resolveSaveAsCopy):
//
//   - Reload latest: DISCARDS the local edit and shows the server's current state.
//   - Overwrite: force-saves the local edit on top of the server's current state
//     (a partial PATCH merge — it does NOT clobber the other editor's unrelated
//     change).
//   - Save as copy: forks a NEW projection carrying the local edit (owner-only —
//     POST …/duplicate), landing on it; the new projection shows up in the
//     owner-scoped list (TENANT — PRD §20).
//
// Same two-editor race as override-conflict.spec.ts: editor A renames the seeded
// `example` projection (bumps its version); editor B (a second tab, opened before
// A's save) edits a DRIVER (Labor %) — a stale PATCH, so it 409s. Each test then
// drives ONE resolution path from that same setup, reseeding first so the three
// paths never interfere with each other or with override-conflict.spec.ts.
test.describe("409 save-conflict: Reload / Overwrite / Save-as-copy resolution", () => {
  // MUTATES the seeded `example` projection (name, version) like override-conflict
  // .spec.ts; the whole suite already runs workers:1 (one shared file-backed DB —
  // playwright.config.ts), so this serial guard is belt-and-suspenders.
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ request }) => {
    await request.post("/api/_test/reseed");
  });

  /** Editor A renames (bumps the server version); editor B (opened first, so its
   *  local version is stale) edits the Labor % driver -> a stale PATCH -> 409. */
  async function raceToConflict(page: import("@playwright/test").Page, other: import("@playwright/test").Page) {
    await page.goto("/p/example/edit#edit-secret");
    await other.goto("/p/example/edit#edit-secret");

    await page.getByTestId("rename-projection").click();
    await page.getByLabel(/store name/i).fill("Edited by A");
    await expect(page.getByTestId("save-label")).toHaveText(/all changes saved/i);

    await other.getByRole("tab", { name: /kpis/i }).click();
    // The Labor % driver lives in the "Operating cost structure" group, which loads
    // COLLAPSED (SettingsTab.tsx: every param group defaults closed) -- expand it
    // before the field is fillable.
    await other.getByTestId("settings-group-cost-structure").click();
    await other.getByLabel(/labor %/i).fill("55");
    await expect(other.getByTestId("save-conflict-modal")).toBeVisible();
  }

  test("Reload latest: B's view shows A's value; B's driver edit is discarded", async ({
    page,
    context,
    request,
  }) => {
    const other = await context.newPage();
    await raceToConflict(page, other);

    // Scoped to the modal: SettingsTab also renders its own inline conflict banner
    // with an "Overwrite with my changes" affordance (a DIFFERENT element), so an
    // unscoped role/name query is ambiguous (strict-mode violation).
    await other.getByTestId("save-conflict-modal").getByRole("button", { name: "Reload latest" }).click();
    await expect(other.getByTestId("save-conflict-modal")).toBeHidden();
    // B now shows A's current server state -- A's renamed heading...
    await expect(other.getByRole("heading", { level: 1 })).toHaveText("Edited by A");
    // ...and B's own driver edit never reached the server (discarded, not replayed
    // by any later action): the stored Labor % is still the seed default (40%).
    const res = await request.get("/api/projections/example");
    expect((await res.json()).settings.laborPct).toBeCloseTo(0.4, 6);
  });

  test("Overwrite: the server reflects B's edit on re-GET, alongside A's unrelated change", async ({
    page,
    context,
    request,
  }) => {
    const other = await context.newPage();
    await raceToConflict(page, other);

    // Scoped to the modal: SettingsTab's own inline conflict banner also has an
    // "Overwrite with my changes" button; an unscoped query is ambiguous.
    await other.getByTestId("save-conflict-modal").getByRole("button", { name: "Overwrite" }).click();
    await expect(other.getByTestId("save-conflict-modal")).toBeHidden();
    // B's forced re-save shows up locally...
    await expect(other.getByRole("tab", { name: /kpis/i })).toHaveAttribute("aria-selected", "true");
    await expect(other.getByTestId("kpi-Labor ratio")).toContainText("55.0%");
    // ...AND a completely fresh server GET (re-fetching from scratch, not trusting
    // the client's optimistic state) confirms it actually persisted, alongside A's
    // rename -- Overwrite is a PARTIAL merge, not a blind clobber of the whole row.
    const res = await request.get("/api/projections/example");
    const body = await res.json();
    expect(body.settings.laborPct).toBeCloseTo(0.55, 6);
    expect(body.name).toBe("Edited by A");
  });

  test("Save as copy: a new projection carries B's edit; the list shows the copy", async ({
    page,
    context,
    request,
  }) => {
    const other = await context.newPage();
    // Save-as-copy is owner-only (POST …/duplicate). The seeded `example` row's
    // owner token ("owner-secret", app/seed.py EXAMPLE_OWNER_TOKEN) is set in this
    // tab's localStorage BEFORE navigating -- exactly the realistic case this
    // button exists for: the OWNER editing their own projection in two tabs. The
    // edit-token-only case is already covered (canSaveAsCopy=false, disabled with
    // an explanatory tooltip) and isn't this spec's concern.
    await other.addInitScript(() => {
      window.localStorage.setItem("projections.owner_token", "owner-secret");
    });
    await raceToConflict(page, other);

    // Scoped to the modal for the same reason as Reload/Overwrite above.
    await other.getByTestId("save-conflict-modal").getByRole("button", { name: "Save as copy" }).click();
    // The source `example` URL ALSO matches a generic /p/<slug>/edit pattern, so wait
    // specifically for a slug that is NOT "example" -- otherwise toHaveURL would
    // (wrongly) resolve immediately against the pre-navigation URL.
    await other.waitForURL(/\/p\/(?!example\/)[^/]+\/edit$/);
    const newSlug = other.url().match(/\/p\/([^/]+)\/edit$/)?.[1];
    expect(newSlug).toBeTruthy();
    expect(newSlug).not.toBe("example"); // a genuinely NEW projection, not the source

    // The new projection exists server-side and carries B's edit (Labor % 55%),
    // independent of the source `example` row (which the other two tests prove
    // Overwrite/Reload act on instead).
    const res = await request.get(`/api/projections/${newSlug}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).settings.laborPct).toBeCloseTo(0.55, 6);

    // The owner-scoped list (TENANT — PRD §20) shows the copy.
    await other.goto("/");
    await expect(other.getByTestId(`projection-row-${newSlug}`)).toBeVisible();
  });
});

import { defineConfig, devices } from "@playwright/test";

// E2E gate (DEFINITION_OF_DONE Tier-2 / rule 6): MULTIPLE flows run headless in CI
// at 1440 / 768 / 375 against the Appendix-D stress dataset, screenshots archived.
// The base URL is the dev server (Vite) proxied to the FastAPI app.
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
// When E2E_BASE_URL is set the servers are assumed already running (CI / manual).
const MANAGE_SERVERS = !process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // The webServer boots ONE FastAPI process with a FILE-backed SQLite DB shared by
  // every test/project (DB_PATH below), and the override flow mutates+reseeds the
  // single seeded `example` row. So the suite MUST run serially — parallel workers
  // race on that shared state. Encode it here, not as an invocation-time flag.
  //
  // The DB is file-backed (NOT :memory:) on purpose, to MATCH PRODUCTION: prod runs
  // SQLite WAL on the /data volume, where each request thread reads through its OWN
  // per-thread reader connection (app/store/sqlite.py). An in-memory DB cannot use
  // that pool — every read funnels through the single primary connection — so the
  // detail page's two near-simultaneous loads (the wizard→detail SPA transition fires
  // the projection GET twice) raced on that one connection and intermittently returned
  // a corrupted 500/404 for a freshly-created row. The file DB gives the prod-faithful
  // per-thread WAL readers, so concurrent reads no longer corrupt. (Future: give each
  // worker its own DB to re-enable parallelism.)
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The JSON report feeds the CI fail-on-empty guard (scripts/assert_e2e_ran.mjs):
  // Playwright has no built-in "fail if zero tests ran", so a suite that silently
  // skips 100% (the #198 false-green) would otherwise still report green. The guard
  // parses this report and fails the build unless real tests executed.
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "playwright-report/results.json" }],
  ],
  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  // Boot the FastAPI app (seeded) + the Vite dev server (which proxies /api).
  // Skipped when E2E_BASE_URL points at already-running servers.
  webServer: MANAGE_SERVERS
    ? [
        {
          // A FILE-backed SQLite DB (prod-faithful WAL + per-thread readers, see the
          // workers note above). Cleaned before boot so each run seeds fresh; the
          // single webServer process owns it for the whole serial suite.
          command:
            "bash -lc 'cd .. && source .venv/bin/activate && " +
            "rm -f /tmp/projections-e2e.db /tmp/projections-e2e.db-wal /tmp/projections-e2e.db-shm && " +
            "E2E_SEED=1 APP_ENV=dev DB_BACKEND=sqlite DB_PATH=/tmp/projections-e2e.db " +
            "uvicorn app.main:app --host 127.0.0.1 --port 8000'",
          url: "http://127.0.0.1:8000/api/health",
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          command: "bash -lc 'cd ../web && npx vite --host 127.0.0.1 --port 5173'",
          url: "http://127.0.0.1:5173",
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      ]
    : undefined,
  // The three required viewports (DESIGN_PROMPT / DoD): desktop, tablet, phone.
  projects: [
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "tablet-768", use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } } },
    { name: "mobile-375", use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } } },
  ],
});

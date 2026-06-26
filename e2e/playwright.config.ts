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
  // The webServer boots ONE FastAPI process with an in-memory SQLite DB shared by
  // every test/project, and the override flow mutates+reseeds the single seeded
  // `example` row. So the suite MUST run serially — parallel workers race on that
  // shared state (and a file-backed DB corrupts). Encode it here, not as an
  // invocation-time flag. (Future: give each worker its own DB to re-enable parallelism.)
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
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
          command:
            "bash -lc 'cd .. && source .venv/bin/activate && " +
            "E2E_SEED=1 APP_ENV=dev DB_BACKEND=sqlite " +
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

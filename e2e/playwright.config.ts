import { defineConfig, devices } from "@playwright/test";

// E2E gate (DEFINITION_OF_DONE Tier-2 / rule 6): MULTIPLE flows run headless in CI
// at 1440 / 768 / 375 against the Appendix-D stress dataset, screenshots archived.
// The base URL is the dev server (Vite) proxied to the FastAPI app.
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  // The three required viewports (DESIGN_PROMPT / DoD): desktop, tablet, phone.
  projects: [
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "tablet-768", use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } } },
    { name: "mobile-375", use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } } },
  ],
});

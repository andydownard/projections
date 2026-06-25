/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite SPA served alongside FastAPI; hashed JS only (no inline script) so the
// enforcing CSP (SECURITY.md §8) has no 'unsafe-inline' debt.
// The API origin the dev server proxies /api to (the FastAPI/uvicorn process).
// Default to the IPv4 loopback literal (127.0.0.1), not the `localhost` hostname:
// the E2E uvicorn binds 127.0.0.1, but on macOS `localhost` can resolve to IPv6
// ::1 first — which uvicorn is NOT listening on — surfacing as an intermittent
// ECONNREFUSED / 500 through the Vite proxy and a flaky E2E gate.
const API_TARGET = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    // SPA dev proxy: /api -> FastAPI. The browser only ever talks same-origin,
    // so no client-side secret/CORS surface (SECURITY.md §8.2).
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});

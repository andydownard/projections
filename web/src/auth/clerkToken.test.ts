import { afterEach, describe, expect, it, vi } from "vitest";

import { clerkActive, clerkEnabledForHost } from "./clerkToken";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("clerkEnabledForHost", () => {
  it("allows the production rallytasks.com host", () => {
    expect(clerkEnabledForHost("projections.rallytasks.com")).toBe(true);
  });

  it("allows a proper subdomain of the allowed host", () => {
    expect(clerkEnabledForHost("staging.projections.rallytasks.com")).toBe(true);
  });

  it("allows localhost for local dev (also jsdom's default test hostname)", () => {
    expect(clerkEnabledForHost("localhost")).toBe(true);
  });

  it("rejects the old thriftly.com satellite host — the one that caused the 2026-10-02 outage", () => {
    expect(clerkEnabledForHost("projections.thriftly.com")).toBe(false);
  });

  it("rejects an unrelated host", () => {
    expect(clerkEnabledForHost("evil.example.com")).toBe(false);
  });

  it("does not match a lookalike host via naive substring (no dot-boundary suffix match)", () => {
    expect(clerkEnabledForHost("notprojections.rallytasks.com.evil.com")).toBe(false);
  });

  it("defaults to the real window.location.hostname when called with no argument", () => {
    vi.stubGlobal("location", { ...window.location, hostname: "projections.rallytasks.com" });
    expect(clerkEnabledForHost()).toBe(true);
    vi.stubGlobal("location", { ...window.location, hostname: "projections.thriftly.com" });
    expect(clerkEnabledForHost()).toBe(false);
  });
});

describe("clerkActive — the ONE check every Clerk-aware consumer must share", () => {
  // Regression (2026-10-03): App.tsx's ClerkOwnerGate was gated on a bare
  // key-presence check while RootProviders.tsx alone learned the hostname rule.
  // On a key-set-but-disallowed host, RootProviders correctly refused to mount
  // <ClerkProvider>, but ClerkOwnerGate mounted anyway (its check only asked "is
  // the key set?") with no provider ancestor — hanging the page. clerkActive() is
  // now the only function any consumer may use, so this can't happen again: every
  // consumer necessarily agrees, by construction, not by convention.

  it("is false with no publishable key, regardless of host", () => {
    vi.stubGlobal("location", { ...window.location, hostname: "projections.rallytasks.com" });
    expect(clerkActive()).toBe(false);
  });

  it("is false with a publishable key on a disallowed host (e.g. projections.thriftly.com)", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_abc");
    vi.stubGlobal("location", { ...window.location, hostname: "projections.thriftly.com" });
    expect(clerkActive()).toBe(false);
  });

  it("is true only when BOTH the key is set AND the host is allowed", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_abc");
    vi.stubGlobal("location", { ...window.location, hostname: "projections.rallytasks.com" });
    expect(clerkActive()).toBe(true);
  });
});

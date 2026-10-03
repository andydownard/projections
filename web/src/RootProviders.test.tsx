import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clerkEnabledForHost, RootProviders } from "./RootProviders";

// WAVE 2 — the satellite is SHIP-DARK. RootProviders wraps the app in the Clerk
// satellite <ClerkProvider> ONLY when VITE_CLERK_PUBLISHABLE_KEY is set; when it
// is unset the app renders EXACTLY as today and the Clerk import path is never
// executed (the wrapper is lazy-loaded). The real SDK is mocked here so the test
// never touches Clerk; it only asserts WHERE the provider mounts.
vi.mock("./auth/ClerkAuthProvider", () => ({
  default: ({
    publishableKey,
    children,
  }: {
    publishableKey: string;
    children: ReactNode;
  }) => (
    <div data-testid="clerk-provider" data-pk={publishableKey}>
      {children}
    </div>
  ),
}));

function renderRoot() {
  const queryClient = new QueryClient();
  return render(
    <RootProviders queryClient={queryClient}>
      <div data-testid="app-child">hello</div>
    </RootProviders>,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("RootProviders — ship dark", () => {
  it("renders the app with NO Clerk provider when VITE_CLERK_PUBLISHABLE_KEY is unset", () => {
    renderRoot();
    expect(screen.getByTestId("app-child")).toBeInTheDocument();
    expect(screen.queryByTestId("clerk-provider")).not.toBeInTheDocument();
  });

  it("wraps the app in the Clerk provider when the publishable key is set and the host is allowed", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_abc");
    vi.stubGlobal("location", { ...window.location, hostname: "projections.rallytasks.com" });
    renderRoot();
    const provider = await screen.findByTestId("clerk-provider");
    expect(provider).toHaveAttribute("data-pk", "pk_test_abc");
    // The app still renders inside the provider — viewers are never gated.
    expect(screen.getByTestId("app-child")).toBeInTheDocument();
  });

  it("does NOT mount Clerk on a host outside the allowlist, even with the key set (#projections.thriftly.com must never re-gain Clerk from a rallytasks.com-targeted build)", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_abc");
    vi.stubGlobal("location", { ...window.location, hostname: "projections.thriftly.com" });
    renderRoot();
    expect(screen.getByTestId("app-child")).toBeInTheDocument();
    expect(screen.queryByTestId("clerk-provider")).not.toBeInTheDocument();
  });
});

describe("clerkEnabledForHost", () => {
  it("allows the production rallytasks.com host", () => {
    expect(clerkEnabledForHost("projections.rallytasks.com")).toBe(true);
  });

  it("allows localhost for local dev", () => {
    expect(clerkEnabledForHost("localhost")).toBe(true);
  });

  it("rejects the old thriftly.com satellite host", () => {
    expect(clerkEnabledForHost("projections.thriftly.com")).toBe(false);
  });

  it("rejects an unrelated host", () => {
    expect(clerkEnabledForHost("evil.example.com")).toBe(false);
  });

  it("does not match a lookalike host via naive substring (e.g. a host that merely ends with the allowed suffix without a dot boundary)", () => {
    expect(clerkEnabledForHost("notprojections.rallytasks.com.evil.com")).toBe(false);
  });
});

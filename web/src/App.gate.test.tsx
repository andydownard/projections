import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 0 B2 — the App shell wires the FORCED owner sign-in gate over OWNER
// surfaces only (home / wizard / detail-EDIT). VIEWER surfaces (role share, the
// read-only /p/<slug>, not-found) are NEVER gated — share links stay login-free.
// When Clerk is OFF (ship dark: no VITE_CLERK_PUBLISHABLE_KEY) there is NO gate at
// all and the @clerk/clerk-react import path is never executed.
//
// The Clerk SDK is mocked with a controllable `signedIn` flag. The page components
// are mocked to lightweight markers so the test exercises the gate wiring, not the
// pages (no network, deterministic).

let signedIn = false;

vi.mock("@clerk/clerk-react", () => ({
  useClerk: () => ({ buildSignInUrl: () => "https://rallytasks.com/sign-in" }),
  SignedIn: ({ children }: { children: ReactNode }) => (signedIn ? <>{children}</> : null),
  SignedOut: ({ children }: { children: ReactNode }) => (signedIn ? null : <>{children}</>),
  UserButton: () => <div data-testid="user-button" />,
}));

vi.mock("./pages/ListPage", () => ({
  ListPage: () => <div data-testid="page-home">home</div>,
}));
vi.mock("./pages/CreateProjectionPage", () => ({
  CreateProjectionPage: () => <div data-testid="page-wizard">wizard</div>,
}));
vi.mock("./pages/ProjectionDetail", () => ({
  ProjectionDetail: ({ edit }: { edit: boolean }) => (
    <div data-testid="page-detail">{edit ? "edit" : "view"}</div>
  ),
}));
vi.mock("./pages/RoleView", () => ({
  RoleView: () => <div data-testid="page-role">role</div>,
}));
vi.mock("./components/PennyDrawer", () => ({
  PennyGeneralAssistant: () => null,
}));

import { App, isOwnerSurface } from "./App";

function go(path: string) {
  window.history.pushState({}, "", path);
}

const GATE_HEADING = { name: /sign in to continue/i } as const;

beforeEach(() => {
  signedIn = false;
});
afterEach(() => {
  vi.unstubAllEnvs();
  go("/");
});

describe("isOwnerSurface — which routes the gate covers", () => {
  it("gates home, wizard, and detail-EDIT (owner surfaces)", () => {
    expect(isOwnerSurface({ kind: "home" })).toBe(true);
    expect(isOwnerSurface({ kind: "wizard", aiOff: false, step: null })).toBe(true);
    expect(
      isOwnerSurface({ kind: "detail", slug: "p_x", edit: true, aiOff: false }),
    ).toBe(true);
  });

  it("never gates role shares, the read-only detail, or not-found (viewer surfaces)", () => {
    expect(isOwnerSurface({ kind: "role", slug: "r_x" })).toBe(false);
    expect(
      isOwnerSurface({ kind: "detail", slug: "p_x", edit: false, aiOff: false }),
    ).toBe(false);
    expect(isOwnerSurface({ kind: "notfound" })).toBe(false);
  });
});

describe("App — forced owner sign-in gate wiring (Phase 0 B2)", () => {
  it("gates an OWNER surface for a signed-OUT owner when Clerk is active (home)", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_abc");
    signedIn = false;
    go("/");
    render(<App />);
    // The gate screen renders INSTEAD of the page content (lazy/Suspense ⇒ async).
    expect(await screen.findByRole("heading", GATE_HEADING)).toBeInTheDocument();
    expect(screen.queryByTestId("page-home")).not.toBeInTheDocument();
  });

  it("renders OWNER content for a signed-IN owner when Clerk is active (wizard)", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_abc");
    signedIn = true;
    go("/wizard");
    render(<App />);
    expect(await screen.findByTestId("page-wizard")).toBeInTheDocument();
    expect(screen.queryByRole("heading", GATE_HEADING)).not.toBeInTheDocument();
  });

  it("NEVER gates a VIEWER surface even signed OUT — viewers stay login-free (read-only /p/<slug>)", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_abc");
    signedIn = false;
    go("/p/p_abc");
    render(<App />);
    // Read-only detail renders directly (no gate, no Suspense) — synchronous.
    expect(screen.getByTestId("page-detail")).toHaveTextContent("view");
    expect(screen.queryByRole("heading", GATE_HEADING)).not.toBeInTheDocument();
  });

  it("does NOT gate any OWNER surface when Clerk is OFF (ship dark) — content renders as today", () => {
    // No VITE_CLERK_PUBLISHABLE_KEY ⇒ clerkActive() is false ⇒ no gate, no Clerk import.
    signedIn = false;
    go("/");
    render(<App />);
    expect(screen.getByTestId("page-home")).toBeInTheDocument();
    expect(screen.queryByRole("heading", GATE_HEADING)).not.toBeInTheDocument();
  });
});

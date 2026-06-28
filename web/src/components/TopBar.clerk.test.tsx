import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TopBar } from "./TopBar";

// WAVE 2 — the TopBar surfaces the owner sign-in affordance ONLY when the Clerk
// satellite is active (VITE_CLERK_PUBLISHABLE_KEY set). With Clerk OFF (the
// default) the bar is byte-for-byte today's bar — no sign-in control, and the
// Clerk import path (lazy OwnerAuthControls) is never executed.

vi.mock("@clerk/clerk-react", () => ({
  useClerk: () => ({ buildSignInUrl: () => "https://rallytasks.com/sign-in" }),
  SignedOut: ({ children }: { children: ReactNode }) => <>{children}</>,
  SignedIn: () => null,
  UserButton: () => <div data-testid="user-button" />,
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("TopBar — Clerk satellite gate", () => {
  it("shows NO sign-in control when Clerk is off (ship dark default)", () => {
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
  });

  it("renders the owner sign-in affordance when the satellite is active", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_abc");
    render(<TopBar />);
    expect(
      await screen.findByRole("button", { name: /sign in/i }),
    ).toBeInTheDocument();
  });
});

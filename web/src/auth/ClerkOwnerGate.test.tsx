import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 0 B2 — the FORCED owner sign-in gate. ClerkOwnerGate renders its children
// ONLY when the owner is signed in; a signed-out owner sees the "Sign in to
// continue" gate screen INSTEAD of the page content. The gate's Sign-in button
// builds its target via clerk.buildSignInUrl() (Clerk appends __clerk_synced so
// the cross-apex satellite session round-trips) — NEVER a hardcoded URL. The real
// SDK is mocked; `signedIn` is the controllable signed-in flag.

const buildSignInUrl = vi.fn(() => "https://rallytasks.com/sign-in?__clerk_synced=true");
let signedIn = false;

vi.mock("@clerk/clerk-react", () => ({
  useClerk: () => ({ buildSignInUrl }),
  SignedIn: ({ children }: { children: ReactNode }) => (signedIn ? <>{children}</> : null),
  SignedOut: ({ children }: { children: ReactNode }) => (signedIn ? null : <>{children}</>),
}));

import ClerkOwnerGate from "./ClerkOwnerGate";

let assignMock: ReturnType<typeof vi.fn>;
let originalLocation: Location;

beforeEach(() => {
  signedIn = false;
  originalLocation = window.location;
  assignMock = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, assign: assignMock },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  vi.clearAllMocks();
});

describe("ClerkOwnerGate — forced owner sign-in", () => {
  it("blocks page content and shows the sign-in gate when the owner is signed OUT", () => {
    signedIn = false;
    render(
      <ClerkOwnerGate>
        <div data-testid="owner-content">owner page</div>
      </ClerkOwnerGate>,
    );
    expect(
      screen.getByRole("heading", { name: /sign in to continue/i }),
    ).toBeInTheDocument();
    // The page content is NOT reachable without signing in ("forced").
    expect(screen.queryByTestId("owner-content")).not.toBeInTheDocument();
  });

  it("renders page content (no gate) when signed IN — never traps a signed-in owner", () => {
    signedIn = true;
    render(
      <ClerkOwnerGate>
        <div data-testid="owner-content">owner page</div>
      </ClerkOwnerGate>,
    );
    expect(screen.getByTestId("owner-content")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /sign in to continue/i }),
    ).not.toBeInTheDocument();
  });

  it("moves focus to the Sign-in button and navigates via buildSignInUrl() (never a hardcoded URL)", async () => {
    signedIn = false;
    render(
      <ClerkOwnerGate>
        <div>owner page</div>
      </ClerkOwnerGate>,
    );
    const btn = screen.getByRole("button", { name: /sign in/i });
    expect(btn).toHaveFocus();
    await userEvent.click(btn);
    expect(buildSignInUrl).toHaveBeenCalledTimes(1);
    expect(assignMock).toHaveBeenCalledWith(
      "https://rallytasks.com/sign-in?__clerk_synced=true",
    );
  });
});

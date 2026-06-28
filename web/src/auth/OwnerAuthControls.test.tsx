import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WAVE 2 — the satellite sign-in affordance. The button builds its href with
// buildSignInUrl() from useClerk() (Clerk appends __clerk_synced so the cross-apex
// satellite session round-trips) — NEVER a hardcoded URL. The real SDK is mocked.

const buildSignInUrl = vi.fn(() => "https://rallytasks.com/sign-in?__clerk_synced=true");

vi.mock("@clerk/clerk-react", () => ({
  useClerk: () => ({ buildSignInUrl }),
  // Signed-out owners see the sign-in button; signed-in owners see the account UI.
  SignedOut: ({ children }: { children: ReactNode }) => <>{children}</>,
  SignedIn: () => null,
  UserButton: () => <div data-testid="user-button" />,
}));

import OwnerAuthControls from "./OwnerAuthControls";

let assignMock: ReturnType<typeof vi.fn>;
let originalLocation: Location;

beforeEach(() => {
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

describe("OwnerAuthControls — satellite sign-in", () => {
  it("renders a Sign in button for a signed-out owner", () => {
    render(<OwnerAuthControls />);
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("navigates via buildSignInUrl() (NOT a hardcoded href) on click", async () => {
    render(<OwnerAuthControls />);
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(buildSignInUrl).toHaveBeenCalledTimes(1);
    expect(assignMock).toHaveBeenCalledWith(
      "https://rallytasks.com/sign-in?__clerk_synced=true",
    );
  });
});

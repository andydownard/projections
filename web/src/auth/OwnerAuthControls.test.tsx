import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WAVE 2 / Epic #318 — the satellite sign-in affordance in the header. The button
// is branded "Sign in with Rally" and builds its href with buildSignInUrl({
// redirectUrl }) from useClerk() (Clerk appends __clerk_synced so the cross-apex
// satellite session round-trips; the explicit redirectUrl returns the magic-link
// here) — NEVER a hardcoded URL. A signed-in owner sees the UserMenu avatar. The
// real SDK is mocked.

const buildSignInUrl = vi.fn(() => "https://rallytasks.com/sign-in?__clerk_synced=true");

vi.mock("@clerk/clerk-react", () => ({
  useClerk: () => ({ buildSignInUrl, openUserProfile: vi.fn(), signOut: vi.fn() }),
  useUser: () => ({ user: { firstName: "Ada", lastName: "Lovelace", fullName: "Ada Lovelace", hasImage: false, imageUrl: "" } }),
  // Signed-out owners see the sign-in button; signed-in owners see the account UI.
  SignedOut: ({ children }: { children: ReactNode }) => <>{children}</>,
  SignedIn: () => null,
}));

import OwnerAuthControls from "./OwnerAuthControls";

let assignMock: ReturnType<typeof vi.fn>;
let originalLocation: Location;

beforeEach(() => {
  originalLocation = window.location;
  assignMock = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, assign: assignMock, href: "https://projections.thriftly.com/" },
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
  it("renders a 'Sign in with' + wordmark button with no duplicate 'Rally' text but the accessible name 'Sign in with Rally' (ITEM A)", () => {
    render(<OwnerAuthControls />);
    const btn = screen.getByRole("button", { name: /sign in with rally/i });
    expect(btn).toBeInTheDocument();
    // Accessible name carried by aria-label (WCAG 2.5.3 Label in Name); the visible
    // "Rally" comes from the aria-hidden wordmark, so the literal word is not in the
    // button's text (no "Rally" twice).
    expect(btn).toHaveAccessibleName("Sign in with Rally");
    expect(btn).toHaveTextContent("Sign in with");
    expect(btn).not.toHaveTextContent("Rally");
  });

  it("navigates via buildSignInUrl({ redirectUrl }) (NOT a hardcoded href) on click", async () => {
    render(<OwnerAuthControls />);
    await userEvent.click(screen.getByRole("button", { name: /sign in with rally/i }));
    expect(buildSignInUrl).toHaveBeenCalledWith({
      redirectUrl: "https://projections.thriftly.com/",
    });
    expect(assignMock).toHaveBeenCalledWith(
      "https://rallytasks.com/sign-in?__clerk_synced=true",
    );
  });

  it("strips any URL fragment from the redirect target (ITEM D / Regression #10)", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...originalLocation,
        assign: assignMock,
        href: "https://projections.thriftly.com/p/abc/edit#edit-token-SECRET",
      },
    });
    render(<OwnerAuthControls />);
    await userEvent.click(screen.getByRole("button", { name: /sign in with rally/i }));
    expect(buildSignInUrl).toHaveBeenCalledWith({
      redirectUrl: "https://projections.thriftly.com/p/abc/edit",
    });
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 0 B2 / Epic #318 — the FORCED owner sign-in gate. ClerkOwnerGate renders
// today's chrome ({topBar}{content}{penny}) ONLY when the owner is signed in; a
// signed-out owner sees the minimal sign-in page (minimal header, NO Penny). The
// Sign-in button is branded "Sign in with Rally" and builds its target via
// clerk.buildSignInUrl({ redirectUrl }) — Clerk appends __clerk_synced so the
// cross-apex satellite session round-trips, and the explicit redirectUrl returns
// the magic-link to this satellite. NEVER a hardcoded URL. The real SDK is mocked.

const buildSignInUrl = vi.fn(() => "https://rallytasks.com/sign-in?__clerk_synced=true");
let signedIn = false;

vi.mock("@clerk/clerk-react", () => ({
  useClerk: () => ({ buildSignInUrl }),
  useUser: () => ({ user: { firstName: "Ada", lastName: "Lovelace", fullName: "Ada Lovelace", hasImage: false, imageUrl: "" } }),
  SignedIn: ({ children }: { children: ReactNode }) => (signedIn ? <>{children}</> : null),
  SignedOut: ({ children }: { children: ReactNode }) => (signedIn ? null : <>{children}</>),
}));

import ClerkOwnerGate from "./ClerkOwnerGate";

let assignMock: ReturnType<typeof vi.fn>;
let originalLocation: Location;

const TOP_BAR = <div data-testid="gate-topbar" />;
const PENNY = <div data-testid="gate-penny" />;

beforeEach(() => {
  signedIn = false;
  originalLocation = window.location;
  assignMock = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, assign: assignMock, href: "https://projections.thriftly.com/wizard" },
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
      <ClerkOwnerGate topBar={TOP_BAR} penny={PENNY}>
        <div data-testid="owner-content">owner page</div>
      </ClerkOwnerGate>,
    );
    expect(
      screen.getByRole("heading", { name: /sign in to continue/i }),
    ).toBeInTheDocument();
    // The page content is NOT reachable without signing in ("forced").
    expect(screen.queryByTestId("owner-content")).not.toBeInTheDocument();
  });

  it("hides Penny on the signed-out gate (SIGNIN-1)", () => {
    signedIn = false;
    render(
      <ClerkOwnerGate topBar={TOP_BAR} penny={PENNY}>
        <div data-testid="owner-content">owner page</div>
      </ClerkOwnerGate>,
    );
    expect(screen.queryByTestId("gate-penny")).not.toBeInTheDocument();
  });

  it("renders page content + chrome (topBar + Penny) when signed IN — never traps a signed-in owner", () => {
    signedIn = true;
    render(
      <ClerkOwnerGate topBar={TOP_BAR} penny={PENNY}>
        <div data-testid="owner-content">owner page</div>
      </ClerkOwnerGate>,
    );
    expect(screen.getByTestId("owner-content")).toBeInTheDocument();
    expect(screen.getByTestId("gate-topbar")).toBeInTheDocument();
    expect(screen.getByTestId("gate-penny")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /sign in to continue/i }),
    ).not.toBeInTheDocument();
  });

  it("the gate button reads 'Sign in with Rally' and the accessible name matches the visible text", () => {
    signedIn = false;
    render(
      <ClerkOwnerGate topBar={TOP_BAR} penny={PENNY}>
        <div>owner page</div>
      </ClerkOwnerGate>,
    );
    const btn = screen.getByRole("button", { name: /sign in with rally/i });
    expect(btn).toHaveAccessibleName("Sign in with Rally");
  });

  it("moves focus to the Sign-in button and navigates via buildSignInUrl({ redirectUrl }) (never a hardcoded URL)", async () => {
    signedIn = false;
    render(
      <ClerkOwnerGate topBar={TOP_BAR} penny={PENNY}>
        <div>owner page</div>
      </ClerkOwnerGate>,
    );
    const btn = screen.getByRole("button", { name: /sign in with rally/i });
    expect(btn).toHaveFocus();
    await userEvent.click(btn);
    // SIGNIN-4: an explicit redirectUrl returns the magic-link to this satellite.
    expect(buildSignInUrl).toHaveBeenCalledWith({
      redirectUrl: "https://projections.thriftly.com/wizard",
    });
    expect(assignMock).toHaveBeenCalledWith(
      "https://rallytasks.com/sign-in?__clerk_synced=true",
    );
  });

  it("renders a 3-step explainer as a semantic ordered list with one glyph per step (SIGNIN-5)", () => {
    signedIn = false;
    render(
      <ClerkOwnerGate topBar={TOP_BAR} penny={PENNY}>
        <div>owner page</div>
      </ClerkOwnerGate>,
    );
    const list = screen.getByRole("list");
    const items = screen.getAllByRole("listitem");
    expect(list.tagName).toBe("OL");
    expect(items).toHaveLength(3);
    expect(
      screen.getByText(/Penny AI works with you to select the location/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/You tweak startup costs\. Have a proposal\?/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Get 5-year projections\./i)).toBeInTheDocument();
  });
});

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
    value: {
      ...originalLocation,
      assign: assignMock,
      href: "https://projections.thriftly.com/wizard",
      pathname: "/wizard",
      search: "",
    },
  });
  sessionStorage.clear();
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  sessionStorage.clear();
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

  it("shows 'Sign in with' + the Rally wordmark (no duplicate 'Rally' text) yet keeps the accessible name 'Sign in with Rally' (ITEM A)", () => {
    signedIn = false;
    render(
      <ClerkOwnerGate topBar={TOP_BAR} penny={PENNY}>
        <div>owner page</div>
      </ClerkOwnerGate>,
    );
    const btn = screen.getByRole("button", { name: /sign in with rally/i });
    // Accessible name preserved (carried by aria-label) for screen-reader parity.
    expect(btn).toHaveAccessibleName("Sign in with Rally");
    // The literal word "Rally" is NOT in the visible TEXT — the aria-hidden wordmark
    // supplies it, so the button never reads "Rally" twice on screen.
    expect(btn).toHaveTextContent("Sign in with");
    expect(btn).not.toHaveTextContent("Rally");
  });

  it("drops the owner helper paragraph entirely (ITEM B)", () => {
    signedIn = false;
    render(
      <ClerkOwnerGate topBar={TOP_BAR} penny={PENNY}>
        <div>owner page</div>
      </ClerkOwnerGate>,
    );
    expect(
      screen.queryByText(/This page is for the projection owner/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/never need a sign-in/i)).not.toBeInTheDocument();
  });

  it("places the sign-in button BELOW the 3-step explainer in DOM order (ITEM C)", () => {
    signedIn = false;
    render(
      <ClerkOwnerGate topBar={TOP_BAR} penny={PENNY}>
        <div>owner page</div>
      </ClerkOwnerGate>,
    );
    const list = screen.getByRole("list");
    const btn = screen.getByRole("button", { name: /sign in with rally/i });
    // The button FOLLOWS the <ol> in document order (button below the steps).
    expect(
      list.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
    // SIGNIN-4: an explicit redirectUrl returns the owner to this satellite.
    expect(buildSignInUrl).toHaveBeenCalledWith({
      redirectUrl: "https://projections.thriftly.com/wizard",
    });
    expect(assignMock).toHaveBeenCalledWith(
      "https://rallytasks.com/sign-in?__clerk_synced=true",
    );
  });

  it("strips the URL fragment from the redirect target so a capability secret never reaches the primary (ITEM D / Regression #10)", async () => {
    signedIn = false;
    // A recipient arriving on a share deep link still carries the edit-token in the
    // fragment when the gate mounts; the redirect_url sent to the primary must NOT
    // include it.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...originalLocation,
        assign: assignMock,
        href: "https://projections.thriftly.com/p/abc/edit#edit-token-SECRET",
        pathname: "/p/abc/edit",
        search: "",
      },
    });
    render(
      <ClerkOwnerGate topBar={TOP_BAR} penny={PENNY}>
        <div>owner page</div>
      </ClerkOwnerGate>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /sign in with rally/i }),
    );
    expect(buildSignInUrl).toHaveBeenCalledWith({
      redirectUrl: "https://projections.thriftly.com/p/abc/edit",
    });
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

  // EPIC #323 — auto-redirect to a captured shared deep link after sign-in.
  it("redirects to a captured shared deep link once after sign-in, then clears it", () => {
    signedIn = true;
    sessionStorage.setItem("projections.post_signin_redirect", "/p/abc/edit");
    const pushSpy = vi.spyOn(window.history, "pushState");
    render(
      <ClerkOwnerGate topBar={TOP_BAR} penny={PENNY}>
        <div data-testid="owner-content">owner page</div>
      </ClerkOwnerGate>,
    );
    // The recipient is navigated to the shared projection (current path is /wizard).
    expect(pushSpy).toHaveBeenCalledWith(null, "", "/p/abc/edit");
    // Fires once: the captured destination is cleared.
    expect(sessionStorage.getItem("projections.post_signin_redirect")).toBeNull();
  });

  it("does not redirect when already at the captured destination (no loop)", () => {
    signedIn = true;
    sessionStorage.setItem("projections.post_signin_redirect", "/wizard");
    const pushSpy = vi.spyOn(window.history, "pushState");
    render(
      <ClerkOwnerGate topBar={TOP_BAR} penny={PENNY}>
        <div data-testid="owner-content">owner page</div>
      </ClerkOwnerGate>,
    );
    expect(pushSpy).not.toHaveBeenCalled();
    // Still consumed (cleared) so it never fires on a later navigation.
    expect(sessionStorage.getItem("projections.post_signin_redirect")).toBeNull();
  });

  it("does not redirect when nothing was captured", () => {
    signedIn = true;
    const pushSpy = vi.spyOn(window.history, "pushState");
    render(
      <ClerkOwnerGate topBar={TOP_BAR} penny={PENNY}>
        <div data-testid="owner-content">owner page</div>
      </ClerkOwnerGate>,
    );
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The claim/bridge effect mounts inside the active <ClerkProvider>; the real Clerk
// SDK is mocked (vi.hoisted shares mutable state with the hoisted mock factory) so
// the test drives the signed-out→signed-in transition directly.
const auth = vi.hoisted(() => ({
  isSignedIn: false as boolean,
  getToken: vi.fn(async (): Promise<string | null> => "clerk-jwt-xyz"),
}));

vi.mock("@clerk/clerk-react", () => ({
  useAuth: () => ({ isSignedIn: auth.isSignedIn, getToken: auth.getToken }),
}));

import { ClaimLegacyOwnerToken } from "./ClaimLegacyOwnerToken";
import { OWNER_TOKEN_KEY } from "../api/projections";

type Captured = { url: string; init?: RequestInit };
let calls: Captured[];

beforeEach(() => {
  auth.isSignedIn = false;
  auth.getToken.mockResolvedValue("clerk-jwt-xyz");
  localStorage.clear();
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    calls.push({ url: String(input), init: init as RequestInit | undefined });
    return Promise.resolve(
      new Response(JSON.stringify({ linked: 1 }), { status: 200 }),
    );
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ClaimLegacyOwnerToken", () => {
  it("POSTs /claim with the Clerk JWT bearer + owner_token on first sign-in", async () => {
    localStorage.setItem(OWNER_TOKEN_KEY, "legacy-tok");
    auth.isSignedIn = true;
    render(<ClaimLegacyOwnerToken />);

    await waitFor(() => expect(calls).toHaveLength(1));
    const { url, init } = calls[0];
    expect(url).toContain("/api/projections/claim");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer clerk-jwt-xyz");
    expect(JSON.parse(String(init?.body))).toEqual({ owner_token: "legacy-tok" });
    // The owner_token is LEFT in localStorage — a harmless fallback, never cleared.
    expect(localStorage.getItem(OWNER_TOKEN_KEY)).toBe("legacy-tok");
  });

  it("does nothing when signed in but no legacy owner_token exists", async () => {
    auth.isSignedIn = true;
    render(<ClaimLegacyOwnerToken />);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("does nothing while signed out (a cookie/session never triggers a claim)", async () => {
    localStorage.setItem(OWNER_TOKEN_KEY, "legacy-tok");
    auth.isSignedIn = false;
    render(<ClaimLegacyOwnerToken />);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("fires at most once across re-renders (per-session ref guard)", async () => {
    localStorage.setItem(OWNER_TOKEN_KEY, "legacy-tok");
    auth.isSignedIn = true;
    const { rerender } = render(<ClaimLegacyOwnerToken />);
    await waitFor(() => expect(calls).toHaveLength(1));
    rerender(<ClaimLegacyOwnerToken />);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });
});

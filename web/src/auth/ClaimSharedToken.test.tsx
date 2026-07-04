import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// EPIC #323 — editable shares FOLLOW the Clerk account. On the first signed-out→
// signed-in transition, ClaimSharedToken walks every locally-stored per-projection
// edit token and POSTs (slug + token) to /claim-share with the Clerk JWT bearer so the
// server can mint a share_grant on the recipient's Clerk sub. The real Clerk SDK is
// mocked (vi.hoisted shares state with the hoisted mock factory).
const auth = vi.hoisted(() => ({
  isSignedIn: false as boolean,
  getToken: vi.fn(async (): Promise<string | null> => "clerk-jwt-xyz"),
}));

vi.mock("@clerk/clerk-react", () => ({
  useAuth: () => ({ isSignedIn: auth.isSignedIn, getToken: auth.getToken }),
}));

import { ClaimSharedToken } from "./ClaimSharedToken";
import { editTokenKey } from "../api/projections";

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
      new Response(JSON.stringify({ granted: true }), { status: 200 }),
    );
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ClaimSharedToken", () => {
  it("POSTs /claim-share for each stored edit token on first sign-in", async () => {
    localStorage.setItem(editTokenKey("slug-a"), "edit-a");
    localStorage.setItem(editTokenKey("slug-b"), "edit-b");
    auth.isSignedIn = true;
    render(<ClaimSharedToken />);

    await waitFor(() => expect(calls).toHaveLength(2));
    const byUrl = Object.fromEntries(calls.map((c) => [c.url, c]));
    const a = byUrl["/api/projections/slug-a/claim-share"];
    const b = byUrl["/api/projections/slug-b/claim-share"];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a.init?.method).toBe("POST");
    expect(new Headers(a.init?.headers).get("Authorization")).toBe("Bearer clerk-jwt-xyz");
    // The edit token rides the BODY only — never the URL path (Regression #10).
    expect(JSON.parse(String(a.init?.body))).toEqual({ edit_token: "edit-a" });
    expect(a.url).not.toContain("edit-a");
    // The tokens are LEFT in localStorage (harmless same-device fallback).
    expect(localStorage.getItem(editTokenKey("slug-a"))).toBe("edit-a");
  });

  it("does nothing when signed in but no edit tokens exist", async () => {
    auth.isSignedIn = true;
    render(<ClaimSharedToken />);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("does nothing while signed out (a cookie/session never triggers a claim)", async () => {
    localStorage.setItem(editTokenKey("slug-a"), "edit-a");
    auth.isSignedIn = false;
    render(<ClaimSharedToken />);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("fires at most once across re-renders (per-session ref guard)", async () => {
    localStorage.setItem(editTokenKey("slug-a"), "edit-a");
    auth.isSignedIn = true;
    const { rerender } = render(<ClaimSharedToken />);
    await waitFor(() => expect(calls).toHaveLength(1));
    rerender(<ClaimSharedToken />);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  it("ignores the owner_token key (only per-projection edit tokens are claimed)", async () => {
    localStorage.setItem("projections.owner_token", "owner-xyz");
    auth.isSignedIn = true;
    render(<ClaimSharedToken />);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setClerkTokenGetter } from "../auth/clerkToken";
import { authHeader } from "./authHeader";
import { setOwnerToken } from "./projections";

// WAVE 2 — the single owner auth-header helper, BOTH paths. When Clerk is active
// AND the owner is signed in, owner calls carry a short-lived Clerk session JWT
// (await getToken()) as Authorization: Bearer. Otherwise they carry the existing
// capability owner token from localStorage — so with Clerk OFF the behaviour is
// byte-for-byte the capability-token app of today.

beforeEach(() => {
  localStorage.clear();
  setClerkTokenGetter(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setClerkTokenGetter(null);
  localStorage.clear();
});

describe("authHeader — one helper, both paths", () => {
  it("returns no Authorization header when neither Clerk nor an owner token is present", async () => {
    expect(await authHeader()).toEqual({});
  });

  it("uses the capability owner token when Clerk is OFF (unchanged from today)", async () => {
    setOwnerToken("owner_abc");
    expect(await authHeader()).toEqual({ Authorization: "Bearer owner_abc" });
  });

  it("attaches the Clerk session JWT for owner calls when Clerk is active + signed in", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_abc");
    setClerkTokenGetter(async () => "clerk_jwt_123");
    // A legacy owner token may still be present — the Clerk session wins.
    setOwnerToken("owner_abc");
    expect(await authHeader()).toEqual({ Authorization: "Bearer clerk_jwt_123" });
  });

  it("falls back to the owner token when Clerk is active but signed out (getToken null)", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_abc");
    setClerkTokenGetter(async () => null);
    setOwnerToken("owner_abc");
    expect(await authHeader()).toEqual({ Authorization: "Bearer owner_abc" });
  });

  it("never throws if getToken() rejects — falls through to the owner token", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_abc");
    setClerkTokenGetter(async () => {
      throw new Error("network");
    });
    setOwnerToken("owner_abc");
    expect(await authHeader()).toEqual({ Authorization: "Bearer owner_abc" });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  capturePostSignInRedirect,
  takePostSignInRedirect,
} from "./postSignInRedirect";

// EPIC #323 — capture/replay of a shared deep link across the Clerk sign-in round-trip.
const KEY = "projections.post_signin_redirect";

beforeEach(() => sessionStorage.clear());
afterEach(() => sessionStorage.clear());

describe("postSignInRedirect", () => {
  it("captures a destination and replays it exactly once", () => {
    capturePostSignInRedirect("/p/abc/edit");
    expect(sessionStorage.getItem(KEY)).toBe("/p/abc/edit");
    expect(takePostSignInRedirect()).toBe("/p/abc/edit");
    // Cleared after the first take — fires once, never loops.
    expect(takePostSignInRedirect()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("returns null when nothing was captured", () => {
    expect(takePostSignInRedirect()).toBeNull();
  });

  it("overwrites a prior capture (latest shared link wins)", () => {
    capturePostSignInRedirect("/p/one/edit");
    capturePostSignInRedirect("/p/two/edit");
    expect(takePostSignInRedirect()).toBe("/p/two/edit");
  });
});

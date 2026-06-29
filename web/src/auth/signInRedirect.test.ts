import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signInRedirectTarget } from "./signInRedirect";

// SIGNIN-4 / Epic #318 follow-up — the satellite sign-in round-trip target. It is
// the current page MINUS any URL fragment, because a fragment is meaningless as a
// cross-apex redirect_url and (critically) edit/role share links carry their
// capability SECRET there — it must never ride into the primary's query/logs
// (Regression #10 / Override SESSION).

let originalLocation: Location;

function setHref(href: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, href },
  });
}

beforeEach(() => {
  originalLocation = window.location;
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
});

describe("signInRedirectTarget", () => {
  it("returns origin + path + query unchanged when there is no fragment", () => {
    setHref("https://projections.thriftly.com/wizard?step=2");
    expect(signInRedirectTarget()).toBe(
      "https://projections.thriftly.com/wizard?step=2",
    );
  });

  it("strips a fragment carrying a capability secret", () => {
    setHref("https://projections.thriftly.com/p/abc/edit#edit-token-SECRET");
    expect(signInRedirectTarget()).toBe(
      "https://projections.thriftly.com/p/abc/edit",
    );
  });

  it("strips a bare '#' fragment", () => {
    setHref("https://projections.thriftly.com/#");
    expect(signInRedirectTarget()).toBe("https://projections.thriftly.com/");
  });
});

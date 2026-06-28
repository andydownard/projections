import { afterEach, describe, expect, it, vi } from "vitest";

import { researchRent } from "./research";

// The typed POST /api/research client (feature #245). It only SHAPES the request
// and returns the server's grounded result verbatim — no client math, no key.

const VERIFIED = {
  rent_per_sqft: 11.0, estimate: 11.0, low: 9.0, high: 13.0,
  rent_type: "nnn", opex: 3.0, basis: "$/sq ft/yr",
  confidence: "high", verified: true, provenance: "verified",
  sources: [{ url: "https://x", title: "Listing", source_date: "2026-05", source_tier: "listing" }],
  ai_enabled: true, cached: false,
};

function jsonResponse(b: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("researchRent", () => {
  it("POSTs building_sqft as a string + the resolved location, returns the server body verbatim", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      captured = { url: String(input), body: JSON.parse(String(init?.body)) };
      return jsonResponse(VERIFIED);
    });

    const out = await researchRent({
      buildingSqft: 10000,
      location: { geography_name: "Longview city", formatted_address: "Longview, TX, USA" },
      basis: "nnn",
      token: "owner-tok",
    });

    expect(captured!.url).toContain("/api/research");
    expect(captured!.body.building_sqft).toBe("10000"); // server wants a string
    expect(captured!.body.basis).toBe("nnn");
    expect(captured!.body.location).toEqual({
      geography_name: "Longview city",
      formatted_address: "Longview, TX, USA",
    });
    expect(captured!.body.token).toBe("owner-tok");
    // returned verbatim — verified badge + sources are the SERVER's
    expect(out.rent_per_sqft).toBe(11.0);
    expect(out.verified).toBe(true);
    expect(out.sources[0].url).toBe("https://x");
  });

  it("defaults basis to nnn and omits an absent location/token", async () => {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(VERIFIED);
    });
    await researchRent({ buildingSqft: 8000, locationLabel: "Longview, TX" });
    expect(body.basis).toBe("nnn");
    expect(body.location_label).toBe("Longview, TX");
    expect("location" in body).toBe(false);
    expect("token" in body).toBe(false);
  });

  it("throws on a non-2xx (e.g. 429) so the caller can degrade to the manual benchmark", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      jsonResponse({ error: "rate_limited" }, 429),
    );
    await expect(researchRent({ buildingSqft: 10000, locationLabel: "X" })).rejects.toThrow();
  });
});

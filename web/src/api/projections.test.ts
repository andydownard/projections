import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OWNER_TOKEN_KEY,
  createProjection,
  getOwnerToken,
  listProjections,
  setOwnerToken,
} from "./projections";

// SLICE 2 — the owner-scoped list + create calls (API_SPEC §4.1/§4.2). The list is
// owner-scoped: it sends Authorization: Bearer <owner_token> (PRD §20, no global
// index). Create is anonymous and returns the freshly minted tokens, which the
// client stores in localStorage (owner token) — never recomputing anything.

describe("owner token storage", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips the owner token through localStorage", () => {
    expect(getOwnerToken()).toBeNull();
    setOwnerToken("owner_abc");
    expect(localStorage.getItem(OWNER_TOKEN_KEY)).toBe("owner_abc");
    expect(getOwnerToken()).toBe("owner_abc");
  });
});

describe("listProjections (owner-scoped)", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => localStorage.clear());

  it("GETs /api/projections with the owner bearer token", async () => {
    const body = {
      projections: [
        {
          view_slug: "p_8x",
          name: "House of Hope — Longview, TX",
          location: "Longview, TX",
          basis: "city",
          y1_revenue: { raw: 426911, display: "$426,911" },
          y1_net: { raw: 47100, display: "$47,100" },
          capital_required: { raw: 277990, display: "$277,990" },
          reco_tag: "proceed",
          status: "active",
          version: 7,
          updated_at: "2026-06-24T17:03:21Z",
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);
    setOwnerToken("owner_abc");

    const result = await listProjections();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projections",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer owner_abc" }),
      }),
    );
    expect(result.projections).toHaveLength(1);
    expect(result.projections[0].reco_tag).toBe("proceed");
  });

  it("returns an empty list (no owner token yet) without calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await listProjections();
    expect(result.projections).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createProjection", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => localStorage.clear());

  it("POSTs the payload and stores the minted owner token", async () => {
    const body = {
      view_slug: "p_NEW",
      name: "House of Hope",
      version: 1,
      tokens: {
        owner_token: "owner_minted",
        edit_token: "edit_minted",
        recovery_code: "REC-123",
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    const payload = {
      name: "House of Hope",
      location: { query: "Longview, TX" },
      trade_area: { basis: "city" as const, households: 31800 },
      inputs: {
        building_sqft: 10000,
        salesfloor_pct: 0.7,
        lease_type: "nnn" as const,
        donation_value: 74,
        occupancy_annual: 90000,
        demand: { mode: "market_share" as const, share_y1: 0.06, share_y2: 0.08, share_y3: 0.1 },
        source_of_funds: { cash: 150000, grant: 50000, loan: 0 },
      },
      terms_accepted: true,
    };

    const result = await createProjection(payload);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projections");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(payload);
    expect(result.view_slug).toBe("p_NEW");
    // The minted owner token is persisted so the list can be fetched next.
    expect(getOwnerToken()).toBe("owner_minted");
  });
});

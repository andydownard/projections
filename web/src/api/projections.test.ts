import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OWNER_TOKEN_KEY,
  getOwnerToken,
  listProjections,
  setOwnerToken,
} from "./projections";

// SLICE 2 — the owner-scoped list + owner-token storage (API_SPEC §4.1). The list is
// owner-scoped: it sends Authorization: Bearer <owner_token> (PRD §20, no global
// index). The minted owner token is stored in localStorage via setOwnerToken — never
// recomputing anything.

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
    // v2 list-item contract: income_series, y5_income, payback, breakeven.
    const body = {
      projections: [
        {
          view_slug: "p_8x",
          name: "House of Hope — Longview, TX",
          location: "Longview city",
          income_series: [
            { raw: -20000, display: "($20,000)" },
            { raw: 10000, display: "$10,000" },
            { raw: 30000, display: "$30,000" },
            { raw: 45000, display: "$45,000" },
            { raw: 60000, display: "$60,000" },
          ],
          y5_income: { raw: 60000, display: "$60,000" },
          capital_required: { raw: 277990, display: "$277,990" },
          payback: { raw: 25, display: "Month 25" },
          breakeven: { raw: 5, display: "Month 5" },
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
    expect(result.projections[0].capital_required.display).toBe("$277,990");
    expect(result.projections[0].payback.display).toBe("Month 25");
    expect(result.projections[0].income_series).toHaveLength(5);
  });

  it("returns an empty list (no owner token yet) without calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await listProjections();
    expect(result.projections).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("listProjections — error path", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => localStorage.clear());

  it("throws an API error when the owner-scoped GET is not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);
    setOwnerToken("owner_abc");

    await expect(listProjections()).rejects.toThrow("API 401: /projections");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

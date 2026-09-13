import { afterEach, describe, expect, it, vi } from "vitest";

import { duplicateProjection, listProjections } from "./projections";

// SLICE 2 — the global projections list (API_SPEC §4.1). This project has no
// authentication (owner decision, 2026-09-13): the list is GLOBAL, no token, no
// owner scoping.

describe("listProjections (global)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("GETs /api/projections", async () => {
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

    const result = await listProjections();
    expect(fetchMock).toHaveBeenCalledWith("/api/projections", expect.anything());
    expect(result.projections).toHaveLength(1);
    expect(result.projections[0].capital_required.display).toBe("$277,990");
    expect(result.projections[0].payback.display).toBe("Month 25");
    expect(result.projections[0].income_series).toHaveLength(5);
  });
});

// The real "Save as copy": POST …/{slug}/duplicate carrying the conflicted edit as
// {patch}, so the fork is born with the user's unsaved change (never dropped).
describe("duplicateProjection (409 Save-as-copy)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs …/{slug}/duplicate with {patch} and returns the new copy", async () => {
    const created = {
      view_slug: "p_copy",
      version: 1,
      name: "House of Hope (copy)",
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => created });
    vi.stubGlobal("fetch", fetchMock);

    const patch = { assumptions: { labor_pct: 0.45 } };
    const out = await duplicateProjection("p_8x", patch);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projections/p_8x/duplicate");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ patch });
    expect(out.view_slug).toBe("p_copy");
  });

  it("omits the patch envelope for a verbatim copy (no conflicted edit)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ view_slug: "p_copy", version: 1, name: "x (copy)" }) });
    vi.stubGlobal("fetch", fetchMock);
    await duplicateProjection("p_8x");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({});
  });

  it("throws on a non-ok duplicate so the caller can surface retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(duplicateProjection("p_8x")).rejects.toThrow(/403/);
  });
});

describe("listProjections — error path", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws an API error when the GET is not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listProjections()).rejects.toThrow("API 500: /projections");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OWNER_TOKEN_KEY,
  duplicateProjection,
  editTokenKey,
  getEditToken,
  getOwnerToken,
  listEditTokenEntries,
  listProjections,
  setEditToken,
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

// EPIC SHARE — the per-projection edit token (the editable share link's capability).
// Same secrecy posture as the owner token: localStorage only, never a URL path/query.
describe("edit token storage (EPIC SHARE)", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips the edit token per view_slug", () => {
    expect(getEditToken("p_8x")).toBeNull();
    setEditToken("p_8x", "edit_secret_abc");
    expect(localStorage.getItem(editTokenKey("p_8x"))).toBe("edit_secret_abc");
    expect(getEditToken("p_8x")).toBe("edit_secret_abc");
  });

  it("keeps each projection's edit token isolated by slug", () => {
    setEditToken("p_8x", "edit_8x");
    setEditToken("p_9y", "edit_9y");
    expect(getEditToken("p_8x")).toBe("edit_8x");
    expect(getEditToken("p_9y")).toBe("edit_9y");
    expect(getEditToken("p_unknown")).toBeNull();
  });

  // EPIC #323 — listEditTokenEntries powers the ClaimSharedToken bridge.
  it("listEditTokenEntries returns every stored (slug, token), ignoring other keys", () => {
    setEditToken("p_8x", "edit_8x");
    setEditToken("p_9y", "edit_9y");
    setOwnerToken("owner_should_be_ignored");
    localStorage.setItem("unrelated.key", "nope");
    const entries = listEditTokenEntries().sort((a, b) =>
      a.viewSlug.localeCompare(b.viewSlug),
    );
    expect(entries).toEqual([
      { viewSlug: "p_8x", token: "edit_8x" },
      { viewSlug: "p_9y", token: "edit_9y" },
    ]);
  });

  it("listEditTokenEntries is empty when no edit tokens are stored", () => {
    setOwnerToken("owner_only");
    expect(listEditTokenEntries()).toEqual([]);
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

// The real "Save as copy": POST …/{slug}/duplicate carrying the conflicted edit as
// {patch}, so the fork is born with the user's unsaved change (never dropped).
describe("duplicateProjection (409 Save-as-copy)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs …/{slug}/duplicate with the owner Bearer + {patch} and returns the new copy", async () => {
    const created = {
      view_slug: "p_copy",
      version: 1,
      name: "House of Hope (copy)",
      edit_token: "edit_copy",
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => created });
    vi.stubGlobal("fetch", fetchMock);

    const patch = { assumptions: { labor_pct: 0.45 } };
    const out = await duplicateProjection("p_8x", "owner_abc", patch);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projections/p_8x/duplicate");
    expect((init as RequestInit).method).toBe("POST");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Bearer owner_abc");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ patch });
    // The token never leaks into the URL (PRD §20).
    expect(String(url)).not.toContain("owner_abc");
    expect(out.view_slug).toBe("p_copy");
    expect(out.edit_token).toBe("edit_copy");
  });

  it("omits the patch envelope for a verbatim copy (no conflicted edit)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ view_slug: "p_copy", version: 1, name: "x (copy)" }) });
    vi.stubGlobal("fetch", fetchMock);
    await duplicateProjection("p_8x", "owner_abc");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({});
  });

  it("throws on a non-ok duplicate (e.g. 403 owner-only) so the caller can surface retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(duplicateProjection("p_8x", "owner_abc")).rejects.toThrow(/403/);
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LifecycleConflictError,
  listTrashed,
  purgeProjection,
  restoreProjection,
  setOwnerToken,
  trashProjection,
} from "./projections";

// Lifecycle mutations (trash / restore / purge) + the Trash list (API_SPEC §4.8).
// Owner-only: every call carries Authorization: Bearer <owner_token> + If-Match.
// A 409 surfaces as a typed LifecycleConflictError. The token never appears in the
// URL path/query — only the Authorization header (Regression #10).

function etagResponse(version: number) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k === "ETag" ? String(version) : null) },
    json: async () => ({ version }),
  };
}

describe("trashProjection", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => localStorage.clear());

  it("POSTs /trash with the owner bearer + If-Match and returns the new version", async () => {
    const fetchMock = vi.fn().mockResolvedValue(etagResponse(8));
    vi.stubGlobal("fetch", fetchMock);
    setOwnerToken("owner_abc");

    const version = await trashProjection({ viewSlug: "p_8x", version: 7 });
    expect(version).toBe(8);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projections/p_8x/trash",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer owner_abc",
          "If-Match": "7",
        }),
      }),
    );
    // The secret never rides the URL.
    expect(fetchMock.mock.calls[0][0]).not.toContain("owner_abc");
  });

  it("throws LifecycleConflictError carrying current_version on 409", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ detail: { error: "version_conflict", current_version: 9 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    setOwnerToken("owner_abc");

    await expect(trashProjection({ viewSlug: "p_8x", version: 7 })).rejects.toBeInstanceOf(
      LifecycleConflictError,
    );
  });

  it("throws owner_required when no owner identity is on this device", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(trashProjection({ viewSlug: "p_8x", version: 1 })).rejects.toThrow(
      "owner_required",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("restoreProjection", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => localStorage.clear());

  it("POSTs /restore with If-Match and returns the new version", async () => {
    const fetchMock = vi.fn().mockResolvedValue(etagResponse(3));
    vi.stubGlobal("fetch", fetchMock);
    setOwnerToken("owner_abc");

    const version = await restoreProjection({ viewSlug: "p_8x", version: 2 });
    expect(version).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projections/p_8x/restore",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("falls back to the body version when no ETag header is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ version: 6 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    setOwnerToken("owner_abc");
    expect(await restoreProjection({ viewSlug: "p_8x", version: 5 })).toBe(6);
  });

  it("throws LifecycleConflictError on a stale 409", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ detail: { error: "version_conflict", current_version: 4 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    setOwnerToken("owner_abc");
    await expect(restoreProjection({ viewSlug: "p_8x", version: 2 })).rejects.toBeInstanceOf(
      LifecycleConflictError,
    );
  });

  it("throws a generic API error on a non-409 failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    setOwnerToken("owner_abc");
    await expect(restoreProjection({ viewSlug: "p_8x", version: 2 })).rejects.toThrow("API 500");
  });
});

describe("purgeProjection", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => localStorage.clear());

  it("DELETEs the projection with If-Match (204, no body)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: { get: () => null },
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    setOwnerToken("owner_abc");

    await expect(purgeProjection({ viewSlug: "p_8x", version: 2 })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projections/p_8x",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "If-Match": "2" }),
      }),
    );
  });

  it("throws LifecycleConflictError on a stale 409 (nothing erased)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ detail: { error: "version_conflict" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    setOwnerToken("owner_abc");
    await expect(purgeProjection({ viewSlug: "p_8x", version: 1 })).rejects.toBeInstanceOf(
      LifecycleConflictError,
    );
  });
});

describe("listTrashed", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => localStorage.clear());

  it("GETs /api/projections?trashed=true with the owner bearer", async () => {
    const body = { projections: [{ view_slug: "p_x", status: "trashed" }] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);
    setOwnerToken("owner_abc");

    const result = await listTrashed();
    expect(result.projections).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projections?trashed=true",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer owner_abc" }),
      }),
    );
  });

  it("returns an empty list without calling the server when there is no owner", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await listTrashed();
    expect(result.projections).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LifecycleConflictError,
  listTrashed,
  purgeProjection,
  restoreProjection,
  trashProjection,
} from "./projections";

// Lifecycle mutations (trash / restore / purge) + the Trash list (API_SPEC §4.8).
// This project has no authentication (owner decision, 2026-09-13): every call
// carries only If-Match (optimistic concurrency). A 409 surfaces as a typed
// LifecycleConflictError.

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

  it("POSTs /trash with If-Match and returns the new version", async () => {
    const fetchMock = vi.fn().mockResolvedValue(etagResponse(8));
    vi.stubGlobal("fetch", fetchMock);

    const version = await trashProjection({ viewSlug: "p_8x", version: 7 });
    expect(version).toBe(8);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projections/p_8x/trash",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "If-Match": "7" }),
      }),
    );
  });

  it("throws LifecycleConflictError carrying current_version on 409", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ detail: { error: "version_conflict", current_version: 9 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(trashProjection({ viewSlug: "p_8x", version: 7 })).rejects.toBeInstanceOf(
      LifecycleConflictError,
    );
  });
});

describe("restoreProjection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs /restore with If-Match and returns the new version", async () => {
    const fetchMock = vi.fn().mockResolvedValue(etagResponse(3));
    vi.stubGlobal("fetch", fetchMock);

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
    expect(await restoreProjection({ viewSlug: "p_8x", version: 5 })).toBe(6);
  });

  it("throws LifecycleConflictError on a stale 409", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ detail: { error: "version_conflict", current_version: 4 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
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
    await expect(restoreProjection({ viewSlug: "p_8x", version: 2 })).rejects.toThrow("API 500");
  });
});

describe("purgeProjection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("DELETEs the projection with If-Match (204, no body)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: { get: () => null },
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

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
    await expect(purgeProjection({ viewSlug: "p_8x", version: 1 })).rejects.toBeInstanceOf(
      LifecycleConflictError,
    );
  });
});

describe("listTrashed", () => {
  afterEach(() => vi.restoreAllMocks());

  it("GETs /api/projections?trashed=true", async () => {
    const body = { projections: [{ view_slug: "p_x", status: "trashed" }] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listTrashed();
    expect(result.projections).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projections?trashed=true",
      expect.anything(),
    );
  });
});

// web/src/api/patch.test.ts — SLICE 4: the autosave PATCH client.
//
// Every mutation carries Authorization: Bearer <token> + If-Match: <version>
// (API_SPEC §1.3, CLAUDE.md hard rule). The client reads the new version from the
// ETag header and parses the 409 conflict body (API_SPEC §1.4) into a typed
// result the autosave reducer can act on. No client-side math (PRD §13): the body
// is a partial of the editable surface; the response view-model is rendered as-is.
import { afterEach, describe, expect, it, vi } from "vitest";

import { patchProjection, PatchConflictError } from "./patch";

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  const fn = vi.fn((url: string, init: RequestInit) => Promise.resolve(impl(url, init)));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonResponse(body: unknown, init: { status: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(body), {
    status: init.status,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("patchProjection — mutation headers (API_SPEC §1.3)", () => {
  it("sends Authorization: Bearer and If-Match: <version> with the partial body", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ version: 8, settings: {} }, { status: 200, headers: { ETag: '"8"' } }),
    );
    await patchProjection({
      viewSlug: "p_abc",
      token: "owner-tok",
      version: 7,
      body: { assumptions: { labor_pct: 0.45 } },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projections/p_abc");
    expect(init.method).toBe("PATCH");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer owner-tok");
    expect(headers.get("If-Match")).toBe("7");
    expect(JSON.parse(init.body as string)).toEqual({ assumptions: { labor_pct: 0.45 } });
  });

  it("never puts the token in the URL (path/query) — fragment/header only (PRD §20)", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ version: 8 }, { status: 200, headers: { ETag: '"8"' } }),
    );
    await patchProjection({ viewSlug: "p_abc", token: "secret", version: 7, body: {} });
    const [url] = fetchMock.mock.calls[0];
    expect(url).not.toContain("secret");
  });

  it("returns the new version from the ETag header on success", async () => {
    mockFetch(() =>
      jsonResponse({ version: 8, settings: {} }, { status: 200, headers: { ETag: '"8"' } }),
    );
    const result = await patchProjection({
      viewSlug: "p_abc",
      token: "t",
      version: 7,
      body: {},
    });
    expect(result.version).toBe(8);
    expect(result.viewModel).toBeDefined();
  });
});

describe("patchProjection — 409 conflict (API_SPEC §1.4)", () => {
  it("throws a typed PatchConflictError carrying the full conflict body", async () => {
    const conflict = {
      error: "version_conflict",
      message: "This projection changed since you loaded it.",
      current_version: 9,
      your_version: 7,
      current_state: { settings: {} },
      recovery: ["reload", "overwrite", "save_as_copy"],
    };
    mockFetch(() => jsonResponse(conflict, { status: 409 }));
    await expect(
      patchProjection({ viewSlug: "p_abc", token: "t", version: 7, body: {} }),
    ).rejects.toBeInstanceOf(PatchConflictError);

    try {
      await patchProjection({ viewSlug: "p_abc", token: "t", version: 7, body: {} });
    } catch (e) {
      const err = e as PatchConflictError;
      expect(err.conflict.current_version).toBe(9);
      expect(err.conflict.your_version).toBe(7);
      expect(err.conflict.recovery).toContain("save_as_copy");
    }
  });

  it("throws a plain Error (not a conflict) on other failures so the reducer shows retry", async () => {
    mockFetch(() => jsonResponse({ error: "server" }, { status: 500 }));
    await expect(
      patchProjection({ viewSlug: "p_abc", token: "t", version: 7, body: {} }),
    ).rejects.not.toBeInstanceOf(PatchConflictError);
  });
});

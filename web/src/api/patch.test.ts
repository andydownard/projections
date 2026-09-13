// web/src/api/patch.test.ts — SLICE 4: the autosave PATCH client.
//
// This project has no authentication (owner decision, 2026-09-13). Every mutation
// still carries If-Match: <version> (API_SPEC §1.3) — optimistic concurrency,
// unrelated to auth. The client reads the new version from the ETag header and
// parses the 409 conflict body (API_SPEC §1.4) into a typed result the autosave
// reducer can act on. No client-side math (PRD §13): the body is a partial of the
// editable surface; the response view-model is rendered as-is.
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
  it("sends If-Match: <version> with the partial body", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ version: 8, settings: {} }, { status: 200, headers: { ETag: '"8"' } }),
    );
    await patchProjection({
      viewSlug: "p_abc",
      version: 7,
      body: { assumptions: { labor_pct: 0.45 } },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projections/p_abc");
    expect(init.method).toBe("PATCH");
    const headers = new Headers(init.headers);
    expect(headers.get("If-Match")).toBe("7");
    expect(JSON.parse(init.body as string)).toEqual({ assumptions: { labor_pct: 0.45 } });
  });

  it("returns the new version from the ETag header on success", async () => {
    mockFetch(() =>
      jsonResponse({ version: 8, settings: {} }, { status: 200, headers: { ETag: '"8"' } }),
    );
    const result = await patchProjection({
      viewSlug: "p_abc",
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
      patchProjection({ viewSlug: "p_abc", version: 7, body: {} }),
    ).rejects.toBeInstanceOf(PatchConflictError);

    try {
      await patchProjection({ viewSlug: "p_abc", version: 7, body: {} });
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
      patchProjection({ viewSlug: "p_abc", version: 7, body: {} }),
    ).rejects.not.toBeInstanceOf(PatchConflictError);
  });

  // The 409 modal's Overwrite/Save-as-copy must replay the EXACT body the stale write
  // carried — not just {name} (the audited P0: a conflicting settings edit was lost).
  // So the conflict error carries `failedBody` = the PATCH body that just 409'd.
  it("carries the exact failed PATCH body on the conflict error (Overwrite/Save-as-copy replay)", async () => {
    mockFetch(() =>
      jsonResponse(
        { detail: { error: "version_conflict", current_version: 9, your_version: 7 } },
        { status: 409 },
      ),
    );
    const body = { assumptions: { labor_pct: 0.45 } };
    try {
      await patchProjection({ viewSlug: "p_abc", version: 7, body });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PatchConflictError);
      expect((e as PatchConflictError).failedBody).toEqual(body);
    }
  });

  // #188 — the LIVE server raises 409 via FastAPI `HTTPException(detail={...})`,
  // which serializes as `{"detail": {...}}` (NOT the flat body the old mock used).
  // The client must read the nested envelope or `current_version` is undefined and
  // the Overwrite path re-sends the STALE If-Match → the owner can never force-save.
  it("parses the nested {detail:{…}} conflict envelope the live server emits", async () => {
    const envelope = {
      detail: {
        error: "version_conflict",
        current_version: 9,
        your_version: 7,
        current_state: { settings: {}, version: 9 },
        // server emits recovery as a STRING ("reload | overwrite | save_as_copy")
        recovery: "reload | overwrite | save_as_copy",
      },
    };
    mockFetch(() => jsonResponse(envelope, { status: 409 }));
    try {
      await patchProjection({ viewSlug: "p_abc", version: 7, body: { name: "x" } });
      throw new Error("should have thrown a PatchConflictError");
    } catch (e) {
      expect(e).toBeInstanceOf(PatchConflictError);
      const err = e as PatchConflictError;
      // The fields the Overwrite/Reload recovery relies on must survive the parse.
      expect(err.conflict.current_version).toBe(9);
      expect(err.conflict.your_version).toBe(7);
      expect((err.conflict.current_state as { version?: number }).version).toBe(9);
    }
  });
});

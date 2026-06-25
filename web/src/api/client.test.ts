import { afterEach, describe, expect, it, vi } from "vitest";

import { api, formatFromServer, NO_CLIENT_MATH, type ServerValue } from "./client";

// M2.3 — the typed client + the no-client-math contract. The server is the single
// math AND formatting authority ({raw, display}); the client renders `display`
// verbatim and never re-derives money/percent strings.

describe("formatFromServer (single formatting authority)", () => {
  it("returns the server display string unchanged for positive money", () => {
    expect(formatFromServer({ raw: 426911, display: "$426,911" })).toBe("$426,911");
  });

  it("returns the server display string unchanged for negative money (parentheses)", () => {
    expect(formatFromServer({ raw: -12400, display: "($12,400)" })).toBe("($12,400)");
  });

  it("returns the server display string unchanged for percents", () => {
    expect(formatFromServer({ raw: 0.11, display: "11.0%" })).toBe("11.0%");
  });

  it("never re-derives from raw (a wrong display still passes through)", () => {
    // This proves the client does NOT compute: even an intentionally-wrong display
    // is rendered verbatim — formatting is the server's job, not the client's.
    const v: ServerValue = { raw: 100, display: "SERVER-OWNED" };
    expect(formatFromServer(v)).toBe("SERVER-OWNED");
  });
});

describe("no-client-math marker", () => {
  it("is exported so a build guard can assert it", () => {
    expect(NO_CLIENT_MATH).toBe(true);
  });
});

describe("api.health", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls GET /api/health and returns the parsed body", async () => {
    const body = {
      status: "ok",
      build_sha: "abc123",
      model_version: "2.0.0",
      db: "connected",
      litestream: "replicating",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.health();
    expect(fetchMock).toHaveBeenCalledWith("/api/health", expect.objectContaining({ headers: expect.any(Object) }));
    expect(result).toEqual(body);
  });

  it("throws on a non-ok response (no silent failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    await expect(api.health()).rejects.toThrow(/503/);
  });
});

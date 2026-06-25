// web/src/api/narrative.test.ts — epic-N N7: the narrative GET/PUT client.
//
// GET …/narrative returns stored prose + staleness + the server-built
// grounded_figures (API_SPEC §6.1). PUT saves user-edited body_md and carries
// Authorization: Bearer + If-Match (every mutation, API_SPEC §1.3) — the token
// travels ONLY in the header, never the URL (PRD §20). A 409 grounding_failed is
// surfaced as a typed error carrying the ungrounded figures so the editor can
// flag the offending tokens without re-deriving figures client-side.
import { afterEach, describe, expect, it, vi } from "vitest";

import { getNarrative, putNarrative, GroundingFailedError } from "./narrative";

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

const GET_BODY = {
  body_md: "<p>The store needs <strong>$277,990</strong> in capital.</p>",
  edited: true,
  edit_origin: "human",
  computed_hash: "sha256:abc",
  stale: false,
  stale_diff: [],
  grounded_figures: [
    { raw: 277990, display: "$277,990", variants: ["$277,990", "$278k"] },
  ],
  ai_disabled: false,
  updated_at: "2026-06-24T00:00:00Z",
};

describe("getNarrative", () => {
  it("fetches stored prose + staleness + grounded figures", async () => {
    mockFetch(() => jsonResponse(GET_BODY, { status: 200 }));
    const n = await getNarrative({ viewSlug: "p_abc" });
    expect(n.body_md).toContain("$277,990");
    expect(n.edited).toBe(true);
    expect(n.stale).toBe(false);
    expect(n.grounded_figures[0].variants).toContain("$278k");
  });

  it("surfaces stale + the was->now diff", async () => {
    mockFetch(() =>
      jsonResponse(
        { ...GET_BODY, stale: true, stale_diff: [{ field: "capital", was: "$262,400", now: "$277,990" }] },
        { status: 200 },
      ),
    );
    const n = await getNarrative({ viewSlug: "p_abc" });
    expect(n.stale).toBe(true);
    expect(n.stale_diff[0]).toMatchObject({ was: "$262,400", now: "$277,990" });
  });
});

describe("putNarrative — mutation headers (API_SPEC §1.3)", () => {
  it("sends Authorization: Bearer + If-Match and the body_md, never the token in the URL", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse(
        { body_md: "<p>ok</p>", edited: true, edit_origin: "human", computed_hash: "sha256:x" },
        { status: 200 },
      ),
    );
    await putNarrative({ viewSlug: "p_abc", token: "edit-secret", version: 4, bodyMd: "<p>ok</p>" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projections/p_abc/narrative");
    expect(url).not.toContain("edit-secret");
    expect(init.method).toBe("PUT");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer edit-secret");
    expect(headers.get("If-Match")).toBe("4");
    expect(JSON.parse(init.body as string)).toEqual({ body_md: "<p>ok</p>" });
  });

  it("returns the sanitized stored body + edited flag", async () => {
    mockFetch(() =>
      jsonResponse(
        { body_md: "<p>clean</p>", edited: true, edit_origin: "human", computed_hash: "sha256:x" },
        { status: 200 },
      ),
    );
    const r = await putNarrative({ viewSlug: "p_abc", token: "t", version: 1, bodyMd: "<p>x</p>" });
    expect(r.body_md).toBe("<p>clean</p>");
    expect(r.edited).toBe(true);
  });

  it("throws GroundingFailedError with the ungrounded figures on 409 grounding_failed", async () => {
    mockFetch(() =>
      jsonResponse(
        { detail: { error: "grounding_failed", ungrounded_figures: ["$310,000"] } },
        { status: 409 },
      ),
    );
    await expect(
      putNarrative({ viewSlug: "p_abc", token: "t", version: 1, bodyMd: "<p>$310,000</p>" }),
    ).rejects.toBeInstanceOf(GroundingFailedError);
    try {
      await putNarrative({ viewSlug: "p_abc", token: "t", version: 1, bodyMd: "<p>$310,000</p>" });
    } catch (e) {
      expect((e as GroundingFailedError).ungroundedFigures).toContain("$310,000");
    }
  });
});

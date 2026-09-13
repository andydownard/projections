// web/src/api/penny.draft.test.ts — PE8: the POST /api/penny/draft client
// (API_SPEC §12, Spec B §5.2/§12).
//
// The wizard-draft variant of Penny runs the SAME server-side tool-use loop, but
// acts on the supplied in-memory `draft_state` (there is no projection yet) and
// PERSISTS NOTHING — no transcript row, no revision, no projection (Spec §7). This
// project has no authentication (owner decision, 2026-09-13): the client only
// sends { message, draft_state, proposal_ref? }; it renders the server's
// { draft, narration, provider, applied } verbatim and computes NOTHING (the
// returned draft is mapped straight onto the wizard fields).
//
// Errors are CLASSIFIED with the SAME PennyError taxonomy as the saved-projection
// endpoint (409 ai_disabled, 503 ai_unavailable, 429 rate_limited, 422 rejected,
// else unknown) so the UI maps a kind → friendly copy (issue #125).
import { afterEach, describe, expect, it, vi } from "vitest";

import { PennyError, sendPennyDraftMessage } from "./penny";

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

const DRAFT_STATE = {
  name: "House of Hope",
  inputs: { city: "Dallas, TX", org_name: "House of Hope", opening_month_number: 1 },
  assumptions: { share_y1: "6", share_y2: "8", share_y3: "10" },
  trade_area: { households: "512000" },
  cost_schedule: [],
};

const OK = {
  draft: {
    ...DRAFT_STATE,
    assumptions: { ...DRAFT_STATE.assumptions, share_y1: "8" },
  },
  narration: "Done. Year-1 share is now 8%.",
  provider: "anthropic",
  applied: [
    {
      tool: "set_assumption",
      version: null,
      actor: "penny",
      changed: [{ field: "share_y1", was: "6", now: "8" }],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendPennyDraftMessage — request shape (API_SPEC §12)", () => {
  it("POSTs to /api/penny/draft with { message, draft_state }", async () => {
    const fetchMock = mockFetch(() => jsonResponse(OK, { status: 200 }));
    await sendPennyDraftMessage({
      message: "Set Year-1 share to 8%",
      draftState: DRAFT_STATE,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/penny/draft");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      message: "Set Year-1 share to 8%",
      draft_state: DRAFT_STATE,
    });
  });

  it("includes proposal_ref only when provided", async () => {
    const fetchMock = mockFetch(() => jsonResponse(OK, { status: 200 }));
    await sendPennyDraftMessage({
      message: "use this proposal",
      draftState: DRAFT_STATE,
      proposalRef: "prop_9",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      message: "use this proposal",
      proposal_ref: "prop_9",
    });
  });

  it("forwards the AbortSignal so an in-flight draft turn can be stopped", async () => {
    const fetchMock = mockFetch(() => jsonResponse(OK, { status: 200 }));
    const controller = new AbortController();
    await sendPennyDraftMessage({
      message: "hi",
      draftState: {},
      signal: controller.signal,
    });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("returns the parsed { draft, narration, provider, applied }", async () => {
    mockFetch(() => jsonResponse(OK, { status: 200 }));
    const res = await sendPennyDraftMessage({ message: "hi", draftState: DRAFT_STATE });
    expect(res.provider).toBe("anthropic");
    expect(res.narration).toBe("Done. Year-1 share is now 8%.");
    expect(res.applied[0].changed[0]).toEqual({ field: "share_y1", was: "6", now: "8" });
    expect((res.draft.assumptions as Record<string, unknown>).share_y1).toBe("8");
  });
});

describe("sendPennyDraftMessage — error classification (Spec B §8/§11)", () => {
  it("classifies 409 as ai_disabled (opt-out → zero provider calls)", async () => {
    mockFetch(() => jsonResponse({ error: "ai_disabled" }, { status: 409 }));
    await expect(
      sendPennyDraftMessage({ message: "hi", draftState: {} }),
    ).rejects.toMatchObject({ kind: "ai_disabled", status: 409 });
  });

  it("classifies 503 as ai_unavailable", async () => {
    mockFetch(() => jsonResponse({ error: "ai_unavailable" }, { status: 503 }));
    await expect(
      sendPennyDraftMessage({ message: "hi", draftState: {} }),
    ).rejects.toMatchObject({ kind: "ai_unavailable", status: 503 });
  });

  it("classifies 429 as rate_limited and carries retry_after_seconds", async () => {
    mockFetch(() =>
      jsonResponse({ error: "rate_limited", retry_after_seconds: 30 }, { status: 429 }),
    );
    try {
      await sendPennyDraftMessage({ message: "hi", draftState: {} });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as PennyError;
      expect(err.kind).toBe("rate_limited");
      expect(err.retryAfterSeconds).toBe(30);
    }
  });

  it("classifies 422 as rejected and relays the server message", async () => {
    mockFetch(() =>
      jsonResponse(
        { error: "figure_stripped", message: "I can only apply a raw input value." },
        { status: 422 },
      ),
    );
    try {
      await sendPennyDraftMessage({ message: "set net profit to $9", draftState: {} });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as PennyError;
      expect(err.kind).toBe("rejected");
      expect(err.serverMessage).toMatch(/raw input value/i);
    }
  });

  it("classifies any other non-2xx as unknown (never a bare crash)", async () => {
    mockFetch(() => jsonResponse({ error: "forbidden" }, { status: 403 }));
    await expect(
      sendPennyDraftMessage({ message: "hi", draftState: {} }),
    ).rejects.toMatchObject({ kind: "unknown", status: 403 });
  });

  it("PennyError is a real Error instance (so callers can catch it)", async () => {
    mockFetch(() => jsonResponse({ error: "ai_disabled" }, { status: 409 }));
    await expect(
      sendPennyDraftMessage({ message: "hi", draftState: {} }),
    ).rejects.toBeInstanceOf(PennyError);
  });
});

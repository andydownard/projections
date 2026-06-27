// web/src/api/penny.test.ts — PE6: the POST …/penny client (API_SPEC §12, Spec B).
//
// Penny is another input device for the SAME server-authoritative mutation path:
// the client only sends the user's message + Bearer; the tool-use loop runs
// server-side and any edit is applied via the normal PATCH/If-Match path (so the
// version bumps + an actor:penny revision is produced as a side effect). The
// client computes NOTHING — it relays the message and renders the server's
// { turns_appended, provider, applied_revisions, narration } verbatim.
//
// Errors are CLASSIFIED here (not formatted): 409 ai_disabled, 503 ai_unavailable,
// 429 rate_limited (+retry_after_seconds), 422 a relayed rejection. The UI maps a
// kind → friendly copy so chat is never the only path (issue #125).
import { afterEach, describe, expect, it, vi } from "vitest";

import { PennyError, sendPennyMessage } from "./penny";

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

const OK = {
  turns_appended: [
    { id: "t1", role: "user", content: "Set Year-1 share to 8%" },
    { id: "t2", role: "assistant", content: "I'll set the donor-market share to 8% for Year 1." },
  ],
  provider: "anthropic",
  applied_revisions: ["rev_2"],
  narration: "Done. Year-1 share is now 8%.",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendPennyMessage — request shape (API_SPEC §12)", () => {
  it("POSTs to …/penny with Authorization: Bearer and the message body", async () => {
    const fetchMock = mockFetch(() => jsonResponse(OK, { status: 200 }));
    await sendPennyMessage({ viewSlug: "p_abc", token: "edit-tok", message: "Lower the rent" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projections/p_abc/penny");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer edit-tok");
    expect(JSON.parse(init.body as string)).toEqual({ message: "Lower the rent" });
  });

  it("never puts the token in the URL (path/query) — header only (PRD §20)", async () => {
    const fetchMock = mockFetch(() => jsonResponse(OK, { status: 200 }));
    await sendPennyMessage({ viewSlug: "p_abc", token: "secret-token", message: "hi" });
    const [url] = fetchMock.mock.calls[0];
    expect(url).not.toContain("secret-token");
  });

  it("includes proposal_ref only when provided", async () => {
    const fetchMock = mockFetch(() => jsonResponse(OK, { status: 200 }));
    await sendPennyMessage({
      viewSlug: "p_abc",
      token: "t",
      message: "use this proposal",
      proposalRef: "prop_9",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      message: "use this proposal",
      proposal_ref: "prop_9",
    });
  });

  it("forwards the AbortSignal so an in-flight turn can be stopped", async () => {
    const fetchMock = mockFetch(() => jsonResponse(OK, { status: 200 }));
    const controller = new AbortController();
    await sendPennyMessage({
      viewSlug: "p_abc",
      token: "t",
      message: "hi",
      signal: controller.signal,
    });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("returns the parsed { turns_appended, provider, applied_revisions, narration }", async () => {
    mockFetch(() => jsonResponse(OK, { status: 200 }));
    const res = await sendPennyMessage({ viewSlug: "p_abc", token: "t", message: "hi" });
    expect(res.provider).toBe("anthropic");
    expect(res.applied_revisions).toEqual(["rev_2"]);
    expect(res.narration).toBe("Done. Year-1 share is now 8%.");
    expect(res.turns_appended).toHaveLength(2);
  });
});

describe("sendPennyMessage — error classification (Spec B §8/§11)", () => {
  it("classifies 409 as ai_disabled", async () => {
    mockFetch(() => jsonResponse({ error: "ai_disabled" }, { status: 409 }));
    await expect(
      sendPennyMessage({ viewSlug: "p", token: "t", message: "hi" }),
    ).rejects.toMatchObject({ kind: "ai_disabled", status: 409 });
  });

  it("classifies 503 as ai_unavailable", async () => {
    mockFetch(() => jsonResponse({ error: "ai_unavailable" }, { status: 503 }));
    await expect(
      sendPennyMessage({ viewSlug: "p", token: "t", message: "hi" }),
    ).rejects.toMatchObject({ kind: "ai_unavailable", status: 503 });
  });

  it("classifies 429 as rate_limited and carries retry_after_seconds", async () => {
    mockFetch(() =>
      jsonResponse({ error: "rate_limited", retry_after_seconds: 30 }, { status: 429 }),
    );
    try {
      await sendPennyMessage({ viewSlug: "p", token: "t", message: "hi" });
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
        { error: "node_not_pinnable", message: "Net profit is a total I can't pin." },
        { status: 422 },
      ),
    );
    try {
      await sendPennyMessage({ viewSlug: "p", token: "t", message: "pin net profit" });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as PennyError;
      expect(err.kind).toBe("rejected");
      expect(err.serverMessage).toMatch(/can't pin/i);
    }
  });

  it("classifies any other non-2xx as unknown (never a bare 500 crash)", async () => {
    mockFetch(() => jsonResponse({ error: "boom" }, { status: 500 }));
    await expect(
      sendPennyMessage({ viewSlug: "p", token: "t", message: "hi" }),
    ).rejects.toMatchObject({ kind: "unknown", status: 500 });
  });

  it("PennyError is a real Error instance (so callers can catch it)", async () => {
    mockFetch(() => jsonResponse({ error: "ai_disabled" }, { status: 409 }));
    await expect(
      sendPennyMessage({ viewSlug: "p", token: "t", message: "hi" }),
    ).rejects.toBeInstanceOf(PennyError);
  });
});

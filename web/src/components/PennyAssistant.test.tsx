// web/src/components/PennyAssistant.test.tsx — PE6: the LIVE Penny drawer on the
// detail page (apply-immediately + narrate). Spec B §2/§5.1/§8, issue #125.
//
// PennyAssistant wires the PE1 shell to POST …/penny: the composer sends the user
// message + Bearer; the transcript renders narrate→act→narrate (NO diff-card
// approval gate); it NEVER streams a number (decision-metric deltas land only once
// the engine recomputes and the page refetches the view-model); the provider
// disclosure reflects the ACTUAL provider and flips on fallback; and 503 / 409
// ai_disabled / 429 degrade gracefully so chat is never the only path.
//
// fetch is mocked (no real api.anthropic.com / api.openai.com call, ever).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PennyAssistant } from "./PennyDrawer";

interface PennyPayload {
  turns_appended: Array<{ id?: string; role: string; content: string; revision_id?: string }>;
  provider: string;
  applied_revisions: string[];
  narration: string;
}

function okPayload(over: Partial<PennyPayload> = {}): PennyPayload {
  return {
    turns_appended: [
      { id: "u1", role: "user", content: "Set Year-1 share to 8%" },
      { id: "a1", role: "assistant", content: "I'll set the donor-market share to 8% for Year 1." },
      {
        id: "a2",
        role: "assistant",
        content: "Done. Year-1 share is now 8%. Break-even moved to month 6.",
        revision_id: "rev_2",
      },
    ],
    provider: "anthropic",
    applied_revisions: ["rev_2"],
    narration: "Done. Year-1 share is now 8%. Break-even moved to month 6.",
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch mock whose promise we resolve/reject by hand (for the streaming/Stop case). */
function deferredFetch() {
  let resolveFn!: (r: Response) => void;
  let rejectFn!: (e: unknown) => void;
  let capturedInit: RequestInit | undefined;
  const fn = vi.fn((_url: string, init: RequestInit) => {
    capturedInit = init;
    return new Promise<Response>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
      init.signal?.addEventListener("abort", () =>
        rej(Object.assign(new Error("Aborted"), { name: "AbortError" })),
      );
    });
  });
  vi.stubGlobal("fetch", fn);
  return {
    fn,
    resolve: (r: Response) => resolveFn(r),
    reject: (e: unknown) => rejectFn(e),
    get init() {
      return capturedInit;
    },
  };
}

function mountAndOpen() {
  return render(
    <PennyAssistant viewSlug="p_abc" token="edit-tok" provider="anthropic" />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function send(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByTestId("penny-fab"));
  await screen.findByRole("dialog");
  const box = screen.getByRole("textbox", { name: /ask penny/i });
  await user.type(box, text);
  await user.click(screen.getByRole("button", { name: /^send$/i }));
}

describe("PennyAssistant — apply-immediately + narrate", () => {
  it("sends the message to POST …/penny with Bearer and echoes the user turn", async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(jsonResponse(okPayload())),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    mountAndOpen();
    await send(user, "Set Year-1 share to 8%");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projections/p_abc/penny");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer edit-tok");

    // The user's message is echoed as a user turn (optimistic, instant feedback).
    await waitFor(() => {
      const userTurns = screen
        .getAllByTestId("penny-turn")
        .filter((t) => t.getAttribute("data-role") === "user");
      expect(userTurns.some((t) => /set year-1 share to 8%/i.test(t.textContent ?? ""))).toBe(true);
    });
  });

  it("renders Penny's narrate→act narration after the turn settles", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(okPayload()))));
    const user = userEvent.setup();
    mountAndOpen();
    await send(user, "Set Year-1 share to 8%");

    // Intent line (before) + completion line (after) both render verbatim.
    expect(
      await screen.findByText(/i'll set the donor-market share to 8%/i),
    ).toBeInTheDocument();
    expect(await screen.findByText(/done\. year-1 share is now 8%/i)).toBeInTheDocument();
  });

  it("has NO diff-card / approval gate (apply-immediately, not propose→approve)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(okPayload()))));
    const user = userEvent.setup();
    mountAndOpen();
    await send(user, "Set Year-1 share to 8%");
    await screen.findByText(/done\. year-1 share is now 8%/i);
    expect(screen.queryByRole("button", { name: /^apply$/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("penny-diff-card")).not.toBeInTheDocument();
  });

  it("refetches the view-model on an applied edit (onApplied with revision ids)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(okPayload()))));
    const onApplied = vi.fn();
    const user = userEvent.setup();
    render(<PennyAssistant viewSlug="p_abc" token="t" provider="anthropic" onApplied={onApplied} />);
    await send(user, "Set Year-1 share to 8%");
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(["rev_2"]));
  });

  it("does NOT refetch when the turn applied no edit (answer-only)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            okPayload({
              applied_revisions: [],
              turns_appended: [
                { id: "u1", role: "user", content: "explain break-even" },
                { id: "a1", role: "assistant", content: "Break-even is when cumulative cash turns positive." },
              ],
              narration: "Break-even is when cumulative cash turns positive.",
            }),
          ),
        ),
      ),
    );
    const onApplied = vi.fn();
    const user = userEvent.setup();
    render(<PennyAssistant viewSlug="p_abc" token="t" provider="anthropic" onApplied={onApplied} />);
    await send(user, "explain break-even");
    await screen.findByText(/break-even is when cumulative cash/i);
    expect(onApplied).not.toHaveBeenCalled();
  });
});

describe("PennyAssistant — provider disclosure", () => {
  it("flips the disclosure line to OpenAI when the response provider is openai", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(okPayload({ provider: "openai" })))),
    );
    const user = userEvent.setup();
    mountAndOpen();
    // Starts on the known provider…
    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    expect(screen.getByTestId("penny-provider")).toHaveTextContent(/anthropic/i);
    // …and flips to OpenAI after the fallback response.
    const box = screen.getByRole("textbox", { name: /ask penny/i });
    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(screen.getByTestId("penny-provider")).toHaveTextContent(/openai/i));
  });
});

describe("PennyAssistant — streaming + Stop (never streams a number)", () => {
  it("shows a Stop control while in flight and renders NO figure until the engine settles", async () => {
    const d = deferredFetch();
    const user = userEvent.setup();
    mountAndOpen();
    await send(user, "Set Year-1 share to 8%");

    // In flight: a working indicator + a Stop control; the eventual figure is NOT
    // on screen yet (the client never streams a number ahead of the recompute).
    expect(await screen.findByTestId("penny-pending")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    expect(screen.queryByText(/month 6/i)).not.toBeInTheDocument();

    // Settle: the server's grounded narration (with its figure) appears.
    d.resolve(jsonResponse(okPayload()));
    expect(await screen.findByText(/break-even moved to month 6/i)).toBeInTheDocument();
    expect(screen.queryByTestId("penny-pending")).not.toBeInTheDocument();
  });

  it("Stop aborts the in-flight request and returns to idle", async () => {
    const d = deferredFetch();
    const user = userEvent.setup();
    mountAndOpen();
    await send(user, "Set Year-1 share to 8%");

    await screen.findByTestId("penny-pending");
    await user.click(screen.getByRole("button", { name: /stop/i }));

    await waitFor(() => expect(d.init?.signal?.aborted).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("penny-pending")).not.toBeInTheDocument());
    // Composer is back to a sendable state — chat is never wedged.
    expect(screen.getByRole("button", { name: /^send$/i })).toBeInTheDocument();
  });
});

describe("PennyAssistant — graceful failure (chat is never the only path)", () => {
  it("503 → 'AI unavailable — numbers + manual editing still work'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ error: "ai_unavailable" }, 503))),
    );
    const user = userEvent.setup();
    mountAndOpen();
    await send(user, "hi");
    const err = await screen.findByTestId("penny-error");
    expect(err).toHaveTextContent(/ai unavailable/i);
    expect(err).toHaveTextContent(/manual editing still work/i);
  });

  it("429 → a plain rate-limit message (no retry math shown)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse({ error: "rate_limited", retry_after_seconds: 30 }, 429)),
      ),
    );
    const user = userEvent.setup();
    mountAndOpen();
    await send(user, "hi");
    const err = await screen.findByTestId("penny-error");
    expect(err.textContent ?? "").toMatch(/busy|try again|moment/i);
  });

  it("422 → relays the server's plain-language rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            { error: "node_not_pinnable", message: "Net profit is a total I can't pin." },
            422,
          ),
        ),
      ),
    );
    const user = userEvent.setup();
    mountAndOpen();
    await send(user, "pin net profit");
    expect(await screen.findByText(/net profit is a total i can't pin/i)).toBeInTheDocument();
  });

  it("409 ai_disabled → mutes the composer and offers a Settings deep-link (never a dead-end)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ error: "ai_disabled" }, 409))),
    );
    const user = userEvent.setup();
    render(
      <PennyAssistant
        viewSlug="p_abc"
        token="t"
        provider="anthropic"
        settingsHref="/p/abc/edit?settings=ai"
      />,
    );
    await send(user, "hi");
    const note = await screen.findByTestId("penny-muted-note");
    const link = within(note).getByRole("link", { name: /settings/i });
    expect(link).toHaveAttribute("href", "/p/abc/edit?settings=ai");
    // The composer input is no longer the (now-muted) path.
    expect(screen.queryByRole("textbox", { name: /ask penny/i })).not.toBeInTheDocument();
  });
});

describe("PennyAssistant — AI-disabled up front", () => {
  it("renders the muted FAB (delegates to the shell) and never opens a dialog", async () => {
    const user = userEvent.setup();
    render(
      <PennyAssistant
        viewSlug="p_abc"
        token="t"
        aiEnabled={false}
        settingsHref="/p/abc/edit?settings=ai"
      />,
    );
    const fab = screen.getByTestId("penny-fab");
    expect(fab).toHaveAttribute("data-state", "ai-disabled");
    await user.click(fab);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

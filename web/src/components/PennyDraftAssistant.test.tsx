// web/src/components/PennyDraftAssistant.test.tsx — PE8 (issue #127), Spec B §5.2.
//
// The wizard's DRAFT-mode Penny: the SAME left drawer, but every edit acts on the
// in-memory wizard draft via POST /api/penny/draft and PERSISTS NOTHING (Spec §7).
// She narrates each edit, the change flows back into the wizard through onApplyDraft,
// and every applied field gets a per-field FieldChange affordance (recent change +
// "was X" + undo). AI-disabled → the muted FAB (never a dead-end); the manual wizard
// is unaffected. The client computes NOTHING — the returned draft is rendered/mapped
// verbatim. fetch is mocked (no real api.anthropic.com / api.openai.com call, ever).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PennyDraftAssistant } from "./PennyDrawer";

interface DraftPayload {
  draft: Record<string, unknown>;
  narration: string;
  provider: string;
  applied: Array<{
    tool: string;
    version: number | null;
    actor: string;
    changed: Array<{ field: string; was: unknown; now: unknown }>;
  }>;
}

function shareEdit(over: Partial<DraftPayload> = {}): DraftPayload {
  return {
    draft: {
      name: "House of Hope",
      assumptions: { share_y1: "8", share_y2: "8", share_y3: "10" },
      trade_area: { households: "512000" },
      cost_schedule: [],
    },
    narration: "Done. Year-1 donor share is now 8.",
    provider: "anthropic",
    applied: [
      {
        tool: "set_assumption",
        version: null,
        actor: "penny",
        changed: [{ field: "share_y1", was: "6", now: "8" }],
      },
    ],
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  const fn = vi.fn((url: string, init: RequestInit) => Promise.resolve(impl(url, init)));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const LABELS: Record<string, string> = {
  share_y1: "Year-1 donor share",
  name: "Store name",
  cost_schedule: "Cost schedule",
};

function mount(over: Partial<React.ComponentProps<typeof PennyDraftAssistant>> = {}) {
  const onApplyDraft = vi.fn();
  const onRevertField = vi.fn();
  const props = {
    token: "wizdraft-tok",
    buildDraftState: () => ({
      name: "House of Hope",
      assumptions: { share_y1: "6", share_y2: "8", share_y3: "10" },
      trade_area: { households: "512000" },
      cost_schedule: [],
    }),
    onApplyDraft,
    onRevertField,
    labelField: (f: string) => LABELS[f] ?? f,
    ...over,
  };
  return { ...render(<PennyDraftAssistant {...props} />), props, onApplyDraft, onRevertField };
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /penny ai/i }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PennyDraftAssistant — presence + AI-disabled fallback (Spec §1/§5.2)", () => {
  it("renders the enabled Penny FAB in the wizard", () => {
    mockFetch(() => jsonResponse(shareEdit()));
    mount();
    const fab = screen.getByTestId("penny-fab");
    expect(fab).toHaveAttribute("data-state", "ai-enabled");
  });

  it("AI-disabled → the muted Settings FAB, never the live drawer (CLAUDE.md opt-out)", () => {
    mount({ aiEnabled: false });
    const fab = screen.getByTestId("penny-fab");
    expect(fab).toHaveAttribute("data-state", "ai-disabled");
    // No live composer / drawer is reachable when Penny is off.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("PennyDraftAssistant — draft edits act on /penny/draft, persist nothing", () => {
  it("sends the in-memory draft_state, narrates, and maps the mutated draft back", async () => {
    const fetchMock = mockFetch(() => jsonResponse(shareEdit()));
    const user = userEvent.setup();
    const { onApplyDraft } = mount();
    await open(user);

    await user.type(screen.getByRole("textbox", { name: /ask penny/i }), "Set Year-1 share to 8");
    await user.keyboard("{Enter}");

    // It POSTs the draft variant with the current in-memory draft_state (no view_slug).
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/penny/draft");
    const body = JSON.parse(init.body as string);
    expect(body.draft_state.assumptions.share_y1).toBe("6");

    // The mutated draft + applied changes flow back into the wizard (page maps fields).
    await waitFor(() => expect(onApplyDraft).toHaveBeenCalled());
    const [nextDraft, applied] = onApplyDraft.mock.calls[0];
    expect((nextDraft.assumptions as Record<string, unknown>).share_y1).toBe("8");
    expect(applied[0].changed[0]).toEqual({ field: "share_y1", was: "6", now: "8" });

    // She narrates the result (rendered verbatim — no client-computed figure).
    expect(await screen.findByText(/Year-1 donor share is now 8/i)).toBeInTheDocument();
  });

  it("renders a per-field FieldChange (recent change + was X + undo) for each edit", async () => {
    mockFetch(() => jsonResponse(shareEdit()));
    const user = userEvent.setup();
    mount();
    await open(user);
    await user.type(screen.getByRole("textbox", { name: /ask penny/i }), "Set Year-1 share to 8");
    await user.keyboard("{Enter}");

    const change = await screen.findByTestId("field-change");
    expect(within(change).getByTestId("field-change-current")).toHaveTextContent("8");
    expect(within(change).getByTestId("field-change-was")).toHaveTextContent(/was 6/);
    expect(within(change).getByTestId("field-change-undo")).toBeInTheDocument();
    // Attribution is by Penny, by icon + TEXT (never color alone).
    expect(within(change).getByTestId("field-change-badge")).toHaveTextContent(/by Penny/i);
  });

  it("per-field undo reverts that one field to its previous value (forward draft edit)", async () => {
    mockFetch(() => jsonResponse(shareEdit()));
    const user = userEvent.setup();
    const { onRevertField } = mount();
    await open(user);
    await user.type(screen.getByRole("textbox", { name: /ask penny/i }), "Set Year-1 share to 8");
    await user.keyboard("{Enter}");

    const undo = await screen.findByTestId("field-change-undo");
    await user.click(undo);
    expect(onRevertField).toHaveBeenCalledWith("share_y1", "6");
    // The change re-renders as reverted (itself re-undoable).
    await waitFor(() =>
      expect(screen.getByTestId("field-change")).toHaveAttribute("data-reverted", "true"),
    );
  });

  it("a cost-schedule build is undoable as a whole (restores the prior schedule)", async () => {
    const built = shareEdit({
      draft: {
        name: "House of Hope",
        assumptions: { share_y1: "6" },
        trade_area: { households: "512000" },
        cost_schedule: [
          { category: "Build-out", month: 2, amount: 50000, provenance: { source: "ai" } },
        ],
      },
      narration: "I placed your build-out in month 2.",
      applied: [{ tool: "edit_cost_schedule", version: null, actor: "penny", changed: [] }],
    });
    mockFetch(() => jsonResponse(built));
    const user = userEvent.setup();
    const priorSchedule = [{ category: "Consultant", month: 1, amount: 100000 }];
    const { onApplyDraft, onRevertField } = mount({
      buildDraftState: () => ({
        name: "House of Hope",
        assumptions: { share_y1: "6" },
        trade_area: { households: "512000" },
        cost_schedule: priorSchedule,
      }),
    });
    await open(user);
    await user.type(screen.getByRole("textbox", { name: /ask penny/i }), "Build my cost schedule");
    await user.keyboard("{Enter}");

    // The new schedule (with provenance) flowed back to the wizard.
    await waitFor(() => expect(onApplyDraft).toHaveBeenCalled());
    const [nextDraft] = onApplyDraft.mock.calls[0];
    expect((nextDraft.cost_schedule as unknown[]).length).toBe(1);

    // Undo restores the schedule we sent (the prior one).
    const undo = await screen.findByTestId("field-change-undo");
    await user.click(undo);
    expect(onRevertField).toHaveBeenCalledWith("cost_schedule", priorSchedule);
  });
});

describe("PennyDraftAssistant — proposal upload seam (Spec §9, PE9 fills parsing)", () => {
  it("offers a PDF upload affordance that hands the file to the host (PE9 seam)", async () => {
    mockFetch(() => jsonResponse(shareEdit()));
    const onProposalSelected = vi.fn();
    const user = userEvent.setup();
    mount({ onProposalSelected });
    await open(user);

    const input = screen.getByTestId("penny-proposal-input") as HTMLInputElement;
    expect(input).toHaveAttribute("accept", expect.stringContaining("pdf"));
    const file = new File(["%PDF-1.4 fake"], "proposal.pdf", { type: "application/pdf" });
    await user.upload(input, file);
    expect(onProposalSelected).toHaveBeenCalledTimes(1);
    expect(onProposalSelected.mock.calls[0][0].name).toBe("proposal.pdf");
  });
});

describe("PennyDraftAssistant — graceful degradation (chat is never the only path)", () => {
  it("a 409 ai_disabled mutes the composer to a Settings note mid-session", async () => {
    mockFetch(() => jsonResponse({ error: "ai_disabled" }, 409));
    const user = userEvent.setup();
    mount();
    await open(user);
    await user.type(screen.getByRole("textbox", { name: /ask penny/i }), "Set Year-1 share to 8");
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("penny-muted-note")).toBeInTheDocument();
  });

  it("a 422 rejection is relayed in plain language as Penny's own turn", async () => {
    mockFetch(() =>
      jsonResponse(
        { error: "figure_stripped", message: "I can only apply a raw input value." },
        422,
      ),
    );
    const user = userEvent.setup();
    mount();
    await open(user);
    await user.type(screen.getByRole("textbox", { name: /ask penny/i }), "set net to $9");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/raw input value/i)).toBeInTheDocument();
  });
});

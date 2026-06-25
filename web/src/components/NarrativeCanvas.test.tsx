// web/src/components/NarrativeCanvas.test.tsx — epic-N N7.
//
// The narrative canvas is an inline editor over rendered markdown for the board
// packet's prose (API_SPEC §6.1). It exposes a MINIMAL toolbar matching the
// SERVER bleach allowlist exactly — bold / italic / list / link (strong, em,
// ul-li, a) — never raw HTML (stored-XSS defense, SECURITY.md §5). It tracks
// clean / edited / stale / regenerating states; autosaves via PUT (If-Match);
// surfaces the server-built grounded figures; and is accessible: role=region,
// aria-live announcements for save + decision changes, Esc blurs (never
// discards), reduced-motion honored.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NarrativeCanvas } from "./NarrativeCanvas";
import type { Narrative } from "../api/narrative";

const BASE: Narrative = {
  body_md: "<p>The store needs <strong>$277,990</strong> in capital.</p>",
  edited: false,
  edit_origin: "ai",
  computed_hash: "sha256:abc",
  stale: false,
  stale_diff: [],
  grounded_figures: [
    { raw: 277990, display: "$277,990", variants: ["$277,990", "$278k"] },
    { raw: 41200, display: "$41,200", variants: ["$41,200"] },
  ],
  ai_disabled: false,
  updated_at: "2026-06-24T00:00:00Z",
};

function renderCanvas(over: Partial<Narrative> = {}, props: Record<string, unknown> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onRegenerate = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <NarrativeCanvas
      narrative={{ ...BASE, ...over }}
      onSave={onSave}
      onRegenerate={onRegenerate}
      {...props}
    />,
  );
  return { onSave, onRegenerate, ...utils };
}

afterEach(() => vi.clearAllMocks());

describe("NarrativeCanvas — structure & a11y", () => {
  it("is a labelled region (role=region)", () => {
    renderCanvas();
    const region = screen.getByRole("region", { name: /narrative/i });
    expect(region).toBeInTheDocument();
  });

  it("renders the stored prose (markdown rendered, not raw)", () => {
    renderCanvas();
    expect(screen.getByText(/in capital/i)).toBeInTheDocument();
    // the strong figure renders bold, not as literal <strong> text
    expect(screen.queryByText("<strong>")).not.toBeInTheDocument();
  });

  it("exposes an aria-live save-status region (polite)", () => {
    renderCanvas();
    const live = screen.getByTestId("narrative-save-status");
    expect(live).toHaveAttribute("aria-live", "polite");
  });
});

describe("NarrativeCanvas — toolbar = server bleach allowlist", () => {
  it("offers exactly bold / italic / list / link (and nothing else)", () => {
    renderCanvas();
    const toolbar = screen.getByRole("toolbar", { name: /format/i });
    expect(within(toolbar).getByRole("button", { name: /bold/i })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: /italic/i })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: /list/i })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: /link/i })).toBeInTheDocument();
    // no raw-HTML / image / heading escape hatch
    expect(within(toolbar).queryByRole("button", { name: /image|html|heading|code/i })).toBeNull();
    expect(within(toolbar).getAllByRole("button")).toHaveLength(4);
  });
});

describe("NarrativeCanvas — states", () => {
  it("clean state when not edited and not stale", () => {
    renderCanvas({ edited: false, stale: false });
    expect(screen.getByTestId("narrative-canvas")).toHaveAttribute("data-state", "clean");
  });

  it("edited state when the prose was hand-edited", () => {
    renderCanvas({ edited: true, edit_origin: "human", stale: false });
    expect(screen.getByTestId("narrative-canvas")).toHaveAttribute("data-state", "edited");
  });

  it("stale state surfaces the was->now diff and a Regenerate action", () => {
    renderCanvas({
      stale: true,
      stale_diff: [{ field: "capital", was: "$262,400", now: "$277,990" }],
    });
    const canvas = screen.getByTestId("narrative-canvas");
    expect(canvas).toHaveAttribute("data-state", "stale");
    // the staleness notice announces politely (does not hijack the editor)
    const notice = screen.getByTestId("narrative-stale-notice");
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(notice).toHaveTextContent("$262,400");
    expect(notice).toHaveTextContent("$277,990");
    expect(screen.getByRole("button", { name: /regenerate/i })).toBeInTheDocument();
  });

  it("regenerating state disables the editor + announces via aria-live", () => {
    renderCanvas({ stale: true }, { regenerating: true });
    expect(screen.getByTestId("narrative-canvas")).toHaveAttribute("data-state", "regenerating");
    expect(screen.getByTestId("narrative-save-status")).toHaveTextContent(/regenerat/i);
  });
});

describe("NarrativeCanvas — grounded figures", () => {
  it("surfaces the server-built grounded figures + variants (no client regex)", () => {
    renderCanvas();
    const list = screen.getByTestId("grounded-figures");
    expect(within(list).getByText("$277,990")).toBeInTheDocument();
    expect(within(list).getByText("$41,200")).toBeInTheDocument();
    // the blessed thousands variant is available so an editor can round
    expect(within(list).getByText("$278k")).toBeInTheDocument();
  });
});

describe("NarrativeCanvas — autosave PUT & Esc", () => {
  it("autosaves edited prose via onSave (PUT/If-Match lives in the client)", async () => {
    const { onSave } = renderCanvas();
    const editor = screen.getByRole("textbox", { name: /narrative/i });
    await userEvent.click(editor);
    await userEvent.type(editor, " More context.");
    // blur settles the autosave
    await userEvent.tab();
    expect(onSave).toHaveBeenCalled();
    const saved = onSave.mock.calls[0][0] as string;
    expect(saved).toContain("More context.");
  });

  it("Esc blurs the editor but does NOT discard the edit (no onSave-with-empty)", async () => {
    const { onSave } = renderCanvas();
    const editor = screen.getByRole("textbox", { name: /narrative/i });
    await userEvent.click(editor);
    await userEvent.type(editor, " kept text");
    await userEvent.keyboard("{Escape}");
    // editor is blurred
    expect(editor).not.toHaveFocus();
    // the typed content is still present (not reverted)
    expect(editor).toHaveTextContent("kept text");
    // Esc must never fire a destructive empty save
    for (const call of onSave.mock.calls) {
      expect(call[0]).not.toBe("");
    }
  });

  it("Regenerate triggers onRegenerate (confirm-before-discard handled upstream)", async () => {
    const { onRegenerate } = renderCanvas({ stale: true });
    await userEvent.click(screen.getByRole("button", { name: /regenerate/i }));
    expect(onRegenerate).toHaveBeenCalledOnce();
  });
});

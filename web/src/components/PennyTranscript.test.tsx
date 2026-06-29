import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PennyTranscript, type PennyTurn } from "./PennyTranscript";

describe("PennyTranscript", () => {
  it("is a polite live log region with an accessible name", () => {
    render(<PennyTranscript turns={[]} />);
    const log = screen.getByTestId("penny-transcript");
    // aria-live=polite log so streamed turns are announced without stealing focus.
    expect(log).toHaveAttribute("role", "log");
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveAccessibleName(/penny/i);
  });

  it("opens with a friendly intro from Penny before the first turn", async () => {
    render(<PennyTranscript turns={[]} />);
    const intro = screen.getByTestId("penny-transcript-empty");
    expect(intro).toBeInTheDocument();
    // Rendered as one of Penny's assistant bubbles (distinct, Anthropic-style).
    expect(intro).toHaveAttribute("data-role", "assistant");
    expect(screen.queryByTestId("penny-turn")).not.toBeInTheDocument();
    // The greeting introduces Penny and offers to help (it types in, so await it).
    expect(await screen.findByText(/i'm penny/i)).toBeInTheDocument();
  });

  it("renders a custom intro verbatim", async () => {
    render(<PennyTranscript turns={[]} intro="Hello there, ask me anything." />);
    expect(await screen.findByText(/hello there, ask me anything/i)).toBeInTheDocument();
  });

  it("renders each turn tagged with its role, no intro", async () => {
    const turns: PennyTurn[] = [
      { id: "t1", role: "user", content: "Set Year-1 share to 8%." },
      { id: "t2", role: "assistant", content: "I'll set the donor-market share to 8%." },
    ];
    render(<PennyTranscript turns={turns} />);
    const rendered = screen.getAllByTestId("penny-turn");
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toHaveAttribute("data-role", "user");
    expect(rendered[1]).toHaveAttribute("data-role", "assistant");
    // The assistant turn types in (presentation effect over the final text), so await
    // the settled string.
    expect(await screen.findByText(/donor-market share to 8%/i)).toBeInTheDocument();
    expect(screen.queryByTestId("penny-transcript-empty")).not.toBeInTheDocument();
  });

  it("is texting-style: NO visible per-message role caption, but an sr-only role label is kept (#10)", () => {
    const turns: PennyTurn[] = [
      { id: "u", role: "user", content: "Hi there" },
      { id: "a", role: "assistant", content: "Hello back" },
    ];
    render(<PennyTranscript turns={turns} />);
    const [userTurn, pennyTurn] = screen.getAllByTestId("penny-turn");

    // The role is announced to screen readers ("You said…" / "Penny said…") but the
    // caption is sr-only — distinguished by alignment/color, NOT a visible label.
    const userLabel = within(userTurn).getByText(/you said/i);
    expect(userLabel).toHaveClass("sr-only");
    const pennyLabel = within(pennyTurn).getByText(/penny said/i);
    expect(pennyLabel).toHaveClass("sr-only");

    // No per-message avatar/icon on the bubbles (the drawer-HEADER avatar is the
    // brand cue — decision #17 — but the bubbles carry none).
    expect(within(userTurn).queryByRole("img")).not.toBeInTheDocument();
    expect(within(pennyTurn).queryByRole("img")).not.toBeInTheDocument();
  });

  it("distinguishes user (right) vs Penny (left) by alignment, not a label (#10)", () => {
    const turns: PennyTurn[] = [
      { id: "u", role: "user", content: "Hi" },
      { id: "a", role: "assistant", content: "Hello" },
    ];
    render(<PennyTranscript turns={turns} />);
    const [userTurn, pennyTurn] = screen.getAllByTestId("penny-turn");
    expect(userTurn).toHaveStyle({ alignSelf: "flex-end" });
    expect(pennyTurn).toHaveStyle({ alignSelf: "flex-start" });
  });

  it("renders an assistant turn's Markdown as formatted, sanitized output", () => {
    const mql = (q: string) => ({
      matches: q.includes("reduce"),
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation(mql));
    try {
      render(
        <PennyTranscript
          turns={[
            {
              id: "a",
              role: "assistant",
              content: "Updated the **payroll** input.\n\n- one\n- two",
            },
          ]}
        />,
      );
      // Bold renders as a real <strong> (not the literal `**` the screenshot showed).
      expect(screen.getByText("payroll").tagName).toBe("STRONG");
      expect(screen.getByTestId("penny-transcript").textContent).not.toContain("**");
      // Hyphen bullets render as list items, not raw "- " text.
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders settled (no typewriter) under prefers-reduced-motion", () => {
    const mql = (q: string) => ({
      matches: q.includes("reduce"),
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation(mql));
    try {
      render(
        <PennyTranscript
          turns={[{ id: "a", role: "assistant", content: "Settled immediately." }]}
        />,
      );
      // No reveal animation: the full text is present synchronously.
      expect(screen.getByText(/settled immediately/i)).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

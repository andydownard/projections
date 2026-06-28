import { render, screen } from "@testing-library/react";
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

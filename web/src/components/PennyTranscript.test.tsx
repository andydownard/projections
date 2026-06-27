import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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

  it("shows an empty-state prompt when there are no turns", () => {
    render(<PennyTranscript turns={[]} />);
    expect(screen.getByTestId("penny-transcript-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("penny-turn")).not.toBeInTheDocument();
  });

  it("renders each turn tagged with its role, no empty-state", () => {
    const turns: PennyTurn[] = [
      { id: "t1", role: "user", content: "Set Year-1 share to 8%." },
      { id: "t2", role: "assistant", content: "I'll set the donor-market share to 8%." },
    ];
    render(<PennyTranscript turns={turns} />);
    const rendered = screen.getAllByTestId("penny-turn");
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toHaveAttribute("data-role", "user");
    expect(rendered[1]).toHaveAttribute("data-role", "assistant");
    expect(screen.getByText(/donor-market share to 8%/i)).toBeInTheDocument();
    expect(screen.queryByTestId("penny-transcript-empty")).not.toBeInTheDocument();
  });
});

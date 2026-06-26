import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RecoChip } from "./RecoChip";

// SLICE 2 — recommendation chip. The API emits a SEMANTIC enum (proceed | revise |
// find_cheaper_rent | raise_cash | delay | do_not_proceed); the CLIENT maps the
// enum → a brand/semantic token, never the reverse, and the API never sends hex
// (CLAUDE.md view-model contract). Meaning carries TEXT, not color alone (a11y).

describe("RecoChip (enum → token, never color-only)", () => {
  it("renders a human label for each recommendation tag", () => {
    const cases: Array<[Parameters<typeof RecoChip>[0]["tag"], RegExp]> = [
      ["proceed", /proceed/i],
      ["revise", /revise/i],
      ["find_cheaper_rent", /cheaper rent/i],
      ["raise_cash", /raise cash/i],
      ["delay", /delay/i],
      ["do_not_proceed", /do not proceed/i],
    ];
    for (const [tag, label] of cases) {
      const { unmount } = render(<RecoChip tag={tag} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it("exposes the tag via a data attribute (token mapping is CSS, not inline hex)", () => {
    render(<RecoChip tag="proceed" />);
    const chip = screen.getByTestId("reco-chip");
    expect(chip).toHaveAttribute("data-tag", "proceed");
    // No inline color: the chip styles itself from a semantic CSS class, never hex.
    expect(chip.getAttribute("style")).toBeNull();
  });

  it("has an accessible label naming the recommendation", () => {
    render(<RecoChip tag="raise_cash" />);
    expect(screen.getByLabelText(/recommendation/i)).toBeInTheDocument();
  });

  it("prepends a per-tag status glyph so the verdict survives in grayscale", () => {
    // proceed → ✓, do_not_proceed → ✕, every conditional/revise verdict → △.
    const cases: Array<[Parameters<typeof RecoChip>[0]["tag"], string]> = [
      ["proceed", "✓"],
      ["do_not_proceed", "✕"],
      ["revise", "△"],
      ["find_cheaper_rent", "△"],
      ["raise_cash", "△"],
      ["delay", "△"],
    ];
    for (const [tag, glyph] of cases) {
      const { unmount } = render(<RecoChip tag={tag} />);
      const glyphEl = screen.getByTestId("reco-chip-glyph");
      expect(glyphEl).toHaveTextContent(glyph);
      // Decorative only: the glyph must be hidden from assistive tech because the
      // aria-label already speaks the verdict.
      expect(glyphEl).toHaveAttribute("aria-hidden", "true");
      unmount();
    }
  });

  it("keeps the verdict glyph out of the accessibility tree (aria-label unchanged)", () => {
    render(<RecoChip tag="proceed" />);
    // The accessible name is exactly the verdict — the glyph contributes nothing.
    expect(screen.getByLabelText("Recommendation: Proceed")).toBeInTheDocument();
    expect(screen.getByTestId("reco-chip-glyph")).toHaveAttribute("aria-hidden", "true");
  });
});

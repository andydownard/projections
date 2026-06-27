import { describe, expect, it } from "vitest";

import { basisLabel, cashGapLabel, formatListDate, isNegative } from "./displayLabels";

// PRESENTATION-only helpers (#148 negative cue, #151 enum/date labels). They do
// NO math and re-derive NO figure: isNegative only reads the SIGN of the server
// `raw` value to drive a color cue, and the label/date maps only humanize codes
// the server does not yet emit a display string for.

describe("isNegative", () => {
  it("is true only when the server raw value is below zero", () => {
    expect(isNegative({ raw: -1, display: "($1)" })).toBe(true);
    expect(isNegative({ raw: -44433, display: "($44,433)" })).toBe(true);
    expect(isNegative({ raw: 0, display: "$0" })).toBe(false);
    expect(isNegative({ raw: 5, display: "$5" })).toBe(false);
  });

  it("is false for a missing figure (no value to color)", () => {
    expect(isNegative(null)).toBe(false);
    expect(isNegative(undefined)).toBe(false);
  });
});

describe("cashGapLabel [#194]", () => {
  it("calls a negative trough a 'First-year cash gap' (a real shortfall)", () => {
    expect(cashGapLabel({ raw: -219990, display: "($219,990)" })).toBe("First-year cash gap");
    expect(cashGapLabel({ raw: -1, display: "($1)" })).toBe("First-year cash gap");
  });

  it("calls a non-negative trough the 'Lowest first-year cash balance' (a cushion, not a gap)", () => {
    // A well-capitalized plan whose operating window never goes cash-negative: the
    // min cumulative cash is a positive low-water balance, NOT a shortfall.
    expect(cashGapLabel({ raw: 40000, display: "$40,000" })).toBe("Lowest first-year cash balance");
    // Boundary: exactly $0 is not a gap either.
    expect(cashGapLabel({ raw: 0, display: "$0" })).toBe("Lowest first-year cash balance");
  });

  it("does the same with no client math — picks by sign only, never re-derives the figure", () => {
    // Sign of `raw` alone drives the label; the displayed string is untouched.
    expect(cashGapLabel(null)).toBe("Lowest first-year cash balance");
    expect(cashGapLabel(undefined)).toBe("Lowest first-year cash balance");
  });
});

describe("basisLabel", () => {
  it("maps known trade-area basis codes to human labels", () => {
    expect(basisLabel("city")).toBe("City");
    expect(basisLabel("county")).toBe("County");
    expect(basisLabel("tract")).toBe("Census tract");
    expect(basisLabel("block_group")).toBe("Block group");
    expect(basisLabel("zip")).toBe("ZIP code");
  });

  it("title-cases an unknown code so no raw enum string leaks to the user", () => {
    expect(basisLabel("metro_area")).toBe("Metro Area");
  });

  it("renders nothing for an empty/missing basis", () => {
    expect(basisLabel("")).toBe("");
    expect(basisLabel(null)).toBe("");
    expect(basisLabel(undefined)).toBe("");
  });
});

describe("formatListDate", () => {
  it("renders a friendly, UTC-stable date — never a raw ISO slice", () => {
    expect(formatListDate("2026-06-24T17:03:21Z")).toBe("Jun 24, 2026");
    // A late-UTC timestamp must not roll to the next calendar day in any TZ.
    expect(formatListDate("2026-12-31T23:59:00Z")).toBe("Dec 31, 2026");
  });

  it("falls back to the date slice when the timestamp is unparseable", () => {
    expect(formatListDate("not-a-date")).toBe("not-a-date");
  });
});

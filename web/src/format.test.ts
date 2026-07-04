import { describe, expect, it } from "vitest";

import { formatAxisTick, formatCount } from "./format";

// #18 — the ONE shared thousands/millions grouping formatter for raw user-entered
// input echoes (households, sqft). Presentation only; no math. These pin the
// grouping behaviour and the safe handling of partial/empty input.
describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(12500)).toBe("12,500");
    expect(formatCount(5234)).toBe("5,234");
  });

  it("groups millions", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  it("leaves sub-thousand values ungrouped", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(0)).toBe("0");
  });

  it("rounds to whole units (no fractional separators)", () => {
    expect(formatCount(12500.4)).toBe("12,500");
  });

  it("renders empty string for null/undefined/NaN so a partial input never shows NaN", () => {
    expect(formatCount(null)).toBe("");
    expect(formatCount(undefined)).toBe("");
    expect(formatCount(Number.NaN)).toBe("");
  });
});

// §3.4 — the ONE client-derived axis-tick formatter (gated, same doctrine as
// formatCount). It formats a client-DERIVED axis POSITION (a nice-number gridline
// like $300,000 that no month's cumulative equals), never a reported business
// figure, and MUST be visually indistinguishable from the server money convention:
// whole dollars, thousands commas, "$" prefix, parentheses for negatives, "$0".
describe("formatAxisTick", () => {
  it("renders $0 as the literal $0", () => {
    expect(formatAxisTick(0)).toBe("$0");
  });

  it("groups positive whole dollars with a $ prefix", () => {
    expect(formatAxisTick(300000)).toBe("$300,000");
    expect(formatAxisTick(25000)).toBe("$25,000");
    expect(formatAxisTick(1000000)).toBe("$1,000,000");
  });

  it("parenthesizes negatives (matching the server display convention), never a minus", () => {
    expect(formatAxisTick(-400000)).toBe("($400,000)");
    expect(formatAxisTick(-20000)).toBe("($20,000)");
    expect(formatAxisTick(-400000)).not.toContain("-");
  });

  it("rounds to whole dollars (axis positions are integers, but stay safe)", () => {
    expect(formatAxisTick(24999.6)).toBe("$25,000");
    expect(formatAxisTick(-24999.6)).toBe("($25,000)");
  });

  it("renders empty string for non-finite input so a partial render never shows NaN", () => {
    expect(formatAxisTick(Number.NaN)).toBe("");
    expect(formatAxisTick(Number.POSITIVE_INFINITY)).toBe("");
  });
});

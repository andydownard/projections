import { describe, expect, it } from "vitest";

import { formatCount } from "./format";

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

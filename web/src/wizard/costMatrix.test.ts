import { describe, expect, it } from "vitest";

import {
  addCategoryRow,
  categoryOrder,
  cellAmount,
  DEFAULT_MONTH_COUNT,
  pivotToMatrix,
  removeCategory,
  renameCategory,
  setCellAmount,
  uniqueCategoryLabel,
} from "./costMatrix";
import type { CostScheduleRow } from "./shareHelper";

const SAMPLE: CostScheduleRow[] = [
  { category: "Consultant", month: 1, amount: 100000 },
  { category: "Consultant", month: 6, amount: 20000 },
  { category: "Equipment", month: 1, amount: 45000 },
];

describe("costMatrix — pivot (#31)", () => {
  it("derives row order from first appearance of each category", () => {
    expect(categoryOrder(SAMPLE)).toEqual(["Consultant", "Equipment"]);
  });

  it("pivots flat rows into a category × 12-month matrix (multiple months per category)", () => {
    const matrix = pivotToMatrix(SAMPLE);
    expect(matrix).toHaveLength(2);
    expect(matrix[0].category).toBe("Consultant");
    expect(matrix[0].cells).toHaveLength(DEFAULT_MONTH_COUNT);
    // Consultant has entries at month 1 and month 6.
    expect(matrix[0].cells[0]).toEqual({ month: 1, amount: 100000 });
    expect(matrix[0].cells[5]).toEqual({ month: 6, amount: 20000 });
    // Months with no entry are null (blank cell).
    expect(matrix[0].cells[1]).toEqual({ month: 2, amount: null });
  });

  it("cellAmount returns the entry amount or null", () => {
    expect(cellAmount(SAMPLE, "Consultant", 6)).toBe(20000);
    expect(cellAmount(SAMPLE, "Consultant", 2)).toBeNull();
    expect(cellAmount(SAMPLE, "Nope", 1)).toBeNull();
  });
});

describe("costMatrix — cell edits map back to the flat schema (#31)", () => {
  it("upserts a positive amount into an existing cell", () => {
    const next = setCellAmount(SAMPLE, "Equipment", 1, 50000);
    expect(cellAmount(next, "Equipment", 1)).toBe(50000);
    expect(next).toHaveLength(SAMPLE.length); // updated in place, no new entry
  });

  it("appends a new flat entry for a previously empty cell", () => {
    const next = setCellAmount(SAMPLE, "Equipment", 3, 5000);
    expect(next).toHaveLength(SAMPLE.length + 1);
    expect(next).toContainEqual({ category: "Equipment", month: 3, amount: 5000 });
  });

  it("clearing a cell with siblings drops only that entry", () => {
    const next = setCellAmount(SAMPLE, "Consultant", 6, null);
    expect(cellAmount(next, "Consultant", 6)).toBeNull();
    expect(cellAmount(next, "Consultant", 1)).toBe(100000); // sibling untouched
    expect(next).toHaveLength(SAMPLE.length - 1);
  });

  it("clearing the last entry of a category keeps the row alive at 0 (trash removes it)", () => {
    const next = setCellAmount(SAMPLE, "Equipment", 1, null);
    expect(categoryOrder(next)).toContain("Equipment");
    expect(cellAmount(next, "Equipment", 1)).toBe(0);
  });

  it("never sums: two month entries for one category stay separate flat rows", () => {
    const next = setCellAmount(SAMPLE, "Consultant", 2, 1000);
    const consultantRows = next.filter((r) => r.category === "Consultant");
    expect(consultantRows.map((r) => r.amount).sort((a, b) => a - b)).toEqual([
      1000, 20000, 100000,
    ]);
  });
});

describe("costMatrix — row operations (#33)", () => {
  it("renames a category across all its flat entries", () => {
    const next = renameCategory(SAMPLE, "Consultant", "Lead Consultant");
    expect(next.filter((r) => r.category === "Lead Consultant")).toHaveLength(2);
    expect(next.filter((r) => r.category === "Consultant")).toHaveLength(0);
  });

  it("removes a whole line-item (every entry with that category)", () => {
    const next = removeCategory(SAMPLE, "Consultant");
    expect(categoryOrder(next)).toEqual(["Equipment"]);
    expect(next).toHaveLength(1);
  });

  it("adds an empty row with a unique placeholder label at the opening month", () => {
    const next = addCategoryRow(SAMPLE, 4);
    expect(next).toHaveLength(SAMPLE.length + 1);
    const added = next[next.length - 1];
    expect(added).toEqual({ category: "New line item", month: 4, amount: 0 });
  });

  it("suffixes the placeholder label so a second add is a distinct row", () => {
    const once = addCategoryRow(SAMPLE, 1);
    const twice = addCategoryRow(once, 1);
    expect(categoryOrder(twice)).toContain("New line item");
    expect(categoryOrder(twice)).toContain("New line item 2");
  });

  it("uniqueCategoryLabel avoids collisions", () => {
    expect(uniqueCategoryLabel(SAMPLE, "Equipment")).toBe("Equipment 2");
    expect(uniqueCategoryLabel(SAMPLE, "Fresh")).toBe("Fresh");
  });
});

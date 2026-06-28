// web/src/wizard/costMatrix.ts — the FRONTEND PIVOT for the startup-costs grid (#31).
//
// The startup-costs editor renders line-items as ROWS × months 1–12 as COLUMNS, but
// the persisted schema stays the flat `{category, month, amount}` array (no engine /
// schema / migration change — decision #31). These helpers pivot the flat array into
// a category×month matrix for display and map every grid edit back to a NEW flat
// array. They are PRESENTATION-ONLY: pivoting and reshaping rows, never summing — the
// row / column / grand totals come from POST /api/cost-schedule/preview as
// `{raw, display}` (NO-CLIENT-MATH / decision #15). The category string is the row
// key, so multiple month-entries for one category collapse onto a single grid row.
import type { CostScheduleRow } from "./shareHelper";

/** The grid always shows months 1–12 as columns (decision #31). */
export const DEFAULT_MONTH_COUNT = 12;

/** One cell of the pivoted matrix. `amount` is null when no flat entry exists for
 *  that (category, month) — rendered as a blank, editable cell. A real 0 is also
 *  rendered blank (a placeholder row keeps an empty line-item visible). */
export interface MatrixCell {
  month: number;
  amount: number | null;
}

/** One pivoted line-item row: a category and its month cells (1…monthCount). */
export interface MatrixRow {
  category: string;
  cells: MatrixCell[];
}

/** Distinct categories in first-appearance order (the grid's row order). */
export function categoryOrder(rows: ReadonlyArray<CostScheduleRow>): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const r of rows) {
    if (!seen.has(r.category)) {
      seen.add(r.category);
      order.push(r.category);
    }
  }
  return order;
}

/** The flat entry's amount at (category, month), or null when there is none. */
export function cellAmount(
  rows: ReadonlyArray<CostScheduleRow>,
  category: string,
  month: number,
): number | null {
  const hit = rows.find((r) => r.category === category && r.month === month);
  return hit ? hit.amount : null;
}

/** Pivot the flat schedule into a category×month matrix (rows × months 1…monthCount). */
export function pivotToMatrix(
  rows: ReadonlyArray<CostScheduleRow>,
  monthCount: number = DEFAULT_MONTH_COUNT,
): MatrixRow[] {
  return categoryOrder(rows).map((category) => ({
    category,
    cells: Array.from({ length: monthCount }, (_unused, i) => {
      const month = i + 1;
      return { month, amount: cellAmount(rows, category, month) };
    }),
  }));
}

/**
 * Set the amount of one grid cell, returning a NEW flat array.
 *
 * A positive amount upserts the (category, month) flat entry. Clearing a cell
 * (`null` / `0`) drops that entry — UNLESS it is the category's only remaining
 * entry, in which case it is kept at 0 so the line-item row never vanishes mid-edit
 * (row removal is the trash control's job, not a cell clear). Pure reshaping — never
 * a sum.
 */
export function setCellAmount(
  rows: ReadonlyArray<CostScheduleRow>,
  category: string,
  month: number,
  amount: number | null,
): CostScheduleRow[] {
  const idx = rows.findIndex((r) => r.category === category && r.month === month);
  const positive = amount != null && Number.isFinite(amount) && amount > 0;

  if (positive) {
    if (idx >= 0) {
      return rows.map((r, i) => (i === idx ? { ...r, amount: amount as number } : r));
    }
    return [...rows, { category, month, amount: amount as number }];
  }

  // Clearing the cell (blank / 0 / non-finite).
  if (idx < 0) return rows.slice(); // nothing to clear → unchanged (new array for callers)
  const categoryCount = rows.filter((r) => r.category === category).length;
  if (categoryCount <= 1) {
    // Last entry for this category → keep it at 0 so the row stays visible.
    return rows.map((r, i) => (i === idx ? { ...r, amount: 0 } : r));
  }
  return rows.filter((_unused, i) => i !== idx);
}

/** Rename a line-item: rewrite the `category` key on every flat entry that has it. */
export function renameCategory(
  rows: ReadonlyArray<CostScheduleRow>,
  from: string,
  to: string,
): CostScheduleRow[] {
  return rows.map((r) => (r.category === from ? { ...r, category: to } : r));
}

/** Remove a whole line-item: drop every flat entry that carries this category. */
export function removeCategory(
  rows: ReadonlyArray<CostScheduleRow>,
  category: string,
): CostScheduleRow[] {
  return rows.filter((r) => r.category !== category);
}

/** A category label not already used, so a freshly added row is a distinct grid row
 *  (the flat schema keys rows by category — duplicate labels would merge). */
export function uniqueCategoryLabel(
  rows: ReadonlyArray<CostScheduleRow>,
  base: string,
): string {
  const existing = new Set(rows.map((r) => r.category));
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/** Append an empty line-item row (placeholder category, 0 at the opening month so it
 *  renders as a blank, editable row). Returns a NEW flat array. */
export function addCategoryRow(
  rows: ReadonlyArray<CostScheduleRow>,
  openingMonth: number,
  base = "New line item",
): CostScheduleRow[] {
  const month = Number.isFinite(openingMonth) && openingMonth >= 1 ? openingMonth : 1;
  return [...rows, { category: uniqueCategoryLabel(rows, base), month, amount: 0 }];
}

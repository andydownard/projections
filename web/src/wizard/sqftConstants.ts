// web/src/wizard/sqftConstants.ts — the client MIRROR of engine/model.py's
// per-sq-ft basis constants (feature #245). These are NOT a second math authority:
// the engine remains the one authority (it derives occupancy, the utilities line,
// and the cost-schedule seed). The client only mirrors the SEED so the wizard can
// (a) pre-fill the adjustable assumptions and (b) shape the Equipment & Fixtures /
// Build-out cost rows from sq ft — exactly the sanctioned `DEFAULT_COST_SCHEDULE`
// mirror the plan calls for (docs/plans/2026-06-27-sqft-rent-utilities §4 / T1.3).
//
// Anchor invariant: at EXAMPLE_BUILDING_SQFT (10,000) each per-sq-ft value × sq ft
// reproduces today's literal exactly ($2.23×10k=$22,300, $4.50×10k=$45,000,
// $5.00×10k=$50,000, $12×10k=$120,000) so a default-size draft is byte-for-byte
// unchanged. Keep these in lock-step with engine/model.py.
import type { CostScheduleRow } from "./shareHelper";

export const EXAMPLE_BUILDING_SQFT = 10000; // engine.model.EXAMPLE_BUILDING_SQFT
export const UTILITIES_PER_SQFT = 2.23; //  22,300 / 10,000  ($/sq ft/yr)
export const FIXTURES_PER_SQFT = 4.5; //    45,000 / 10,000  ($/sq ft)
export const BUILDOUT_PER_SQFT = 5.0; //    50,000 / 10,000  ($/sq ft)
export const DEFAULT_RENT_PER_SQFT = 12; // 120,000 / 10,000 ($/sq ft/yr, golden parity)

// The two cost-schedule categories that scale with sq ft (engine.model.STARTUP keys).
// The Consultant + Legal lines stay flat; only these two are seed-mirrored.
export const FIXTURES_CATEGORY = "Equipment & Fixtures";
export const BUILDOUT_CATEGORY = "Build-out / Renovations / Tenant Improvements";

/** `per_sqft × building_sqft`, rounded to whole cents to defeat float noise so a
 *  whole-dollar seed (e.g. 2.23 × 8000 = 17,840) is exact, never 17839.999…. */
export function scaledDollars(perSqft: number, buildingSqft: number): number {
  return Math.round(perSqft * buildingSqft * 100) / 100;
}

/**
 * Re-derive the two sq-ft-scaled cost rows (Equipment & Fixtures, Build-out) from
 * the current sq ft + per-sq-ft assumptions, preserving every other row (Consultant,
 * Legal, any user-added rows) and each row's month. This mirrors the engine's
 * `default_cost_schedule(building_sqft)` seed so the wizard's Costs step shows the
 * sq-ft-scaled amounts the server would otherwise seed — pure input shaping, NOT
 * projection math (the engine still computes every projected figure).
 */
export function reseedScaledCostRows(
  rows: readonly CostScheduleRow[],
  buildingSqft: number,
  fixturesPerSqft: number,
  buildoutPerSqft: number,
): CostScheduleRow[] {
  const scaled: Record<string, number> = {
    [FIXTURES_CATEGORY]: scaledDollars(fixturesPerSqft, buildingSqft),
    [BUILDOUT_CATEGORY]: scaledDollars(buildoutPerSqft, buildingSqft),
  };
  return rows.map((r) =>
    Object.prototype.hasOwnProperty.call(scaled, r.category)
      ? { ...r, amount: scaled[r.category] }
      : { ...r },
  );
}

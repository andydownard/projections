// web/src/format.ts — the ONE shared client-side number GROUPING formatter (#18).
//
// Presentation only — this does NO math and re-derives NO figure. The server is
// still the single formatting authority for every money/percent value ({ raw,
// display } rendered verbatim, PRD §13). This helper exists ONLY to group raw,
// user-entered INPUT echoes the server never formats — households and square
// footage — so a five-figure count renders "12,500" rather than an ungrouped
// "12500". Locale is pinned to en-US (matching formatListDate) so the grouped
// string is deterministic across environments and never drifts with the viewer's
// locale.
const GROUPED = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Group a raw integer count (households, sqft, …) with thousands separators.
 *  Format-only: the input is the value the operator typed; this never computes a
 *  projection figure. Non-finite values render as an empty string so a partial
 *  input never shows "NaN". */
export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return GROUPED.format(value);
}

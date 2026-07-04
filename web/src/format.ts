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

// ── formatAxisTick — chart axis SCAFFOLDING, not a financial figure (§3.4) ──────
//
// NO-CLIENT-MATH doctrine (identical to formatCount above, and gated the same way):
// this formats a client-DERIVED axis POSITION — a nice-number gridline label like
// "$300,000" that NO month's cumulative value actually equals, so it has no server
// {raw,display} counterpart to render verbatim. It does NO projection math and
// re-derives NO reported business figure; it exists ONLY to label gridlines the
// server never formats. It MUST NEVER be applied to a {raw} data value — every
// plotted point and every table cell still renders the server `display` string
// verbatim. Output matches the server money convention (whole dollars, thousands
// commas, "$" prefix, parentheses for negatives, "$0" literal) so it is visually
// indistinguishable. Prefer server-emitted ticks if the engine ever adds them
// (computed_json.monthlyChart.*Ticks[] as real {raw,display} pairs); this is the
// absent-server-ticks fallback.
export function formatAxisTick(value: number): string {
  if (!Number.isFinite(value)) return "";
  const whole = Math.round(value);
  if (whole === 0) return "$0";
  const grouped = GROUPED.format(Math.abs(whole));
  return whole < 0 ? `($${grouped})` : `$${grouped}`;
}

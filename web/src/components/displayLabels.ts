// web/src/components/displayLabels.ts — client-side PRESENTATION helpers only.
//
// These do NO math and re-derive NO figure. The server remains the single
// formatting authority (PRD §13): every money/percent value is its { raw,
// display } and `display` is rendered verbatim. These helpers only:
//   (#148) read the SIGN of the server `raw` value to drive a negative color
//          cue — the displayed figure itself is never recomputed; the cue is
//          PAIRED with the server's parentheses so meaning is never color-alone.
//   (#151) humanize a few internal enum codes / a raw ISO timestamp that the
//          server does not yet emit a display string for, so a non-finance ED
//          never sees a raw enum/int. Where the server DOES emit a display
//          string we render that instead — see the PR note asking the server to
//          add `basis_display` (and households/source display strings) so these
//          maps can retire.
import type { ServerValue } from "../api/client";

/** True when a server money/percent figure is a loss (raw < 0). Presentation
 *  only — used to pair the error color with the server's parentheses (#148). */
export function isNegative(v: ServerValue | null | undefined): boolean {
  return !!v && v.raw < 0;
}

/** Sign-aware label for the first-year cash trough (#194). The engine emits this
 *  metric as the MIN cumulative cash across the operating window — a true funding
 *  *gap* only when it dips below zero. When the trough stays >= 0 the figure is the
 *  lowest still-positive balance (a cushion), so calling it a "gap" implies a
 *  shortfall that does not exist. Presentation only: we read the SIGN of the server
 *  `raw` to pick the label; the displayed value is always the server's `display`
 *  (no client math, no re-derivation). */
export function cashGapLabel(v: ServerValue | null | undefined): string {
  return v && v.raw < 0 ? "First-year cash gap" : "Lowest first-year cash balance";
}

// Known trade-area `basis` codes → human labels. The server emits no display
// variant for `basis` yet (see PR note); until then this map keeps the raw enum
// off the screen. Unknown codes fall through to a title-cased form so a future
// code can never leak verbatim either.
const BASIS_LABELS: Record<string, string> = {
  city: "City",
  county: "County",
  tract: "Census tract",
  block_group: "Block group",
  zip: "ZIP code",
};

/** Human label for a trade-area `basis` enum code (presentation only). */
export function basisLabel(basis: string | null | undefined): string {
  if (!basis) return "";
  return BASIS_LABELS[basis] ?? titleCase(basis);
}

// Known households-source codes → human labels. Mirrors the trade-area provenance
// language in StepTradeArea so the wizard Review never shows a raw enum (#151).
// Unknown codes fall through to a title-cased form so a future code can never leak.
const HOUSEHOLDS_SOURCE_LABELS: Record<string, string> = {
  census_acs: "U.S. Census",
  user_edited: "Edited",
  manual: "Entered manually",
};

/** Human label for a households-source enum code (presentation only). */
export function householdsSourceLabel(source: string | null | undefined): string {
  if (!source) return "";
  return HOUSEHOLDS_SOURCE_LABELS[source] ?? titleCase(source);
}

function titleCase(code: string): string {
  return code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Friendly, locale-stable "updated" date ("Jun 24, 2026") from a server ISO
 *  timestamp. Display-only — a date is not a projection figure, so formatting it
 *  client-side does not introduce a second math authority. UTC so the rendered
 *  calendar day never drifts with the viewer's timezone; falls back to the raw
 *  date slice if the timestamp is unparseable. */
export function formatListDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

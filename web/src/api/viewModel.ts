// web/src/api/viewModel.ts — the server Appendix-D view-model (PRD Appendix D).
//
// This is the ONE shape the detail/read/role pages render. Every money/percent
// field is { raw, display }; the client renders `display` verbatim and computes
// nothing (PRD §13). Fetch helpers below return the stored snapshot the server
// emits — read is never a recompute.

import type { ServerValue } from "./client";
import type { RecoTag } from "./projections";

export interface Reco {
  tag: RecoTag;
  headline: string;
  sub: string;
}

export interface Metrics {
  capital: ServerValue;
  cashGap: ServerValue;
  breakeven: ServerValue;
  reasonCapital?: string;
  reasonGap?: string;
  reasonBreakeven?: string;
}

/**
 * A timeline milestone as the server's {raw, display} (DATA_MODEL §4, issue #117).
 * `raw` is the project month the milestone lands on, or `null` when it is never
 * reached within the horizon — in which case `display` is "N/A" and `reason`
 * carries the engine's N/A-with-reason flag (never a misleading 0). `payback`
 * additionally carries a plain-language `duration` ("25 months") when reached.
 * The server is the sole formatting authority; the client renders these verbatim.
 */
export interface Milestone {
  raw: number | null;
  display: string;
  duration?: string;
  reason?: string;
}

export interface Milestones {
  grandOpening: Milestone;
  breakEven: Milestone;
  payback: Milestone;
}

/** One §12.2 ± stress scenario (schema 1.6.0) — a FULL engine re-run, not a
 *  linear scale of the base case. `breakeven` is the plain project-month int the
 *  scenario reaches, or `null` when it never does (never a misleading 0). */
export interface SensitivityScenario {
  net: ServerValue;
  breakeven: number | null;
  capital: ServerValue;
}

/** The base/downside/upside §12.2 stress block (schema 1.6.0, audit P0: the
 *  engine already computed this in decision.py but the view-model previously
 *  dropped it). `delta` is the ± fraction (0.25 default) driving the "rent
 *  +25% / donations −25%" framing — rendered from THIS field, never hard-coded. */
export interface Sensitivity {
  base: SensitivityScenario;
  downside: SensitivityScenario;
  upside: SensitivityScenario;
  delta: number;
}

/** The ramp low-confidence flag (schema 1.6.0) surfaced next to the
 *  ramp-dependent metrics (break-even, cash gap): the monthly S-curve has never
 *  been calibrated against a real opening (ENGINE_CONTRACT §12). */
export interface Confidence {
  ramp: "low" | "high";
}

export interface Kpi {
  label: string;
  value: ServerValue;
  sub?: string;
  color?: string;
}

export interface MonthlyPoint {
  month: number;
  revenue: ServerValue;
  expenses: ServerValue;
  net: ServerValue;
  cumulativeCash: ServerValue;
}

export interface Row {
  label: string;
  group: string;
  y1: ServerValue | null;
  y2: ServerValue | null;
  y3: ServerValue | null;
  /** Years 4 + 5 (engine ≥ 2.6.0). Optional so stored 3-year snapshots — which
   *  carry only y1..y3 — still satisfy the type. The detail table is rendered
   *  YEAR-COUNT-AGNOSTICALLY: it derives the present `yN` columns from the row,
   *  so a legacy 3-year row renders 3 columns and a 2.6.0 row renders 5. */
  y4?: ServerValue | null;
  y5?: ServerValue | null;
  class: string;
  editable: boolean;
  node?: string;
}

/** The year keys a row may carry, in order (for the year-count-agnostic table). */
export type YearKey = "y1" | "y2" | "y3" | "y4" | "y5";

/** The present year columns of a 5-year (or legacy 3-year) projection: a year is
 *  "present" when at least one row carries that `yN` key (engine ≥ 2.6.0 always
 *  emits y1..y5; a stored 3-year snapshot omits y4/y5). Display only — no math. */
export function presentYears(rows: Row[]): number[] {
  const all: Array<{ n: number; key: YearKey }> = [
    { n: 1, key: "y1" },
    { n: 2, key: "y2" },
    { n: 3, key: "y3" },
    { n: 4, key: "y4" },
    { n: 5, key: "y5" },
  ];
  return all.filter(({ key }) => rows.some((r) => r[key] !== undefined)).map(({ n }) => n);
}

/** One pinned override as the engine emits it (viewmodel.py): the pinned value +
 *  the calculated value it replaced (both server display strings), the justification
 *  note stored on the pin, and the derived rows the pin foots through. The frontend
 *  renders these VERBATIM and re-pins via the EXISTING contract (no client math). */
export interface OverrideEntry {
  node: string;
  year: number;
  /** The value the engine would derive with the pin absent ({raw,display} or "N/A"). */
  calculated?: ServerValue | string | null;
  /** The pinned value as a server display string + its raw for re-pinning. */
  value: ServerValue;
  /** The justification note stored on the override (DATA_MODEL §4.6). */
  note?: string;
  pinnedDate?: string;
  /** Derived rows this pin rewrites (foot-through to totals/net/margin). */
  affected?: string[];
}

export interface LocationInfo {
  place_id?: string;
  lat: number;
  lng: number;
  formatted_address: string;
}

export interface TradeAreaInfo {
  basis: string;
  households: string | number | null;
  geography_name?: string | null;
  geography_fips?: string | null;
  acs_vintage?: string | null;
  households_source?: string | null;
  moe?: number | null;
}

export interface EvidenceItem {
  field: string;
  label: string;
  value: string | number | null;
  /** Server-rendered display string (sole formatting authority, PRD §13). */
  value_display?: string | null;
  method: string;
  source: string;
  source_date: string;
  confidence: string;
  geography?: string | null;
  moe?: number | null;
  /** Server-rendered MOE display string; rendered verbatim. */
  moe_display?: string | null;
}

export interface ViewModel {
  reco: Reco;
  metrics: Metrics;
  /** Three detail-page milestones (compute_schema_version ≥ 1.2.0). Optional so
   *  older stored snapshots that predate the field still render. */
  milestones?: Milestones;
  kpis: Kpi[];
  monthly: MonthlyPoint[];
  breakevenMonth: number | null;
  /** Annual NET INCOME Y1..Y5 ({raw,display}) — the Income sparkline source
   *  (engine ≥ 2.6.0). Optional so legacy snapshots without it still render. */
  incomeSeries?: ServerValue[];
  /** Year-5 net income ({raw,display}) — the small "Y5 income" sparkline label. */
  year5Income?: ServerValue;
  rows: Row[];
  /** The pinned overrides (Override audit + Penny justification capture). */
  overrides?: OverrideEntry[];
  /** §12.2 base/downside/upside stress scenarios (schema ≥ 1.6.0). Optional so
   *  legacy stored snapshots that predate it still render (banner degrades
   *  cleanly — no downside line). */
  sensitivity?: Sensitivity;
  /** The ramp low-confidence flag (schema ≥ 1.6.0). Optional — same legacy-
   *  snapshot reasoning as `sensitivity`. */
  confidence?: Confidence;
  /** Node ids whose upstream inputs changed since the pin (stale-upstream flag). */
  staleNodes?: string[];
  settings: Record<string, ServerValue | number | string>;
  flags?: Record<string, unknown>;
  evidence?: EvidenceItem[];
  location?: LocationInfo | null;
  trade_area?: TradeAreaInfo;
  version: number;
  view_slug: string;
  name: string;
  /** Server-stamped last-updated time (ISO). Optional — the read endpoint only
   *  includes it when available; the header renders it ONLY when present (never a
   *  fabricated date, UI rule). */
  updated_at?: string;
  model_version?: string;
  role?: string;
  readOnly?: boolean;
}

const BASE = "/api";

async function getJson<T>(path: string): Promise<T> {
  const resp = await fetch(`${BASE}${path}`);
  if (!resp.ok) throw new Error(`GET ${path} failed: ${resp.status}`);
  return (await resp.json()) as T;
}

/** Read the stored snapshot by view_slug (read-only or owner/edit). */
export function fetchProjection(viewSlug: string): Promise<ViewModel> {
  return getJson<ViewModel>(`/projections/${encodeURIComponent(viewSlug)}`);
}

/** Read a role share link (board/funder/advisor) — verdict travels verbatim. */
export function fetchRoleView(roleSlug: string): Promise<ViewModel> {
  return getJson<ViewModel>(`/r/${encodeURIComponent(roleSlug)}`);
}

/** Absolute URL to the formula-driven .xlsx export (a plain anchor href). */
export function xlsxHref(viewSlug: string): string {
  return `${BASE}/projections/${encodeURIComponent(viewSlug)}/xlsx`;
}

/** Absolute URL to the monthly cash-flow CSV export (a plain anchor href). Like
 *  {@link xlsxHref} the GET is reachable with the slug alone (terms stamped at
 *  create), so this is a plain download link — no auth header in the URL. */
export function cashflowCsvHref(viewSlug: string): string {
  return `${BASE}/projections/${encodeURIComponent(viewSlug)}/cashflow.csv`;
}

/** Absolute URL to the board-packet .docx export (a plain anchor href). The GET
 *  packet endpoint is reachable with the slug alone (terms already stamped at
 *  create), so this is a plain download link — no auth header in the URL. */
export function docxHref(viewSlug: string): string {
  return `${BASE}/projections/${encodeURIComponent(viewSlug)}/packet?format=docx`;
}

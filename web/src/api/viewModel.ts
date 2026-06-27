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
  class: string;
  editable: boolean;
  node?: string;
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
  rows: Row[];
  settings: Record<string, ServerValue | number | string>;
  flags?: Record<string, unknown>;
  evidence?: EvidenceItem[];
  location?: LocationInfo | null;
  trade_area?: TradeAreaInfo;
  version: number;
  view_slug: string;
  name: string;
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

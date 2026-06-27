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

// web/src/wizard/shareHelper.ts — wizard-only estimate affordance + payload builder.
//
// IMPORTANT (PRD §13 / CLAUDE.md hard rule): the projection is server-authoritative.
// This file does NOT compute the projection. It renders a pre-create "at a glance"
// helper — "X% of ~N households → ~D donations/week → ~$R revenue" — so a
// non-finance user can sanity-check a Year share BEFORE Generate (PRD §7.1 says
// "the app converts" share ⇄ donations/week). The authoritative numbers come back
// from the server's compute on POST /api/projections. Nothing here is rendered as
// a projection figure; the detail page renders only the server view-model.

export interface ShareHelperInput {
  households: number;
  sharePct: number;
  donationsPerHh: number;
  basket: number;
}

export interface ShareHelperResult {
  donationsPerWeek: number | null;
  annualRevenue: number | null;
  text: string;
}

const WEEKS_PER_YEAR = 52;

/** Pre-create estimate of donations/week and annual revenue for one share value. */
export function shareHelper(input: ShareHelperInput): ShareHelperResult {
  const { households, sharePct, donationsPerHh, basket } = input;
  if (!households || households <= 0) {
    return {
      donationsPerWeek: null,
      annualRevenue: null,
      text: "Enter households to preview donations/week",
    };
  }
  const donationsPerYear = households * (sharePct / 100) * donationsPerHh;
  const donationsPerWeek = Math.round(donationsPerYear / WEEKS_PER_YEAR);
  const annualRevenue = Math.round(donationsPerYear * basket);
  const nf = new Intl.NumberFormat("en-US");
  return {
    donationsPerWeek,
    annualRevenue,
    text:
      `${sharePct}% of ~${nf.format(households)} households → ` +
      `~${nf.format(donationsPerWeek)} donations/week → ` +
      `~$${nf.format(annualRevenue)}/yr revenue`,
  };
}

export interface SharePreset {
  label: string;
  /** Year-1, Year-2, Year-3 share percentages (a ramp the user then edits). */
  shares: [number, number, number];
}

// Benchmark presets (PRD §7.1). Each pre-fills a ramp the user edits per year;
// all three years stay EXPLICIT (no auto-midpoint at create — PRD §7.1 / trap #1).
export const PRESETS: SharePreset[] = [
  { label: "Conservative", shares: [5, 6, 7] },
  { label: "Moderate", shares: [7, 8, 9] },
  { label: "Aggressive", shares: [10, 12, 14] },
];

export const SHARE_BENCHMARK_NOTE =
  "An established Longview store runs ≈ 7% of trade-area households.";

/**
 * Even-ramp helper: pre-fill Year 2 as the midpoint of Year 1 and Year 3. The
 * field stays editable — this only seeds a starting value (PRD §7.1).
 */
export function evenRampY2(y1: number, y3: number): number {
  return Math.round(((y1 + y3) / 2) * 10) / 10;
}

export type TradeAreaBasis = "city" | "county" | "manual";
export type LeaseType = "gross" | "nnn";

export interface WizardDraft {
  name: string;
  city: string;
  state: string;
  basis: TradeAreaBasis;
  households: number;
  buildingSqft: number;
  salesfloorPct: number;
  leaseType: LeaseType;
  donationValue: number;
  basket: number;
  donationsPerHh: number;
  shareY1: number;
  shareY2: number;
  shareY3: number;
  occupancyAnnual: number;
  cash: number;
  grant: number;
  loan: number;
  termsAccepted: boolean;
}

export interface CreatePayload {
  name: string;
  location: { query: string };
  trade_area: { basis: TradeAreaBasis; households: number };
  inputs: {
    building_sqft: number;
    salesfloor_pct: number;
    lease_type: LeaseType;
    donation_value: number;
    occupancy_annual: number;
    demand: {
      mode: "market_share";
      share_y1: number;
      share_y2: number;
      share_y3: number;
    };
    source_of_funds: { cash: number; grant: number; loan: number };
  };
  terms_accepted: boolean;
}

/**
 * The flat create body the FastAPI `CreateProjectionIn` model actually accepts
 * (app/routers/projections.py): a flat `inputs` with string fractions, a single
 * `source_of_funds` total string, and string `households`. This adapts the nested
 * API_SPEC §4.2 payload to the in-repo backend shape so the wizard's Generate POSTs
 * a body the server validates. Still NO client math — only string shaping.
 */
export interface ServerCreateBody {
  name: string;
  inputs: {
    org_name: string;
    city: string;
    opening_status: string;
    share_y1: string;
    share_y2: string;
    share_y3: string;
    donation_value: string;
    building_sqft: string;
    salesfloor_pct: string;
    source_of_funds: string;
    occupancy_annual: string;
    lease_type: LeaseType;
    nnn_opex_annual: string;
  };
  trade_area: { basis: TradeAreaBasis; households: string };
  location: { query: string };
  terms_accepted: boolean;
}

export function toServerCreateBody(p: CreatePayload): ServerCreateBody {
  const funds = p.inputs.source_of_funds;
  const total = (funds.cash || 0) + (funds.grant || 0) + (funds.loan || 0);
  return {
    name: p.name,
    inputs: {
      org_name: p.name,
      city: p.location.query,
      opening_status: "pre_launch",
      share_y1: String(p.inputs.demand.share_y1),
      share_y2: String(p.inputs.demand.share_y2),
      share_y3: String(p.inputs.demand.share_y3),
      donation_value: String(p.inputs.donation_value),
      building_sqft: String(p.inputs.building_sqft),
      salesfloor_pct: String(p.inputs.salesfloor_pct),
      source_of_funds: String(total),
      occupancy_annual: String(p.inputs.occupancy_annual),
      lease_type: p.inputs.lease_type,
      nnn_opex_annual: "0",
    },
    trade_area: { basis: p.trade_area.basis, households: String(p.trade_area.households) },
    location: { query: p.location.query },
    terms_accepted: p.terms_accepted,
  };
}

/** Map a wizard draft to the POST /api/projections body (API_SPEC §4.2). */
export function buildCreatePayload(d: WizardDraft): CreatePayload {
  return {
    name: d.name,
    location: { query: [d.city, d.state].filter(Boolean).join(", ") },
    trade_area: { basis: d.basis, households: d.households },
    inputs: {
      building_sqft: d.buildingSqft,
      salesfloor_pct: d.salesfloorPct / 100,
      lease_type: d.leaseType,
      donation_value: d.donationValue,
      occupancy_annual: d.occupancyAnnual,
      demand: {
        mode: "market_share",
        share_y1: d.shareY1 / 100,
        share_y2: d.shareY2 / 100,
        share_y3: d.shareY3 / 100,
      },
      source_of_funds: { cash: d.cash, grant: d.grant, loan: d.loan },
    },
    terms_accepted: d.termsAccepted,
  };
}

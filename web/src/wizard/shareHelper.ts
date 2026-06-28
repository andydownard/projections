// web/src/wizard/shareHelper.ts — the wizard's create-payload builder.
//
// IMPORTANT (PRD §13 / CLAUDE.md hard rule): the projection is server-authoritative.
// This file does NOT compute the projection — it only shapes the create-request
// body (buildCreatePayload + toServerCreateBody). The authoritative numbers come
// back from the server's compute on POST /api/projections; the detail page renders
// only the server view-model.

export type TradeAreaBasis = "city" | "county" | "manual";
export type LeaseType = "gross" | "nnn";

/**
 * One timed startup line item (Spec §5): a labelled cost landing on a project
 * month. The client only collects it — `month >= 1` / `amount >= 0` and the
 * derived totals are validated/computed server-side (no client math, PRD §13).
 */
export interface CostScheduleRow {
  category: string;
  month: number;
  amount: number;
  /**
   * Optional opaque provenance for a row Penny built from a proposal (Spec B §9,
   * DATA_MODEL §7), e.g. `{ source: "ai", turn_id }`. The client never reads it —
   * it is round-tripped from /penny/draft straight into the create body so the
   * server can persist it (it is filtered out of the engine inputs). NOT math.
   */
  provenance?: Record<string, unknown>;
}

/** The legacy/migration-default timed cost schedule (mirrors engine.model.STARTUP):
 * a single lump at month 1 — reproduces today's numbers when opening month = 1. */
export const DEFAULT_COST_SCHEDULE: ReadonlyArray<CostScheduleRow> = [
  { category: "Thrift Store Consultant", month: 1, amount: 100000 },
  { category: "Equipment & Fixtures", month: 1, amount: 45000 },
  { category: "Build-out / Renovations / Tenant Improvements", month: 1, amount: 50000 },
  { category: "Legal, Permits, Insurance Setup, Signage", month: 1, amount: 13500 },
];

export const DEFAULT_OPENING_MONTH_NUMBER = 1;

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
  // Occupancy is now driven by sq ft × rent (feature #245): the wizard sends
  // `rent_per_sqft` and the engine resolves occupancy = building_sqft × rent_per_sqft.
  // `occupancyAnnual` is kept for the Penny draft bridge / server back-compat only.
  occupancyAnnual: number;
  rentPerSqft: number;
  // Sq-ft-scaled cost assumptions (feature #245). `utilitiesPerSqft` flows to the
  // engine `Assumptions` (utilities line = sq ft × this); `fixturesPerSqft` /
  // `buildoutPerSqft` seed the matching cost-schedule rows (mirror of the server's
  // `default_cost_schedule`). All anchored so 10,000 sq ft reproduces today's $.
  utilitiesPerSqft: number;
  fixturesPerSqft: number;
  buildoutPerSqft: number;
  cash: number;
  grant: number;
  loan: number;
  termsAccepted: boolean;
  // Timed cost schedule + opening anchor (Spec §5/§7). Optional so existing
  // callers compile; buildCreatePayload supplies the month-1-lump default.
  targetOpeningDate?: string;
  openingMonthNumber?: number;
  costSchedule?: CostScheduleRow[];
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
    // Occupancy = building_sqft × rent_per_sqft, resolved server-side (#245). The
    // flat occupancy_annual is no longer sent; the engine accepts either (it is kept
    // server-side for Penny/back-compat) but the wizard ships rent_per_sqft.
    rent_per_sqft: number;
    demand: {
      mode: "market_share";
      share_y1: number;
      share_y2: number;
      share_y3: number;
    };
    source_of_funds: { cash: number; grant: number; loan: number };
    // Opening anchor + timed cost schedule (Spec §5/§7). Optional on the payload
    // type so legacy callers compile; buildCreatePayload always populates them
    // (target_opening_date is null when the operator hasn't set one — the server
    // falls back to the default).
    target_opening_date?: string | null;
    opening_month_number?: number;
    cost_schedule?: CostScheduleRow[];
  };
  // Sq-ft-scaled cost assumptions the engine consumes (#245). Utilities is derived
  // as building_sqft × utilities_per_sqft, so the wizard ships the adjustable rate.
  assumptions: {
    utilities_per_sqft: number;
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
    // Occupancy driver (#245): the wizard ships rent_per_sqft and leaves
    // occupancy_annual null so the engine resolves occupancy = sq ft × rent.
    occupancy_annual: string | null;
    rent_per_sqft: string;
    lease_type: LeaseType;
    nnn_opex_annual: string;
    // Opening anchor + timed cost schedule (Spec §5/§7). The backend InputsIn
    // model validates these (month >= 1, amount >= 0, opening_month_number >= 1).
    target_opening_date: string | null;
    opening_month_number: number;
    cost_schedule: CostScheduleRow[];
  };
  // Sq-ft-scaled cost assumptions (#245). The backend AssumptionsIn accepts
  // utilities_per_sqft; the engine derives the utilities line from it.
  assumptions: {
    utilities_per_sqft: string;
  };
  trade_area: {
    basis: TradeAreaBasis;
    households: string;
    // Places->Census provenance (optional; server persists + emits it).
    geography_name?: string;
    geography_fips?: string;
    acs_vintage?: string;
    households_source?: string;
    moe?: number | null;
  };
  location: {
    query: string;
    place_id?: string;
    lat?: number;
    lng?: number;
    formatted_address?: string;
  };
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
      // rent_per_sqft drives occupancy (#245); occupancy_annual is left null so the
      // engine resolves occupancy = building_sqft × rent_per_sqft, not a flat $.
      occupancy_annual: null,
      rent_per_sqft: String(p.inputs.rent_per_sqft),
      lease_type: p.inputs.lease_type,
      nnn_opex_annual: "0",
      target_opening_date: p.inputs.target_opening_date ?? null,
      opening_month_number: p.inputs.opening_month_number ?? DEFAULT_OPENING_MONTH_NUMBER,
      cost_schedule: p.inputs.cost_schedule ?? DEFAULT_COST_SCHEDULE.map((r) => ({ ...r })),
    },
    assumptions: { utilities_per_sqft: String(p.assumptions.utilities_per_sqft) },
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
      rent_per_sqft: d.rentPerSqft,
      demand: {
        mode: "market_share",
        share_y1: d.shareY1 / 100,
        share_y2: d.shareY2 / 100,
        share_y3: d.shareY3 / 100,
      },
      source_of_funds: { cash: d.cash, grant: d.grant, loan: d.loan },
      target_opening_date: d.targetOpeningDate ?? null,
      opening_month_number: d.openingMonthNumber ?? DEFAULT_OPENING_MONTH_NUMBER,
      cost_schedule: d.costSchedule ?? DEFAULT_COST_SCHEDULE.map((r) => ({ ...r })),
    },
    assumptions: { utilities_per_sqft: d.utilitiesPerSqft },
    terms_accepted: d.termsAccepted,
  };
}

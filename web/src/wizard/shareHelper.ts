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
  // Salvage % of retail (Wave 2 Task 2.3) — HUMAN units (e.g. 0.8 for 0.8%), not
  // yet sent to the server (task 2.6 wires the create-payload mapper).
  salvagePct: number;
  shareY1: number;
  shareY2: number;
  shareY3: number;
  shareY4: number;
  shareY5: number;
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
  // NNN lease operating expenses (Wave 2 Task 2.2). Only meaningful/shown when
  // leaseType === "nnn"; not yet sent to the server (task 2.6 wires the mapper).
  nnnOpexAnnual: number;
  cash: number;
  grant: number;
  loan: number;
  // Rent/cost/funding advanced drivers (Wave 2 Task 2.4) — HUMAN units (e.g. 60 for
  // 60%, 25000 for $25,000). Not yet sent to the server (task 2.6 wires the
  // create-payload mapper). Defaults reproduce today's engine defaults byte-for-byte
  // (anchor invariant) — see ENGINE_CONTRACT.md §1 for the resolved-default table.
  escalatorPct: number;
  laborPct: number;
  marketingPct: number;
  suppliesPct: number;
  cardPct: number;
  payrollTaxPct: number;
  reserveBuffer: number;
  sensitivityDeltaPct: number;
  // Five fixed annual operating-cost lines, keyed by their exact label (task 2.4).
  fixedAnnual: Record<string, number>;
  termsAccepted: boolean;
  // Timed cost schedule + opening anchor (Spec §5/§7). Optional so existing
  // callers compile; buildCreatePayload supplies the month-1-lump default.
  // `targetOpeningDate` is DROPPED entirely (owner Decision 13) — the grand-opening
  // month is set on the cost step; buildCreatePayload always sends a null date.
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
    // NNN operating expenses (Task 2.2/2.6). Human $ here; stringified in the flat
    // backend body. 0 for a gross lease / an unset NNN opex — anchor-clean default.
    nnn_opex_annual: number;
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
      share_y4: number;
      share_y5: number;
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
  // Engine assumptions the wizard now sends (Wave 2 Task 2.6). Utilities is derived
  // as building_sqft × utilities_per_sqft (#245); the advanced cost/rent/funding knobs
  // (Tasks 2.2–2.4) are carried here so the operator's edits reach the engine. Percent
  // knobs are FRACTIONS in this nested payload (human % ÷ 100 in buildCreatePayload,
  // the same ÷100 convention the shares use); basket/donations/reserve are counts/$
  // and fixed_annual is a {label: annual $} dict. NO client math (PRD §13) — shaping only.
  assumptions: {
    utilities_per_sqft: number;
    basket: number;
    donations_per_hh: number;
    salvage_pct: number;
    labor_pct: number;
    marketing_pct: number;
    supplies_pct: number;
    card_pct: number;
    payroll_tax_pct: number;
    escalator: number;
    reserve_buffer: number;
    sensitivity_delta: number;
    fixed_annual: Record<string, number>;
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
    share_y4: string;
    share_y5: string;
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
  // Engine assumptions the backend AssumptionsIn accepts (Wave 2 Task 2.6). The %
  // knobs are STRING fractions (the shares' String(6/100) === "0.06" convention);
  // basket is a $ string; reserve_buffer / donations_per_hh stay NUMBERS (int) and
  // fixed_annual stays a {label: annual $} dict. The engine derives the utilities line
  // from utilities_per_sqft (#245). Nothing here is computed on the client (PRD §13).
  assumptions: {
    utilities_per_sqft: string;
    basket: string;
    donations_per_hh: number;
    salvage_pct: string;
    labor_pct: string;
    marketing_pct: string;
    supplies_pct: string;
    card_pct: string;
    payroll_tax_pct: string;
    escalator: string;
    reserve_buffer: number;
    sensitivity_delta: string;
    fixed_annual: Record<string, number>;
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
      share_y4: String(p.inputs.demand.share_y4),
      share_y5: String(p.inputs.demand.share_y5),
      donation_value: String(p.inputs.donation_value),
      building_sqft: String(p.inputs.building_sqft),
      salesfloor_pct: String(p.inputs.salesfloor_pct),
      source_of_funds: String(total),
      // rent_per_sqft drives occupancy (#245); occupancy_annual is left null so the
      // engine resolves occupancy = building_sqft × rent_per_sqft, not a flat $.
      occupancy_annual: null,
      rent_per_sqft: String(p.inputs.rent_per_sqft),
      lease_type: p.inputs.lease_type,
      // NNN operating expenses (Task 2.2/2.6) — a $ string on inputs; "0" for a gross
      // lease or an unset NNN opex (the draft default), so a create is anchor-clean.
      nnn_opex_annual: String(p.inputs.nnn_opex_annual),
      target_opening_date: p.inputs.target_opening_date ?? null,
      opening_month_number: p.inputs.opening_month_number ?? DEFAULT_OPENING_MONTH_NUMBER,
      cost_schedule: p.inputs.cost_schedule ?? DEFAULT_COST_SCHEDULE.map((r) => ({ ...r })),
    },
    assumptions: {
      utilities_per_sqft: String(p.assumptions.utilities_per_sqft),
      basket: String(p.assumptions.basket),
      // % fractions -> string (AssumptionsIn takes str fractions; Decimal-parsed server-side).
      salvage_pct: String(p.assumptions.salvage_pct),
      labor_pct: String(p.assumptions.labor_pct),
      marketing_pct: String(p.assumptions.marketing_pct),
      supplies_pct: String(p.assumptions.supplies_pct),
      card_pct: String(p.assumptions.card_pct),
      payroll_tax_pct: String(p.assumptions.payroll_tax_pct),
      escalator: String(p.assumptions.escalator),
      sensitivity_delta: String(p.assumptions.sensitivity_delta),
      // int / int / {label: $} — stay numbers (AssumptionsIn takes int + a dict here).
      reserve_buffer: p.assumptions.reserve_buffer,
      donations_per_hh: p.assumptions.donations_per_hh,
      fixed_annual: { ...p.assumptions.fixed_annual },
    },
    trade_area: { basis: p.trade_area.basis, households: String(p.trade_area.households) },
    location: { query: p.location.query },
    terms_accepted: p.terms_accepted,
  };
}

/** Map a wizard draft to the POST /api/projections body (API_SPEC §4.2). */
export function buildCreatePayload(d: WizardDraft): CreatePayload {
  const query = [d.city, d.state].filter(Boolean).join(", ");
  // QA P2 #24 — the store name is OPTIONAL and the field placeholder promises it
  // "Defaults to the address." A BLANK (or whitespace-only) name resolves to the
  // address here so the server never falls back to its "Untitled projection"
  // placeholder. d.city holds the resolved formatted_address (onResolved), so the
  // address-derived name flows into BOTH name + inputs.org_name (toServerCreateBody).
  const name = d.name.trim() || query;
  return {
    name,
    location: { query },
    trade_area: { basis: d.basis, households: d.households },
    inputs: {
      building_sqft: d.buildingSqft,
      salesfloor_pct: d.salesfloorPct / 100,
      lease_type: d.leaseType,
      nnn_opex_annual: d.nnnOpexAnnual,
      donation_value: d.donationValue,
      rent_per_sqft: d.rentPerSqft,
      demand: {
        mode: "market_share",
        share_y1: d.shareY1 / 100,
        share_y2: d.shareY2 / 100,
        share_y3: d.shareY3 / 100,
        share_y4: d.shareY4 / 100,
        share_y5: d.shareY5 / 100,
      },
      source_of_funds: { cash: d.cash, grant: d.grant, loan: d.loan },
      // Target opening date is dropped (owner Decision 13); always null server-side.
      target_opening_date: null,
      opening_month_number: d.openingMonthNumber ?? DEFAULT_OPENING_MONTH_NUMBER,
      cost_schedule: d.costSchedule ?? DEFAULT_COST_SCHEDULE.map((r) => ({ ...r })),
    },
    // Advanced knobs (Wave 2 Tasks 2.2–2.4) — HUMAN units on the draft (60 for 60%,
    // 0.8 for 0.8%). Percent knobs are shaped to FRACTIONS with the SAME ÷100 convention
    // the shares use (shareY1 6 -> 0.06); basket/donations/reserve are counts/$ passed
    // through; fixed_annual is a {label: annual $} dict. Display shaping, NOT client math.
    assumptions: {
      utilities_per_sqft: d.utilitiesPerSqft,
      basket: d.basket,
      donations_per_hh: d.donationsPerHh,
      salvage_pct: d.salvagePct / 100,
      labor_pct: d.laborPct / 100,
      marketing_pct: d.marketingPct / 100,
      supplies_pct: d.suppliesPct / 100,
      card_pct: d.cardPct / 100,
      payroll_tax_pct: d.payrollTaxPct / 100,
      escalator: d.escalatorPct / 100,
      reserve_buffer: d.reserveBuffer,
      sensitivity_delta: d.sensitivityDeltaPct / 100,
      fixed_annual: { ...d.fixedAnnual },
    },
    terms_accepted: d.termsAccepted,
  };
}

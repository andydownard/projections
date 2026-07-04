import { describe, expect, it } from "vitest";

import { buildCreatePayload, toServerCreateBody, type WizardDraft } from "./shareHelper";
import { DEFAULT_DRAFT } from "./useWizardState";

// Engine defaults transcribed from engine/model.py (the ONE math authority, PRD §13).
// A pristine-wizard create must reproduce these so a create with NO assumptions and a
// create from a default draft compute identically (the anchor invariant): newly
// exposed knobs regen goldens only for the ADDED settings keys, never changed numbers.
const ENGINE_DEFAULTS = {
  // % knobs — the engine stores each as a STRING fraction:
  labor_pct: "0.60", //         LABOR_PCT_OF_REVENUE
  marketing_pct: "0.0375", //   MARKETING_PCT_OF_REVENUE
  supplies_pct: "0.05", //      SUPPLIES_PCT_OF_REVENUE
  card_pct: "0.02", //          CARD_FEES_PCT_OF_REVENUE
  payroll_tax_pct: "0.075", //  PAYROLL_TAX_PCT_OF_PAYROLL
  salvage_pct: "0.008", //      SALVAGE_PCT_OF_RETAIL
  escalator: "0.03", //         RENT_ESCALATOR
  sensitivity_delta: "0.25", // SENSITIVITY_DELTA
  utilities_per_sqft: "2.23", // UTILITIES_PER_SQFT
  basket: "17.08", //           AVG_BASKET_VALUE
  // non-% knobs stay numbers (the server takes int / dict here, not string fractions):
  reserve_buffer: 25000, //     CASH_RESERVE_BUFFER (int)
  donations_per_hh: 3, //       DONATIONS_PER_HH_PER_YEAR (int)
  fixed_annual: {
    // FIXED_ANNUAL (label -> annual $)
    "Insurance liability": 2000,
    "Internet, Phones": 3000,
    "Pest control": 300,
    "Repairs/maintenance": 1600,
    "Security system": 900,
  },
} as const;

// The wizard's create-payload shaping: buildCreatePayload (draft -> nested payload)
// + toServerCreateBody (nested -> flat backend body). No client projection math —
// the authoritative numbers come back from the server compute (PRD §13).

// A draft sized at the example 10,000 sq ft × $12 rent so occupancy resolves to
// $120,000 server-side — golden parity with the old flat occupancy_annual default.
const DRAFT: WizardDraft = {
  name: "House of Hope — Longview, TX",
  city: "Longview",
  state: "TX",
  basis: "city",
  households: 31800,
  buildingSqft: 10000,
  salesfloorPct: 70,
  leaseType: "nnn",
  donationValue: 74,
  basket: 17.08,
  donationsPerHh: 3,
  salvagePct: 0.8,
  shareY1: 6,
  shareY2: 8,
  shareY3: 10,
  shareY4: 11,
  shareY5: 12,
  occupancyAnnual: 120000,
  rentPerSqft: 12,
  utilitiesPerSqft: 2.23,
  fixturesPerSqft: 4.5,
  buildoutPerSqft: 5.0,
  nnnOpexAnnual: 0,
  cash: 150000,
  grant: 50000,
  loan: 0,
  escalatorPct: 3,
  laborPct: 60,
  marketingPct: 3.75,
  suppliesPct: 5,
  cardPct: 2,
  payrollTaxPct: 7.5,
  reserveBuffer: 25000,
  sensitivityDeltaPct: 25,
  fixedAnnual: {
    "Insurance liability": 2000,
    "Internet, Phones": 3000,
    "Pest control": 300,
    "Repairs/maintenance": 1600,
    "Security system": 900,
  },
  termsAccepted: true,
};

describe("buildCreatePayload (maps wizard draft → POST /api/projections body)", () => {
  it("emits three EXPLICIT shares as fractions — never an auto-midpoint", () => {
    const payload = buildCreatePayload(DRAFT);
    expect(payload.name).toBe("House of Hope — Longview, TX");
    expect(payload.trade_area).toEqual({ basis: "city", households: 31800 });
    expect(payload.inputs.demand).toEqual({
      mode: "market_share",
      share_y1: 0.06,
      share_y2: 0.08,
      share_y3: 0.1,
      share_y4: 0.11,
      share_y5: 0.12,
    });
    expect(payload.inputs.building_sqft).toBe(10000);
    expect(payload.inputs.salesfloor_pct).toBe(0.7);
    expect(payload.inputs.lease_type).toBe("nnn");
    expect(payload.inputs.source_of_funds).toEqual({ cash: 150000, grant: 50000, loan: 0 });
    expect(payload.terms_accepted).toBe(true);
  });

  it("ships rent_per_sqft (not a flat occupancy) + the utilities $/sq ft assumption (#245)", () => {
    const payload = buildCreatePayload(DRAFT);
    expect(payload.inputs.rent_per_sqft).toBe(12);
    expect(payload.assumptions.utilities_per_sqft).toBe(2.23);
    // occupancy is no longer a first-class payload field — the engine derives it.
    expect("occupancy_annual" in payload.inputs).toBe(false);
  });

  // Task 2.6: the advanced cost/rent/funding knobs (Wave 2 Tasks 2.2–2.4) are HUMAN
  // units on the draft (60 for 60%, 0.8 for 0.8%). buildCreatePayload shapes the %
  // knobs to fractions with the SAME ÷100 convention the shares already use
  // (shareY1 6 -> 0.06); reserve_buffer / donations / fixed_annual are counts/$ and
  // stay as-is. This is display shaping, NOT client math (PRD §13).
  it("shapes the advanced % knobs to fractions (÷100) and leaves counts/$ untouched", () => {
    const p = buildCreatePayload(DRAFT);
    expect(p.assumptions.labor_pct).toBe(0.6); //         60 / 100
    expect(p.assumptions.salvage_pct).toBe(0.008); //     0.8 / 100
    expect(p.assumptions.marketing_pct).toBe(0.0375); //  3.75 / 100
    expect(p.assumptions.supplies_pct).toBe(0.05); //     5 / 100
    expect(p.assumptions.card_pct).toBe(0.02); //         2 / 100
    expect(p.assumptions.payroll_tax_pct).toBe(0.075); // 7.5 / 100
    expect(p.assumptions.escalator).toBe(0.03); //        3 / 100
    expect(p.assumptions.sensitivity_delta).toBe(0.25); // 25 / 100
    // counts / dollars / dict — NOT ÷100:
    expect(p.assumptions.reserve_buffer).toBe(25000);
    expect(p.assumptions.basket).toBe(17.08);
    expect(p.assumptions.donations_per_hh).toBe(3);
    expect(p.assumptions.fixed_annual).toEqual(DRAFT.fixedAnnual);
    expect(p.assumptions.fixed_annual["Pest control"]).toBe(300);
  });

  it("defaults the opening anchor + cost schedule to a month-1 lump when unset", () => {
    const payload = buildCreatePayload({ ...DRAFT, name: "Legacy default" });
    // Defaults reproduce today's numbers: every startup line at month 1, opening
    // month 1 (no pre-opening months) — Spec §7 migration default.
    expect(payload.inputs.opening_month_number).toBe(1);
    expect(payload.inputs.target_opening_date).toBeNull();
    const schedule = payload.inputs.cost_schedule ?? [];
    expect(schedule.every((r) => r.month === 1)).toBe(true);
    expect(schedule.length).toBeGreaterThan(0);
  });

  it("forwards an explicit opening month + timed cost schedule (target date dropped)", () => {
    const payload = buildCreatePayload({
      ...DRAFT,
      name: "Timed schedule",
      openingMonthNumber: 4,
      costSchedule: [
        { category: "Consultant", month: 1, amount: 50000 },
        { category: "Build-out", month: 3, amount: 60000 },
      ],
    });
    // Target opening date is dropped entirely (owner Decision 13) — always null.
    expect(payload.inputs.target_opening_date).toBeNull();
    expect(payload.inputs.opening_month_number).toBe(4);
    expect(payload.inputs.cost_schedule).toEqual([
      { category: "Consultant", month: 1, amount: 50000 },
      { category: "Build-out", month: 3, amount: 60000 },
    ]);
  });

  // QA P2 #24 — the store name is OPTIONAL and "Defaults to the address" (the field
  // placeholder promises it). A BLANK name must default to the RESOLVED ADDRESS, not
  // the server's "Untitled projection" placeholder. The resolved address lives in
  // d.city (onResolved persists result.location.formatted_address there).
  it("defaults a blank store name to the resolved address (not Untitled)", () => {
    const payload = buildCreatePayload({ ...DRAFT, name: "" });
    expect(payload.name).toBe("Longview, TX");
    expect(payload.name).not.toMatch(/untitled/i);
  });

  it("defaults a whitespace-only store name to the resolved address", () => {
    const payload = buildCreatePayload({ ...DRAFT, name: "   " });
    expect(payload.name).toBe("Longview, TX");
  });

  it("preserves a non-blank store name verbatim (trimmed)", () => {
    const payload = buildCreatePayload({ ...DRAFT, name: "  House of Hope  " });
    expect(payload.name).toBe("House of Hope");
  });
});

describe("toServerCreateBody (nested wizard payload → flat backend body)", () => {
  const payload = buildCreatePayload({ ...DRAFT, name: "House of Hope", households: 31798 });

  it("flattens shares to string fractions the backend Inputs model accepts", () => {
    const body = toServerCreateBody(payload);
    expect(body.inputs.share_y1).toBe("0.06");
    expect(body.inputs.share_y2).toBe("0.08");
    expect(body.inputs.share_y3).toBe("0.1");
    expect(body.inputs.share_y4).toBe("0.11");
    expect(body.inputs.share_y5).toBe("0.12");
    expect(body.inputs.salesfloor_pct).toBe("0.7");
    expect(body.inputs.lease_type).toBe("nnn");
    // source_of_funds collapses to a single total string (backend InputsIn shape).
    expect(body.inputs.source_of_funds).toBe("200000");
    expect(body.inputs.city).toBe("Longview, TX");
    expect(body.trade_area).toEqual({ basis: "city", households: "31798" });
  });

  it("ships rent_per_sqft as a string with a null occupancy_annual + utilities assumption (#245)", () => {
    const body = toServerCreateBody(payload);
    expect(body.inputs.rent_per_sqft).toBe("12");
    expect(body.inputs.occupancy_annual).toBeNull();
    expect(body.assumptions.utilities_per_sqft).toBe("2.23");
  });

  // Task 2.6: the flat backend body stringifies the fraction assumptions (AssumptionsIn
  // takes str fractions), matching the shares' String(6/100) === "0.06" convention.
  // reserve_buffer / fixed_annual stay numbers (AssumptionsIn takes int / {label: num}).
  it("flattens the advanced % assumptions to string fractions the backend accepts", () => {
    const body = toServerCreateBody(payload); // DRAFT: labor 60, salvage 0.8, sens 25…
    expect(body.assumptions.labor_pct).toBe("0.6");
    expect(body.assumptions.salvage_pct).toBe("0.008");
    expect(body.assumptions.marketing_pct).toBe("0.0375");
    expect(body.assumptions.supplies_pct).toBe("0.05");
    expect(body.assumptions.card_pct).toBe("0.02");
    expect(body.assumptions.payroll_tax_pct).toBe("0.075");
    expect(body.assumptions.escalator).toBe("0.03");
    expect(body.assumptions.sensitivity_delta).toBe("0.25");
    // basket is a $ value (not a %): String() but NO ÷100.
    expect(body.assumptions.basket).toBe("17.08");
  });

  it("keeps reserve_buffer + donations_per_hh + fixed_annual as NUMBERS (not stringified)", () => {
    const body = toServerCreateBody(payload);
    expect(body.assumptions.reserve_buffer).toBe(25000);
    expect(body.assumptions.donations_per_hh).toBe(3);
    expect(body.assumptions.fixed_annual["Pest control"]).toBe(300);
    expect(body.assumptions.fixed_annual).toEqual({
      "Insurance liability": 2000,
      "Internet, Phones": 3000,
      "Pest control": 300,
      "Repairs/maintenance": 1600,
      "Security system": 900,
    });
  });

  it("sends nnn_opex_annual as a STRING from the draft (replacing the hard-coded '0')", () => {
    const body = toServerCreateBody(buildCreatePayload({ ...DRAFT, nnnOpexAnnual: 150 }));
    expect(body.inputs.nnn_opex_annual).toBe("150");
  });

  it("sends nnn_opex_annual '0' when the draft opex is 0 (default)", () => {
    const body = toServerCreateBody(payload); // DRAFT.nnnOpexAnnual === 0
    expect(body.inputs.nnn_opex_annual).toBe("0");
  });

  it("forwards the opening anchor + cost schedule to the flat backend body", () => {
    const body = toServerCreateBody(payload);
    expect(body.inputs.opening_month_number).toBe(1);
    expect(body.inputs.target_opening_date).toBeNull();
    expect(Array.isArray(body.inputs.cost_schedule)).toBe(true);
    expect(body.inputs.cost_schedule[0]).toMatchObject({ month: 1 });
  });

  // QA P2 #24 — a blank store name reaches the backend as the ADDRESS-derived name in
  // BOTH `name` and `inputs.org_name`, so the server never falls back to its
  // "Untitled projection" placeholder (name = body.name or org_name or "Untitled…").
  it("sends the address-derived name (name + org_name) when the store name is blank", () => {
    const body = toServerCreateBody(buildCreatePayload({ ...DRAFT, name: "" }));
    expect(body.name).toBe("Longview, TX");
    expect(body.inputs.org_name).toBe("Longview, TX");
    expect(body.name).not.toMatch(/untitled/i);
  });
});

// Task 2.6 ANCHOR — a pristine wizard draft (DEFAULT_DRAFT) must map to assumptions
// that reproduce engine/model.py's defaults, so a create with no assumptions and a
// default-draft create compute IDENTICALLY (the anchor invariant). Newly exposed knobs
// only add settings keys; they must never move a number.
describe("assumptions anchor — a default draft reproduces the engine/model.py defaults", () => {
  const a = toServerCreateBody(buildCreatePayload(DEFAULT_DRAFT)).assumptions;

  // WHICH equality, and WHY. The SERVER parses every percent assumption as a Decimal,
  // so "0.6" and "0.60" are the SAME number. The mapper emits JS's shortest round-trip
  // string (String(60/100) === "0.6"), byte-DIFFERENT from the engine's "0.60" but
  // NUMERICALLY identical — so the percent knobs are asserted with parseFloat NUMERIC
  // equality against the engine constants. A byte assertion for labor would be WRONG
  // (it would demand a trailing zero the mapper never emits and the server never needs).
  it("percent knobs equal the engine defaults NUMERICALLY (Decimal-parsed server-side)", () => {
    expect(parseFloat(a.labor_pct)).toBe(parseFloat(ENGINE_DEFAULTS.labor_pct)); // 0.6 == 0.60
    expect(parseFloat(a.marketing_pct)).toBe(parseFloat(ENGINE_DEFAULTS.marketing_pct));
    expect(parseFloat(a.supplies_pct)).toBe(parseFloat(ENGINE_DEFAULTS.supplies_pct));
    expect(parseFloat(a.card_pct)).toBe(parseFloat(ENGINE_DEFAULTS.card_pct));
    expect(parseFloat(a.payroll_tax_pct)).toBe(parseFloat(ENGINE_DEFAULTS.payroll_tax_pct));
    expect(parseFloat(a.salvage_pct)).toBe(parseFloat(ENGINE_DEFAULTS.salvage_pct));
    expect(parseFloat(a.escalator)).toBe(parseFloat(ENGINE_DEFAULTS.escalator));
    expect(parseFloat(a.sensitivity_delta)).toBe(parseFloat(ENGINE_DEFAULTS.sensitivity_delta));
    expect(parseFloat(a.utilities_per_sqft)).toBe(parseFloat(ENGINE_DEFAULTS.utilities_per_sqft));
    expect(parseFloat(a.basket)).toBe(parseFloat(ENGINE_DEFAULTS.basket));
  });

  // For every knob whose mapper output ALREADY needs no trailing-zero normalization,
  // the exact wire bytes are also pinned (documents the serialized shape). labor is the
  // one byte-divergent case, pinned to the mapper's "0.6" (=== engine "0.60" numerically).
  it("pins the exact string bytes the wire carries (labor is the '0.6' vs '0.60' case)", () => {
    expect(a.labor_pct).toBe("0.6"); // byte-divergent from engine "0.60"; same number
    expect(a.salvage_pct).toBe("0.008");
    expect(a.marketing_pct).toBe("0.0375");
    expect(a.supplies_pct).toBe("0.05");
    expect(a.card_pct).toBe("0.02");
    expect(a.payroll_tax_pct).toBe("0.075");
    expect(a.escalator).toBe("0.03");
    expect(a.sensitivity_delta).toBe("0.25");
    expect(a.utilities_per_sqft).toBe("2.23");
    expect(a.basket).toBe("17.08");
  });

  it("non-percent knobs stay NUMBERS equal to the engine defaults (int / dict)", () => {
    expect(a.reserve_buffer).toBe(ENGINE_DEFAULTS.reserve_buffer);
    expect(a.donations_per_hh).toBe(ENGINE_DEFAULTS.donations_per_hh);
    expect(a.fixed_annual).toEqual(ENGINE_DEFAULTS.fixed_annual);
  });
});

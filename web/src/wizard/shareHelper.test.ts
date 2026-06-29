import { describe, expect, it } from "vitest";

import { buildCreatePayload, toServerCreateBody, type WizardDraft } from "./shareHelper";

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
  cash: 150000,
  grant: 50000,
  loan: 0,
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

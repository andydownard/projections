import { describe, expect, it } from "vitest";

import { buildCreatePayload, toServerCreateBody } from "./shareHelper";

// The wizard's create-payload shaping: buildCreatePayload (draft -> nested payload)
// + toServerCreateBody (nested -> flat backend body). No client projection math —
// the authoritative numbers come back from the server compute (PRD §13).

describe("buildCreatePayload (maps wizard draft → POST /api/projections body)", () => {
  it("emits three EXPLICIT shares as fractions — never an auto-midpoint", () => {
    const payload = buildCreatePayload({
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
      occupancyAnnual: 90000,
      cash: 150000,
      grant: 50000,
      loan: 0,
      termsAccepted: true,
    });
    expect(payload.name).toBe("House of Hope — Longview, TX");
    expect(payload.trade_area).toEqual({ basis: "city", households: 31800 });
    expect(payload.inputs.demand).toEqual({
      mode: "market_share",
      share_y1: 0.06,
      share_y2: 0.08,
      share_y3: 0.1,
    });
    expect(payload.inputs.building_sqft).toBe(10000);
    expect(payload.inputs.salesfloor_pct).toBe(0.7);
    expect(payload.inputs.lease_type).toBe("nnn");
    expect(payload.inputs.source_of_funds).toEqual({ cash: 150000, grant: 50000, loan: 0 });
    expect(payload.terms_accepted).toBe(true);
  });
});

describe("toServerCreateBody (nested wizard payload → flat backend body)", () => {
  const payload = buildCreatePayload({
    name: "House of Hope",
    city: "Longview",
    state: "TX",
    basis: "city",
    households: 31798,
    buildingSqft: 10000,
    salesfloorPct: 70,
    leaseType: "nnn",
    donationValue: 74,
    basket: 17.08,
    donationsPerHh: 3,
    shareY1: 6,
    shareY2: 8,
    shareY3: 10,
    occupancyAnnual: 90000,
    cash: 150000,
    grant: 50000,
    loan: 0,
    termsAccepted: true,
  });

  it("flattens shares to string fractions the backend Inputs model accepts", () => {
    const body = toServerCreateBody(payload);
    expect(body.inputs.share_y1).toBe("0.06");
    expect(body.inputs.share_y2).toBe("0.08");
    expect(body.inputs.share_y3).toBe("0.1");
    expect(body.inputs.salesfloor_pct).toBe("0.7");
    expect(body.inputs.lease_type).toBe("nnn");
    // source_of_funds collapses to a single total string (backend InputsIn shape).
    expect(body.inputs.source_of_funds).toBe("200000");
    expect(body.inputs.city).toBe("Longview, TX");
    expect(body.trade_area).toEqual({ basis: "city", households: "31798" });
  });
});

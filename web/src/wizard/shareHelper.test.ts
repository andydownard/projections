import { describe, expect, it } from "vitest";

import {
  PRESETS,
  SHARE_BENCHMARK_NOTE,
  buildCreatePayload,
  evenRampY2,
  shareHelper,
  toServerCreateBody,
} from "./shareHelper";

// SLICE 2 — wizard helper math. This is a PRE-PROJECTION estimate affordance
// (PRD §7.1: "the app converts" share ⇄ donations/week). It is NOT the projection
// view-model — that is server-authoritative (PRD §13). The helper only renders an
// at-a-glance "X% → D donations/week → $R revenue" line in the wizard so a
// non-finance user can sanity-check a share before Generate. The real numbers come
// back from the server's compute on create.

describe("shareHelper (wizard estimate, not the projection)", () => {
  it("converts share → donations/week → annual revenue for a city basis", () => {
    // 31,800 households × 6% share × 3 donations/hh/yr = 5,724 donations/yr
    //   → 5,724 / 52 ≈ 110 donations/week
    // revenue ≈ households × share × donationsPerHh × basket = 5,724 × $17.08
    const h = shareHelper({
      households: 31800,
      sharePct: 6,
      donationsPerHh: 3,
      basket: 17.08,
    });
    expect(h.donationsPerWeek).toBe(110);
    expect(h.annualRevenue).toBe(97766); // round(5724 * 17.08)
    // NO client-side number formatting (PRD §13): raw values, no Intl grouping.
    expect(h.text).toBe(
      "6% of ~31800 households → ~110 donations/week → ~$97766/yr revenue",
    );
  });

  it("renders without any client-side digit grouping (no thousands separators)", () => {
    const h = shareHelper({
      households: 31800,
      sharePct: 6,
      donationsPerHh: 3,
      basket: 17.08,
    });
    // The server is the sole formatting authority; the wizard estimate must not
    // inject commas/locale grouping of its own.
    expect(h.text).not.toMatch(/\d,\d/);
  });

  it("returns a null/dashed helper when households are unknown", () => {
    const h = shareHelper({ households: 0, sharePct: 6, donationsPerHh: 3, basket: 17.08 });
    expect(h.donationsPerWeek).toBeNull();
    expect(h.annualRevenue).toBeNull();
    expect(h.text).toMatch(/enter households/i);
  });

  it("handles a 0% share without dividing by zero", () => {
    const h = shareHelper({ households: 31800, sharePct: 0, donationsPerHh: 3, basket: 17.08 });
    expect(h.donationsPerWeek).toBe(0);
    expect(h.annualRevenue).toBe(0);
  });
});

describe("presets (benchmark ramps)", () => {
  it("exposes Conservative / Moderate / Aggressive ramps (PRD §7.1)", () => {
    expect(PRESETS.map((p) => p.label)).toEqual(["Conservative", "Moderate", "Aggressive"]);
    const conservative = PRESETS.find((p) => p.label === "Conservative")!;
    expect(conservative.shares).toEqual([5, 6, 7]);
  });

  it("documents the established-store benchmark (~7%)", () => {
    expect(SHARE_BENCHMARK_NOTE).toMatch(/7%/);
  });
});

describe("evenRampY2 (editable helper, all three stay explicit)", () => {
  it("fills Year 2 as the midpoint of Year 1 and Year 3", () => {
    expect(evenRampY2(6, 10)).toBe(8);
  });

  it("rounds to one decimal place", () => {
    expect(evenRampY2(5, 8)).toBe(6.5);
  });
});

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

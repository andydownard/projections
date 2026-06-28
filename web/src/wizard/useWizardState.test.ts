import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { STEPS, useWizardState } from "./useWizardState";
import type { TradeAreaResolved } from "../api/places";
import type { RentResearch } from "../api/research";

const LAST_STEP = STEPS.length - 1; // review

// The shared wizard-state hook: holds the draft, the step cursor with per-step
// validation gating Next, and the households-empty-until-resolved lifecycle
// (§4). No client math — it only collects inputs (PRD §13).

const RESOLVED: TradeAreaResolved = {
  location: { place_id: "PID", lat: 32.78, lng: -96.8, formatted_address: "Dallas, TX, USA" },
  trade_area: {
    basis: "city",
    households: 512000,
    geography_name: "Dallas city",
    geography_fips: "4819000",
    acs_vintage: "2022",
    households_source: "census_acs",
    moe: 1500,
    alternatives: {
      city: { geography_name: "Dallas city", fips: "4819000", households: 512000, moe: 1500 },
      county: { geography_name: "Dallas County", fips: "48113", households: 980000, moe: 3000 },
    },
  },
  evidence: {
    field: "households", label: "", value: 512000, method: "census_acs",
    source: "", source_date: "2022", confidence: "estimated", geography: "Dallas city",
  },
};

describe("useWizardState — step cursor + gating", () => {
  it("starts at step 0 and blocks Next until the store name is entered", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.step).toBe(0);
    expect(result.current.canProceed).toBe(false); // name empty

    act(() => result.current.goNext());
    expect(result.current.step).toBe(0); // gated — did not advance

    act(() => result.current.set("name", "House of Hope"));
    expect(result.current.canProceed).toBe(true);
    act(() => result.current.goNext());
    expect(result.current.step).toBe(1);
  });

  it("goBack returns to the previous step", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.set("name", "X"));
    act(() => result.current.goNext());
    expect(result.current.step).toBe(1);
    act(() => result.current.goBack());
    expect(result.current.step).toBe(0);
  });
});

describe("useWizardState — households empty-until-resolved (§4)", () => {
  it("households is empty + disabled until an address resolves", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.householdsValue).toBeNull();
    expect(result.current.householdsDisabled).toBe(true);
    expect(result.current.householdsSource).toBeNull();
    expect(result.current.canGenerate).toBe(false);
  });

  it("populates households + provenance on resolve; basis toggle switches the count", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.onResolved(RESOLVED));
    expect(result.current.householdsValue).toBe(512000);
    expect(result.current.householdsDisabled).toBe(false);
    expect(result.current.householdsSource).toBe("census_acs");

    act(() => result.current.applyBasis("county"));
    expect(result.current.householdsValue).toBe(980000);
  });

  it("user overwrite flips the source to user_edited", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.onResolved(RESOLVED));
    act(() => result.current.setHouseholds(40000));
    expect(result.current.householdsValue).toBe(40000);
    expect(result.current.householdsSource).toBe("user_edited");
  });

  it("a Places/Census failure makes the field manually editable", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.onResolveError("census_unavailable"));
    expect(result.current.householdsDisabled).toBe(false);
    expect(result.current.householdsSource).toBe("manual");
    expect(result.current.canGenerate).toBe(false); // still no value
    act(() => result.current.setHouseholds(25000));
    expect(result.current.householdsSource).toBe("manual");
    act(() => result.current.set("termsAccepted", true));
    expect(result.current.canGenerate).toBe(true);
  });
});

describe("useWizardState — blockReason surfaces WHY Next/Generate is disabled (#147)", () => {
  it("names the store-name requirement on step 0 and clears it once entered", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.canProceed).toBe(false);
    expect(result.current.blockReason).toMatch(/store name/i);

    act(() => result.current.set("name", "House of Hope"));
    expect(result.current.canProceed).toBe(true);
    expect(result.current.blockReason).toBeNull();
  });

  it("names the households requirement on the trade-area step", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.set("name", "X"));
    act(() => result.current.goNext()); // -> trade-area
    expect(result.current.stepKey).toBe("trade-area");
    expect(result.current.blockReason).toMatch(/households/i);

    act(() => result.current.onResolved(RESOLVED));
    expect(result.current.blockReason).toBeNull();
  });

  it("names the specific missing donor-market year(s)", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.set("name", "X"));
    act(() => result.current.onResolved(RESOLVED));
    act(() => result.current.goNext()); // trade-area
    act(() => result.current.goNext()); // space (sq ft / salesfloor / rent default-valid)
    act(() => result.current.goNext()); // donor-market
    expect(result.current.stepKey).toBe("donor-market");
    expect(result.current.blockReason).toBeNull(); // defaults 6/8/10 are valid

    act(() => result.current.set("shareY2", 0));
    expect(result.current.blockReason).toMatch(/year 2/i);
    expect(result.current.blockReason).not.toMatch(/year 1/i);
  });

  it("on the final step, names the unmet generate gate (terms after households resolve)", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.set("name", "X"));
    act(() => result.current.onResolved(RESOLVED));
    act(() => result.current.goTo(LAST_STEP)); // review (last)
    expect(result.current.isLast).toBe(true);
    // households resolved, terms still unchecked → reason names terms
    expect(result.current.blockReason).toMatch(/terms/i);

    act(() => result.current.set("termsAccepted", true));
    expect(result.current.canGenerate).toBe(true);
    expect(result.current.blockReason).toBeNull();
  });
});

describe("useWizardState — Space & rent step (#245)", () => {
  const RESEARCH: RentResearch = {
    rent_per_sqft: 18, estimate: 18, low: 15, high: 22,
    rent_type: "nnn", opex: 3, basis: "$/sq ft/yr",
    confidence: "high", verified: true, provenance: "verified",
    sources: [{ url: "https://x", title: "Listing", source_date: "2026-05" }],
    ai_enabled: true, cached: false,
  };

  it("inserts the Space & rent step between trade-area and donor-market", () => {
    expect(STEPS).toEqual([
      "store", "trade-area", "space", "donor-market", "cost", "review",
    ]);
  });

  it("seeds the per-sq-ft assumptions at the anchored defaults with provenance 'default'", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.draft.rentPerSqft).toBe(12);
    expect(result.current.draft.utilitiesPerSqft).toBe(2.23);
    expect(result.current.draft.fixturesPerSqft).toBe(4.5);
    expect(result.current.rentSource).toBe("default");
    expect(result.current.utilitiesSource).toBe("default");
    expect(result.current.fixturesSource).toBe("default");
  });

  it("gates Next until sq ft > 0 and salesfloor is 1–100%", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.goTo(2)); // space
    expect(result.current.stepKey).toBe("space");
    expect(result.current.canProceed).toBe(true); // defaults are valid

    act(() => result.current.setBuildingSqft(0));
    expect(result.current.canProceed).toBe(false);
    expect(result.current.blockReason).toMatch(/square feet/i);

    act(() => result.current.setBuildingSqft(8000));
    act(() => result.current.setSalesfloorPct(120));
    expect(result.current.canProceed).toBe(false);
    expect(result.current.blockReason).toMatch(/sales-floor/i);

    act(() => result.current.setSalesfloorPct(65));
    expect(result.current.canProceed).toBe(true);
  });

  it("pre-fills rent from research (provenance 'research') and keeps the badge result", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.onRentResearchStart());
    expect(result.current.rentResearchLoading).toBe(true);

    act(() => result.current.applyRentResearch(RESEARCH));
    expect(result.current.draft.rentPerSqft).toBe(18);
    expect(result.current.rentSource).toBe("research");
    expect(result.current.rentResearch?.verified).toBe(true);
    expect(result.current.rentResearchLoading).toBe(false);
  });

  it("a manual rent edit overrides research → provenance 'user'", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.applyRentResearch(RESEARCH));
    act(() => result.current.setRentPerSqft(20));
    expect(result.current.draft.rentPerSqft).toBe(20);
    expect(result.current.rentSource).toBe("user");
  });

  it("never clobbers a user rent edit with a later research result", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.setRentPerSqft(25));
    act(() => result.current.applyRentResearch(RESEARCH));
    expect(result.current.draft.rentPerSqft).toBe(25); // user value preserved
    expect(result.current.rentSource).toBe("user");
    // the server badge result is still captured for display
    expect(result.current.rentResearch?.verified).toBe(true);
  });

  it("research failure keeps the manual benchmark and flags the degraded state", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.onRentResearchStart());
    act(() => result.current.onRentResearchError());
    expect(result.current.rentResearchError).toBe(true);
    expect(result.current.rentResearchLoading).toBe(false);
    expect(result.current.draft.rentPerSqft).toBe(12); // anchored benchmark stays
    expect(result.current.rentSource).toBe("default");
  });

  it("editing utilities/fixtures $/sq ft flips provenance to 'user' and re-seeds scaled cost rows", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.setUtilitiesPerSqft(3.1));
    expect(result.current.draft.utilitiesPerSqft).toBe(3.1);
    expect(result.current.utilitiesSource).toBe("user");

    // building size scales Equipment & Fixtures / Build-out (server seed mirror)
    act(() => result.current.setBuildingSqft(8000));
    const sched = result.current.draft.costSchedule ?? [];
    const fixtures = sched.find((r) => r.category === "Equipment & Fixtures");
    const buildout = sched.find((r) => r.category.startsWith("Build-out"));
    expect(fixtures?.amount).toBe(36000); // 4.50 × 8000
    expect(buildout?.amount).toBe(40000); // 5.00 × 8000

    act(() => result.current.setFixturesPerSqft(6));
    expect(result.current.fixturesSource).toBe("user");
    const fx2 = (result.current.draft.costSchedule ?? []).find(
      (r) => r.category === "Equipment & Fixtures",
    );
    expect(fx2?.amount).toBe(48000); // 6 × 8000
  });
});

describe("useWizardState — terms acceptance is explicit (#141 / PRD §21)", () => {
  it("defaults termsAccepted to false (the box is NOT pre-checked)", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.draft.termsAccepted).toBe(false);
  });

  it("blocks Generate until the operator actively accepts terms", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.onResolved(RESOLVED)); // households now has a value
    expect(result.current.canGenerate).toBe(false); // terms unchecked → blocked
    act(() => result.current.set("termsAccepted", true));
    expect(result.current.canGenerate).toBe(true);
  });
});

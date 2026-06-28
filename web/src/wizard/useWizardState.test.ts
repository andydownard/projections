import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { STEPS, useWizardState } from "./useWizardState";
import type { TradeAreaResolved } from "../api/places";
import type { RentResearch } from "../api/research";

const LAST_STEP = STEPS.length - 1; // startup-costs

// The shared wizard-state hook: holds the draft, the step cursor with per-step
// validation gating Next, and the households-empty-until-resolved lifecycle
// (§4). No client math — it only collects inputs (PRD §13). Phase 2 (owner
// Decision 11): the order is Address → Square footage → Households → Donor market
// share → Startup costs; there is NO Review step and terms is implicit.

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

describe("useWizardState — step set + order (owner Decision 11)", () => {
  it("orders Address → Square footage → Households → Donor market share → Startup costs", () => {
    expect(STEPS).toEqual([
      "address",
      "square-footage",
      "households",
      "donor-market",
      "startup-costs",
    ]);
  });
});

describe("useWizardState — step cursor + gating", () => {
  it("starts at step 0 (address) and blocks Next until an address resolves", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.step).toBe(0);
    expect(result.current.stepKey).toBe("address");
    expect(result.current.canProceed).toBe(false); // no address yet

    act(() => result.current.goNext());
    expect(result.current.step).toBe(0); // gated — did not advance

    act(() => result.current.onResolved(RESOLVED));
    expect(result.current.canProceed).toBe(true);
    act(() => result.current.goNext());
    expect(result.current.step).toBe(1); // square-footage
  });

  it("a Places/Census failure (manual fallback) still lets the address step proceed", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.onResolveError("census_unavailable"));
    expect(result.current.canProceed).toBe(true); // households entered later
  });

  it("the store name is OPTIONAL — it never gates the address step", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.draft.name).toBe("");
    act(() => result.current.onResolved(RESOLVED));
    expect(result.current.canProceed).toBe(true); // resolved, no name set
  });

  it("goBack returns to the previous step", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.onResolved(RESOLVED));
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

  it("a Places/Census failure makes the field manually editable; households gates the confirm step", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.onResolveError("census_unavailable"));
    expect(result.current.householdsDisabled).toBe(false);
    expect(result.current.householdsSource).toBe("manual");
    expect(result.current.canGenerate).toBe(false); // still no value

    act(() => result.current.goTo(2)); // households step
    expect(result.current.stepKey).toBe("households");
    expect(result.current.canProceed).toBe(false);
    act(() => result.current.setHouseholds(25000));
    expect(result.current.householdsSource).toBe("manual");
    expect(result.current.canProceed).toBe(true);
    expect(result.current.canGenerate).toBe(true); // terms implicit (true)
  });
});

describe("useWizardState — Square footage step (#245, owner Decisions 9/10)", () => {
  const RESEARCH: RentResearch = {
    rent_per_sqft: 18, estimate: 18, low: 15, high: 22,
    rent_type: "nnn", opex: 3, basis: "$/sq ft/yr",
    confidence: "high", verified: true, provenance: "verified",
    sources: [{ url: "https://x", title: "Listing", source_date: "2026-05" }],
    ai_enabled: true, cached: false,
  };

  it("defaults to 12,500 sq ft / 80% sales floor (wizard-side; anchor stays 10k)", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.draft.buildingSqft).toBe(12500);
    expect(result.current.draft.salesfloorPct).toBe(80);
  });

  it("seeds the sq-ft-scaled cost rows for 12,500 sq ft on load", () => {
    const { result } = renderHook(() => useWizardState());
    const sched = result.current.draft.costSchedule ?? [];
    const fixtures = sched.find((r) => r.category === "Equipment & Fixtures");
    const buildout = sched.find((r) => r.category.startsWith("Build-out"));
    expect(fixtures?.amount).toBe(56250); // 4.50 × 12,500
    expect(buildout?.amount).toBe(62500); // 5.00 × 12,500
  });

  it("seeds the rent assumption at the anchored default with provenance 'default'", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.draft.rentPerSqft).toBe(12);
    expect(result.current.rentSource).toBe("default");
  });

  it("gates Next until sq ft > 0 and salesfloor is 1–100%", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.goTo(1)); // square-footage
    expect(result.current.stepKey).toBe("square-footage");
    expect(result.current.canProceed).toBe(true); // defaults are valid

    act(() => result.current.setBuildingSqft(0));
    expect(result.current.canProceed).toBe(false);

    act(() => result.current.setBuildingSqft(8000));
    act(() => result.current.setSalesfloorPct(120));
    expect(result.current.canProceed).toBe(false);

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

  it("editing the building size re-seeds the scaled cost rows (server seed mirror)", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.setBuildingSqft(8000));
    const sched = result.current.draft.costSchedule ?? [];
    const fixtures = sched.find((r) => r.category === "Equipment & Fixtures");
    const buildout = sched.find((r) => r.category.startsWith("Build-out"));
    expect(fixtures?.amount).toBe(36000); // 4.50 × 8000
    expect(buildout?.amount).toBe(40000); // 5.00 × 8000
  });
});

describe("useWizardState — terms acceptance is implicit on Generate (owner Decision 5)", () => {
  it("defaults termsAccepted to true (the checkbox is gone)", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.draft.termsAccepted).toBe(true);
  });

  it("the only real Generate gate is a household value", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.canGenerate).toBe(false); // no households yet
    act(() => result.current.onResolved(RESOLVED));
    expect(result.current.canGenerate).toBe(true);
  });

  it("the last step is startup-costs (no Review step)", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.goTo(LAST_STEP));
    expect(result.current.stepKey).toBe("startup-costs");
    expect(result.current.isLast).toBe(true);
  });
});

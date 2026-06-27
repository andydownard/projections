import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useWizardState } from "./useWizardState";
import type { TradeAreaResolved } from "../api/places";

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
    act(() => result.current.goTo(4)); // review (last)
    expect(result.current.isLast).toBe(true);
    // households resolved, terms still unchecked → reason names terms
    expect(result.current.blockReason).toMatch(/terms/i);

    act(() => result.current.set("termsAccepted", true));
    expect(result.current.canGenerate).toBe(true);
    expect(result.current.blockReason).toBeNull();
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

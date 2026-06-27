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
    expect(result.current.canGenerate).toBe(true);
  });
});

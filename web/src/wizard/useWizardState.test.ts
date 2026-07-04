import { act, renderHook } from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { advancedKey, DEFAULT_DRAFT, STEPS, useWizardState } from "./useWizardState";
import type { TradeAreaResolved } from "../api/places";
import type { RentResearch } from "../api/research";

const LAST_STEP = STEPS.length - 1; // startup-costs

// The shared wizard-state hook: holds the draft, the step cursor with per-step
// validation gating Next, and the households-empty-until-resolved lifecycle
// (§4). No client math — it only collects inputs (PRD §13). W15 redesign:
// the order is Address → Square footage → Configure donations → Startup costs;
// there is NO Review step and terms is implicit.

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

describe("useWizardState — step set + order (W15 redesign)", () => {
  it("orders Address → Square footage → Configure donations → Startup costs", () => {
    expect(STEPS).toEqual([
      "address",
      "square-footage",
      "configure-donations",
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

    act(() => result.current.goTo(2)); // configure-donations step
    expect(result.current.stepKey).toBe("configure-donations");
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

describe("useWizardState — W1 furthestReached + W15 new steps", () => {
  it("orders Address → Square footage → Configure donations → Startup costs (W15)", () => {
    expect(STEPS).toEqual([
      "address",
      "square-footage",
      "configure-donations",
      "startup-costs",
    ]);
  });

  it("furthestReached starts at the initial step", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.furthestReached).toBe(0);
  });

  it("furthestReached advances with goNext but not with goBack or goTo", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.onResolved(RESOLVED));
    act(() => result.current.goNext()); // → step 1
    expect(result.current.furthestReached).toBe(1);
    act(() => result.current.goTo(0)); // jump back
    expect(result.current.furthestReached).toBe(1); // stays at 1
    act(() => result.current.goBack()); // already at 0
    expect(result.current.furthestReached).toBe(1); // stays at 1
  });

  it("breadcrumb-navigation-preserves-draft: type a value, jump back, jump forward, value persists", () => {
    const { result } = renderHook(() => useWizardState());
    // Step 0 → 1
    act(() => result.current.onResolved(RESOLVED));
    act(() => result.current.goNext());
    expect(result.current.step).toBe(1);
    // Type a value on step 1
    act(() => result.current.setBuildingSqft(8000));
    expect(result.current.draft.buildingSqft).toBe(8000);
    // Move to step 2 (to set furthestReached >= 1)
    act(() => result.current.goNext()); // step 1 valid by defaults
    expect(result.current.furthestReached).toBe(2);
    // Jump back to step 1 via breadcrumb
    act(() => result.current.goTo(1));
    expect(result.current.draft.buildingSqft).toBe(8000); // value persists
    // Jump forward to step 2
    act(() => result.current.goTo(2));
    expect(result.current.draft.buildingSqft).toBe(8000); // still persists
  });

  it("donationValue defaults to $50 (not $74) (W15 / Owner Decision 4)", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.draft.donationValue).toBe(50);
  });

  it("Y4/Y5 shares default to 11/12 (Owner Decision 5)", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.draft.shareY4).toBe(11);
    expect(result.current.draft.shareY5).toBe(12);
  });
});

// Wave 2 Task 2.1: the Advanced Options disclosure on every step is closed
// (compact) by default and its open/closed state lives HERE, in the hook — not
// component-local state on the step — because steps unmount on Next/Back
// (CreateProjectionPage renders one Step*.tsx at a time). A step-local useState
// would silently forget whether the operator had it open every time they
// navigated away and back.
describe("useWizardState — advancedOpen (Advanced Options disclosure state)", () => {
  it("starts with every (step, group) advanced group collapsed (empty map)", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.advancedOpen).toEqual({});
    expect(result.current.advancedOpen[advancedKey("square-footage", "space-rates")]).toBeFalsy();
    expect(result.current.advancedOpen[advancedKey("startup-costs", "funding")]).toBeFalsy();
  });

  it("toggleAdvanced opens a single (step, group) pair without affecting others", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.toggleAdvanced("square-footage", "space-rates", true));
    expect(result.current.advancedOpen[advancedKey("square-footage", "space-rates")]).toBe(true);
    expect(result.current.advancedOpen[advancedKey("startup-costs", "funding")]).toBeFalsy();
  });

  it("a step with multiple groups (startup-costs) opens/closes each independently", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.toggleAdvanced("startup-costs", "rent-lease", true));
    expect(result.current.advancedOpen[advancedKey("startup-costs", "rent-lease")]).toBe(true);
    expect(result.current.advancedOpen[advancedKey("startup-costs", "cost-structure")]).toBeFalsy();
    expect(result.current.advancedOpen[advancedKey("startup-costs", "funding")]).toBeFalsy();
  });

  it("toggleAdvanced can close a (step, group) pair again", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.toggleAdvanced("startup-costs", "funding", true));
    expect(result.current.advancedOpen[advancedKey("startup-costs", "funding")]).toBe(true);
    act(() => result.current.toggleAdvanced("startup-costs", "funding", false));
    expect(result.current.advancedOpen[advancedKey("startup-costs", "funding")]).toBe(false);
  });

  it("survives goNext()/goBack() — state lives in the hook, not the unmounted step", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.onResolved(RESOLVED));
    act(() => result.current.goNext()); // → square-footage
    expect(result.current.stepKey).toBe("square-footage");
    act(() => result.current.toggleAdvanced("square-footage", "space-rates", true));
    expect(result.current.advancedOpen[advancedKey("square-footage", "space-rates")]).toBe(true);

    act(() => result.current.goNext()); // → configure-donations (defaults valid)
    expect(result.current.stepKey).toBe("configure-donations");
    act(() => result.current.goBack()); // → square-footage
    expect(result.current.stepKey).toBe("square-footage");
    // persisted
    expect(result.current.advancedOpen[advancedKey("square-footage", "space-rates")]).toBe(true);
  });
});

// Wave 2 Task 2.6: the wizard draft is persisted to localStorage (key
// "wizard-draft-v1", debounced 500ms) so a reload/return offers a resume. The key is
// cleared on a successful Generate (the draft became a real projection). This holds
// inputs only — persistence never computes anything (PRD §13).
describe("useWizardState — localStorage draft persistence (wizard-draft-v1)", () => {
  const STORAGE_KEY = "wizard-draft-v1";

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("debounces (500ms) a draft edit into localStorage under wizard-draft-v1", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.set("basket", 19.99));
    // Not written yet — the write is debounced (no thrash on every keystroke).
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    act(() => vi.advanceTimersByTime(500));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.basket).toBe(19.99);
  });

  it("coalesces rapid edits into a single trailing write (the timer resets on each edit)", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.set("shareY1", 7));
    act(() => vi.advanceTimersByTime(200));
    act(() => result.current.set("shareY1", 9)); // resets the 500ms window
    act(() => vi.advanceTimersByTime(499));
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull(); // still within the debounce
    act(() => vi.advanceTimersByTime(1));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).shareY1).toBe(9);
  });

  it("offers a resume when a NON-default draft is already stored on mount", () => {
    const stored = { ...DEFAULT_DRAFT, name: "Half-finished", buildingSqft: 8000 };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const { result } = renderHook(() => useWizardState());
    expect(result.current.resumeAvailable).toBe(true);
  });

  it("does NOT offer a resume when the stored draft equals the default (nothing to resume)", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_DRAFT));
    const { result } = renderHook(() => useWizardState());
    expect(result.current.resumeAvailable).toBe(false);
  });

  it("does NOT offer a resume with an empty store", () => {
    const { result } = renderHook(() => useWizardState());
    expect(result.current.resumeAvailable).toBe(false);
  });

  it("resumeDraft() restores the stored draft and dismisses the banner", () => {
    const stored = { ...DEFAULT_DRAFT, name: "Half-finished", buildingSqft: 8000, laborPct: 45 };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const { result } = renderHook(() => useWizardState());
    expect(result.current.resumeAvailable).toBe(true);
    act(() => result.current.resumeDraft());
    expect(result.current.draft.name).toBe("Half-finished");
    expect(result.current.draft.buildingSqft).toBe(8000);
    expect(result.current.draft.laborPct).toBe(45);
    expect(result.current.resumeAvailable).toBe(false);
  });

  it("dismissResume() (Start fresh) clears the key + banner and keeps the fresh default draft", () => {
    const stored = { ...DEFAULT_DRAFT, name: "Half-finished", buildingSqft: 8000 };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.dismissResume());
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(result.current.resumeAvailable).toBe(false);
    // Start fresh DISCARDS the stored draft — it never adopts it into the working draft.
    expect(result.current.draft.name).toBe("");
    expect(result.current.draft.buildingSqft).toBe(DEFAULT_DRAFT.buildingSqft);
  });

  it("clearDraft() removes the stored key (called on a successful Generate)", () => {
    const stored = { ...DEFAULT_DRAFT, name: "Half-finished" };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.clearDraft());
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(result.current.resumeAvailable).toBe(false);
  });

  it("never clobbers the stored draft on mount before the resume decision (skips the first write)", () => {
    const stored = { ...DEFAULT_DRAFT, name: "Half-finished", buildingSqft: 8000 };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    renderHook(() => useWizardState());
    // Advancing past the debounce on mount must NOT overwrite the stored draft with the
    // fresh default — the operator hasn't chosen Resume / Start fresh yet.
    act(() => vi.advanceTimersByTime(1000));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).name).toBe("Half-finished");
  });
});

describe("useWizardState — setBuildoutPerSqft (Task 2.2)", () => {
  it("updates buildoutPerSqft and re-seeds the Build-out cost row (mirrors setFixturesPerSqft)", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.setBuildoutPerSqft(6));
    expect(result.current.draft.buildoutPerSqft).toBe(6);
    const sched = result.current.draft.costSchedule ?? [];
    const buildout = sched.find((r) => r.category.startsWith("Build-out"));
    expect(buildout?.amount).toBe(75000); // 6 × 12,500 (default building sqft)
  });

  it("preserves the fixtures row when only buildout changes", () => {
    const { result } = renderHook(() => useWizardState());
    act(() => result.current.setBuildoutPerSqft(6));
    const sched = result.current.draft.costSchedule ?? [];
    const fixtures = sched.find((r) => r.category === "Equipment & Fixtures");
    expect(fixtures?.amount).toBe(56250); // unchanged: 4.50 × 12,500
  });
});

// --- 2.6 review fast-follows -------------------------------------------------
describe("draft persistence hardening (2.6 review)", () => {
  const KEY = "wizard-draft-v1";

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it("does not clobber a stored draft on mount even under React StrictMode (dev double-effect)", async () => {
    vi.useFakeTimers();
    const stored = { ...DEFAULT_DRAFT, name: "Precious Draft", buildingSqft: 9999 };
    localStorage.setItem(KEY, JSON.stringify(stored));
    renderHook(() => useWizardState(), {
      wrapper: ({ children }) => createElement(StrictMode, null, children),
    });
    // StrictMode runs the persistence effect setup->cleanup->setup with persistent
    // refs; a boolean skip-first ref is consumed by the FIRST setup, letting the
    // second schedule a debounced write of the pristine default over the stored
    // draft. Advance past the debounce and assert the stored bytes are untouched.
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(JSON.parse(localStorage.getItem(KEY)!).name).toBe("Precious Draft");
    expect(JSON.parse(localStorage.getItem(KEY)!).buildingSqft).toBe(9999);
  });

  it("resume merges the stored draft over DEFAULT_DRAFT so fields added after persist resume with defaults", () => {
    const legacy: Record<string, unknown> = { ...DEFAULT_DRAFT, name: "Old Session" };
    delete legacy.salvagePct; // simulate a draft persisted before this field existed
    delete legacy.fixedAnnual;
    localStorage.setItem(KEY, JSON.stringify(legacy));
    const { result } = renderHook(() => useWizardState());
    expect(result.current.resumeAvailable).toBe(true);
    act(() => result.current.resumeDraft());
    expect(result.current.draft.name).toBe("Old Session");
    // must NOT be undefined -> "undefined" in the create body (422 at the server)
    expect(result.current.draft.salvagePct).toBe(DEFAULT_DRAFT.salvagePct);
    expect(result.current.draft.fixedAnnual).toEqual(DEFAULT_DRAFT.fixedAnnual);
  });
});

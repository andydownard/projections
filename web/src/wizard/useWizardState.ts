// web/src/wizard/useWizardState.ts — the shared Create-Projection wizard hook.
//
// Owns the wizard draft, the step cursor with per-step validation gating Next,
// and the households-empty-until-resolved lifecycle (Spec §4). It collects
// inputs ONLY — the projection numbers come back from the server compute on
// Generate (PRD §13 / CLAUDE.md hard rule: no client-side math).
//
// Phase 2 (Epics B/C, owner Decision 11 — REVISED order): the steps are
// Address → Square footage → Households → Donor market share → Startup costs.
// There is NO Review step; terms acceptance is IMPLICIT on Generate (owner
// Decision 5 — the disclaimer still shows + still stamps artifacts server-side).
import { useCallback, useEffect, useMemo, useState, useRef } from "react";

import type { ResolveErrorKind, TradeAreaResolved } from "../api/places";
import type { RentResearch } from "../api/research";
import {
  DEFAULT_COST_SCHEDULE,
  DEFAULT_OPENING_MONTH_NUMBER,
  type CostScheduleRow,
  type WizardDraft,
} from "./shareHelper";
import {
  BUILDOUT_PER_SQFT,
  DEFAULT_RENT_PER_SQFT,
  FIXTURES_PER_SQFT,
  reseedScaledCostRows,
  UTILITIES_PER_SQFT,
} from "./sqftConstants";

export type HouseholdsSource = "census_acs" | "user_edited" | "manual";
export type Basis = "city" | "county";

// WHO/WHAT set a sq-ft cost assumption (feature #245) — the same provenance
// language as households_source, surfaced on the rent field:
//   research → server-grounded rent pre-fill (verified or estimated benchmark)
//   user     → the operator adjusted it (overrides the research/default)
//   default  → the anchored regional constant (utilities/fixtures, or AI-off rent)
export type AssumptionSource = "research" | "user" | "default";

// The ordered step set + labels live in ./steps (the single source of truth shared
// with the path router, Epic B #261). Re-exported here so existing
// `from "./useWizardState"` imports keep working.
export { STEPS, STEP_LABELS, type StepKey } from "./steps";
import { STEPS } from "./steps";
import type { StepKey } from "./steps";

// The composite key for the per-(step, group) advancedOpen map (Task 2.2+): a
// step can own more than one advanced group (paramGroups.ts groupsForStep), so
// the map can't be keyed by step alone. Exported so every Step*.tsx reads/writes
// the SAME key shape the hook uses — no ad-hoc string concatenation drifting
// from this one definition.
export function advancedKey(step: StepKey, groupId: string): string {
  return `${step}:${groupId}`;
}

// Wizard-side defaults (owner Decision 9): the building defaults to 12,500 sq ft /
// 80% sales floor (the engine golden anchor EXAMPLE_BUILDING_SQFT stays 10,000 — this
// is wizard-side only, no golden regen). The sq-ft-scaled cost rows + occupancy are
// recomputed for 12,500 from the SAME #245 per-sq-ft seed.
const DEFAULT_BUILDING_SQFT = 12500;
const DEFAULT_SALESFLOOR_PCT = 80;

// The wizard seeds the non-collected engine inputs with House of Hope design
// parity so Generate has a complete body; the steps collect address, sq ft,
// households, the three shares, and the cost schedule.
export const DEFAULT_DRAFT: WizardDraft = {
  name: "",
  city: "",
  state: "",
  basis: "city",
  households: 0,
  buildingSqft: DEFAULT_BUILDING_SQFT,
  salesfloorPct: DEFAULT_SALESFLOOR_PCT,
  leaseType: "nnn",
  donationValue: 50,
  basket: 17.08,
  donationsPerHh: 3,
  salvagePct: 0.8,
  shareY1: 6,
  shareY2: 8,
  shareY3: 10,
  shareY4: 11,
  shareY5: 12,
  // Occupancy is sq ft × rent (#245): 12,500 sq ft × $12 = $150,000. The per-sq-ft
  // assumptions are anchored; the engine still derives occupancy server-side.
  occupancyAnnual: DEFAULT_BUILDING_SQFT * DEFAULT_RENT_PER_SQFT,
  rentPerSqft: DEFAULT_RENT_PER_SQFT,
  utilitiesPerSqft: UTILITIES_PER_SQFT,
  fixturesPerSqft: FIXTURES_PER_SQFT,
  buildoutPerSqft: BUILDOUT_PER_SQFT,
  nnnOpexAnnual: 0,
  cash: 300000,
  grant: 0,
  loan: 0,
  // Rent/cost/funding advanced drivers (Wave 2 Task 2.4) — the owner-decided v1
  // resolved defaults (CLAUDE.md "Resolved defaults" table / ENGINE_CONTRACT.md §1),
  // reproducing today's engine defaults byte-for-byte (anchor invariant).
  escalatorPct: 3,
  laborPct: 60,
  marketingPct: 3.75,
  suppliesPct: 5,
  cardPct: 2,
  payrollTaxPct: 8, // 990-grounded (2.7.0); tracks engine PAYROLL_TAX_PCT_OF_PAYROLL
  reserveBuffer: 25000,
  sensitivityDeltaPct: 25,
  fixedAnnual: {
    "Insurance liability": 10000, // 990-grounded (2.7.0); tracks engine FIXED_ANNUAL
    "Internet, Phones": 3000,
    "Pest control": 300,
    "Repairs/maintenance": 1600,
    "Security system": 900,
  },
  // Terms acceptance is IMPLICIT on Generate now (owner Decision 5): the box is gone,
  // the disclaimer still shows, and create defaults termsAccepted=true so the .xlsx /
  // packet exports stay reachable (EXPORT_DISCLAIMER still stamps artifacts server-side).
  termsAccepted: true,
  openingMonthNumber: DEFAULT_OPENING_MONTH_NUMBER,
  // Seed the sq-ft-scaled cost rows for 12,500 sq ft on load (Equipment & Fixtures
  // ≈ $56,250, Build-out ≈ $62,500) — the sanctioned #245 client mirror, not math.
  costSchedule: reseedScaledCostRows(
    DEFAULT_COST_SCHEDULE.map((r) => ({ ...r })),
    DEFAULT_BUILDING_SQFT,
    FIXTURES_PER_SQFT,
    BUILDOUT_PER_SQFT,
  ),
};

// --- localStorage draft persistence (Wave 2 Task 2.6) ------------------------
// The wizard draft is saved locally (debounced) so a reload/return offers to resume
// where the operator left off, and cleared once a successful Generate turns the draft
// into a real projection. This is a convenience cache of INPUTS on the operator's own
// device — no projection math, no secret (there is no token/slug in a draft), so it is
// plain localStorage (mirrors the owner-token slot's device-local posture).
export const WIZARD_DRAFT_STORAGE_KEY = "wizard-draft-v1";
const DRAFT_WRITE_DEBOUNCE_MS = 500;

/** Read the persisted draft, tolerating an absent/corrupt/unavailable store (never
 *  throws — a bad cache must degrade to "no resume", never break the wizard). */
function readStoredWizardDraft(): WizardDraft | null {
  try {
    const raw = globalThis.localStorage?.getItem(WIZARD_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as WizardDraft) : null;
  } catch {
    return null;
  }
}

export interface WizardState {
  draft: WizardDraft;
  set: <K extends keyof WizardDraft>(key: K, value: WizardDraft[K]) => void;

  // step cursor
  step: number;
  stepKey: StepKey;
  steps: readonly StepKey[];
  isFirst: boolean;
  isLast: boolean;
  canProceed: boolean;
  furthestReached: number;
  goNext: () => void;
  goBack: () => void;
  goTo: (i: number) => void;

  // households empty-until-resolved (§4)
  householdsValue: number | null;
  householdsDisabled: boolean;
  householdsSource: HouseholdsSource | null;
  resolved: TradeAreaResolved | null;
  basis: Basis;
  resolveError: ResolveErrorKind | null;
  onResolved: (result: TradeAreaResolved) => void;
  onResolveError: (kind: ResolveErrorKind) => void;
  applyBasis: (b: Basis) => void;
  setHouseholds: (n: number) => void;

  // --- Square footage + rent (feature #245) ----------------------------------
  // Rent tracks its provenance (research|user|default) like households_source, so the
  // startup-costs step can STATE who/what set it.
  rentSource: AssumptionSource;
  utilitiesSource: AssumptionSource;
  fixturesSource: AssumptionSource;
  // The last server rent-research result (drives the verified-vs-estimated badge,
  // sources, and confidence) — null until a research call returns. The client
  // renders the server's fields verbatim (no client math, PRD §13).
  rentResearch: RentResearch | null;
  rentResearchLoading: boolean;
  rentResearchError: boolean;
  setBuildingSqft: (n: number) => void;
  setSalesfloorPct: (n: number) => void;
  setRentPerSqft: (n: number) => void;
  setUtilitiesPerSqft: (n: number) => void;
  setFixturesPerSqft: (n: number) => void;
  setBuildoutPerSqft: (n: number) => void;
  /** Begin a research call (badge → loading). */
  onRentResearchStart: () => void;
  /** Apply a server rent-research result: pre-fill rent + provenance "research". */
  applyRentResearch: (r: RentResearch) => void;
  /** Research failed/unavailable: keep the manual benchmark, flag the degraded note. */
  onRentResearchError: () => void;

  // cost schedule (basic; the editor ticket enriches the step UI)
  costSchedule: CostScheduleRow[];
  addCostRow: () => void;
  updateCostRow: (i: number, patch: Partial<CostScheduleRow>) => void;
  removeCostRow: (i: number) => void;

  // --- Advanced Options disclosure (Wave 2 Task 2.1, per-GROUP as of 2.2) ----
  // Per-(step, group) open/closed state for the AdvancedOptions component. Lives
  // HERE (not step-local state) because steps unmount on Next/Back — a step-local
  // useState would forget whether the operator had it open. All groups default
  // closed (compact load). A step can own MORE THAN ONE advanced group (e.g.
  // startup-costs owns "rent-lease" / "cost-structure" / "funding", Task 2.4) so
  // the map is keyed by the composite `advancedKey(step, groupId)` string, not
  // just the step — otherwise opening one group would open them all.
  advancedOpen: Partial<Record<string, boolean>>;
  toggleAdvanced: (step: StepKey, groupId: string, open: boolean) => void;

  // --- localStorage draft persistence + resume (Task 2.6) --------------------
  // True when a NON-default draft was found in localStorage on mount and the operator
  // has not yet chosen — drives the resume banner (Resume / Start fresh).
  resumeAvailable: boolean;
  /** Adopt the stored draft into the working draft; hide the banner. */
  resumeDraft: () => void;
  /** Start fresh: discard the stored draft (clear the key), hide the banner, keep the
   *  fresh default draft. */
  dismissResume: () => void;
  /** Clear the persisted draft — called on a successful Generate (the draft became a
   *  real projection, so there is nothing left to resume). */
  clearDraft: () => void;

  canGenerate: boolean;
}

function hasValue(n: number | null): n is number {
  return n !== null && Number.isFinite(n) && n > 0;
}

export function useWizardState(
  initial?: Partial<WizardDraft>,
  // The initial step cursor (Epic B #261): when the wizard mounts on a deep-linked
  // /wizard/<step-slug> route, the cursor starts there so the right step renders on
  // the first paint (no flicker). Defaults to the first step. Clamped to the valid
  // range; the URL ↔ cursor sync lives in CreateProjectionPage.
  initialStep = 0,
): WizardState {
  const [draft, setDraft] = useState<WizardDraft>({ ...DEFAULT_DRAFT, ...initial });

  // --- localStorage draft persistence + resume (Task 2.6) --------------------
  // Captured ONCE at mount: the pristine baseline this session started from, and any
  // draft already persisted from a prior visit. A stored draft identical to the fresh
  // baseline is "nothing to resume" (offering it would be noise), so the resume banner
  // only shows when the stored draft actually diverges.
  const baselineDraftJsonRef = useRef<string>(JSON.stringify({ ...DEFAULT_DRAFT, ...initial }));
  const storedDraftRef = useRef<WizardDraft | null>(readStoredWizardDraft());
  const [resumeAvailable, setResumeAvailable] = useState<boolean>(() => {
    const s = storedDraftRef.current;
    return s != null && JSON.stringify(s) !== baselineDraftJsonRef.current;
  });
  const draftWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Never write until the draft OBJECT has actually changed from the initial state.
  // Identity (not a consumed boolean ref) is the guard because React StrictMode runs
  // the effect setup->cleanup->setup on the SAME instance with persistent refs — a
  // skip-first boolean is spent by the first setup, letting the second schedule a
  // debounced write of the pristine default over a stored draft the operator hasn't
  // chosen to resume yet (2.6 review, Important #1). The initial state object's
  // identity survives StrictMode re-runs; only a real setDraft produces a new object.
  const initialDraftObjRef = useRef<WizardDraft | null>(null);
  if (initialDraftObjRef.current === null) initialDraftObjRef.current = draft;

  useEffect(() => {
    if (draft === initialDraftObjRef.current) return;
    if (draftWriteTimerRef.current) clearTimeout(draftWriteTimerRef.current);
    draftWriteTimerRef.current = setTimeout(() => {
      try {
        globalThis.localStorage?.setItem(WIZARD_DRAFT_STORAGE_KEY, JSON.stringify(draft));
      } catch {
        // Storage full / unavailable — persistence is best-effort; never block the wizard.
      }
    }, DRAFT_WRITE_DEBOUNCE_MS);
    return () => {
      if (draftWriteTimerRef.current) clearTimeout(draftWriteTimerRef.current);
    };
  }, [draft]);

  const clearStoredDraft = useCallback(() => {
    if (draftWriteTimerRef.current) clearTimeout(draftWriteTimerRef.current);
    try {
      globalThis.localStorage?.removeItem(WIZARD_DRAFT_STORAGE_KEY);
    } catch {
      // ignore — a failed clear is harmless (the key is overwritten on the next write).
    }
  }, []);

  const resumeDraft = useCallback(() => {
    const s = storedDraftRef.current;
    // Merge over DEFAULT_DRAFT: a draft persisted before a deploy that added new
    // draft fields must resume with those fields at their defaults, never undefined
    // (String(undefined) === "undefined" would 422 at Generate) — 2.6 review #2.
    if (s) setDraft({ ...DEFAULT_DRAFT, ...s });
    setResumeAvailable(false);
  }, []);

  const dismissResume = useCallback(() => {
    clearStoredDraft();
    storedDraftRef.current = null;
    setResumeAvailable(false);
  }, [clearStoredDraft]);

  const clearDraft = useCallback(() => {
    clearStoredDraft();
    storedDraftRef.current = null;
    setResumeAvailable(false);
  }, [clearStoredDraft]);

  const [step, setStep] = useState(() =>
    Math.min(Math.max(0, Math.trunc(initialStep)), STEPS.length - 1),
  );
  const [furthestReached, setFurthestReached] = useState(() =>
    Math.min(Math.max(0, Math.trunc(initialStep)), STEPS.length - 1),
  );
  const [resolved, setResolved] = useState<TradeAreaResolved | null>(null);
  const [basis, setBasis] = useState<Basis>("city");
  const [householdsSource, setHouseholdsSource] = useState<HouseholdsSource | null>(null);
  const [householdsValue, setHouseholdsValue] = useState<number | null>(null);
  const [resolveError, setResolveError] = useState<ResolveErrorKind | null>(null);

  // Rent provenance (feature #245). Starts at the anchored default; a manual edit
  // flips to "user", a research pre-fill flips rent to "research".
  const [rentSource, setRentSource] = useState<AssumptionSource>("default");
  const [utilitiesSource, setUtilitiesSource] = useState<AssumptionSource>("default");
  const [fixturesSource, setFixturesSource] = useState<AssumptionSource>("default");
  const [rentResearch, setRentResearch] = useState<RentResearch | null>(null);
  const [rentResearchLoading, setRentResearchLoading] = useState(false);
  const [rentResearchError, setRentResearchError] = useState(false);

  // Advanced Options disclosure state (Wave 2 Task 2.1, per-GROUP as of 2.2) —
  // every (step, group) starts collapsed (empty map reads as falsy per key);
  // lives in the hook so it survives a step's unmount/remount on Next/Back.
  const [advancedOpen, setAdvancedOpen] = useState<Partial<Record<string, boolean>>>({});
  const toggleAdvanced = useCallback((step: StepKey, groupId: string, open: boolean) => {
    setAdvancedOpen((prev) => ({ ...prev, [advancedKey(step, groupId)]: open }));
  }, []);

  const set = useCallback(<K extends keyof WizardDraft>(key: K, value: WizardDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const applyBasis = useCallback(
    (b: Basis) => {
      setBasis(b);
      set("basis", b);
      const alt = resolved?.trade_area.alternatives[b];
      if (alt) {
        setHouseholdsValue(alt.households);
        set("households", alt.households);
        setHouseholdsSource("census_acs");
      }
    },
    [resolved, set],
  );

  const onResolved = useCallback(
    (result: TradeAreaResolved) => {
      setResolved(result);
      setResolveError(null);
      // Persist the resolved address into the draft (the saved projection + its
      // packet carry the picked address, not a seeded city/state).
      set("city", result.location.formatted_address);
      set("state", "");
      const pickB: Basis = result.trade_area.basis === "county" ? "county" : "city";
      const alt =
        result.trade_area.alternatives[pickB] ?? result.trade_area.alternatives.city;
      setBasis(pickB);
      set("basis", pickB);
      const count = alt?.households ?? result.trade_area.households;
      setHouseholdsValue(count);
      set("households", count);
      setHouseholdsSource("census_acs");
    },
    [set],
  );

  const onResolveError = useCallback((kind: ResolveErrorKind) => {
    // Places/Census failed: drop provenance, make the field manually editable.
    setResolveError(kind);
    setResolved(null);
    setHouseholdsSource("manual");
    setHouseholdsValue(null);
  }, []);

  const setHouseholds = useCallback(
    (n: number) => {
      setHouseholdsValue(n);
      set("households", n);
      // Overwriting a Census-resolved value flips provenance to user_edited;
      // a manual-fallback field stays manual.
      setHouseholdsSource((prev) => (prev === "manual" ? "manual" : "user_edited"));
    },
    [set],
  );

  // --- Square footage setters (feature #245) ---------------------------------
  // Changing the building size (or the fixtures/build-out $/sq ft) re-seeds the two
  // sq-ft-scaled cost rows (Equipment & Fixtures, Build-out) — the sanctioned client
  // mirror of the server's default_cost_schedule seed; NOT projection math.
  const setBuildingSqft = useCallback((n: number) => {
    setDraft((prev) => ({
      ...prev,
      buildingSqft: n,
      costSchedule: reseedScaledCostRows(
        prev.costSchedule ?? [], n, prev.fixturesPerSqft, prev.buildoutPerSqft,
      ),
    }));
  }, []);

  const setSalesfloorPct = useCallback((n: number) => set("salesfloorPct", n), [set]);

  // A ref shadow of rentSource so applyRentResearch can decide whether to clobber
  // WITHOUT calling a state setter inside another setter's updater (an impure update
  // that can crash render). The ref is kept in lock-step with every rent-source write.
  const rentSourceRef = useRef<AssumptionSource>("default");

  // A manual rent edit overrides whatever set it (research or default) → "user".
  const setRentPerSqft = useCallback(
    (n: number) => {
      set("rentPerSqft", n);
      rentSourceRef.current = "user";
      setRentSource("user");
    },
    [set],
  );

  const setUtilitiesPerSqft = useCallback(
    (n: number) => {
      set("utilitiesPerSqft", n);
      setUtilitiesSource("user");
    },
    [set],
  );

  const setFixturesPerSqft = useCallback((n: number) => {
    setFixturesSource("user");
    setDraft((prev) => ({
      ...prev,
      fixturesPerSqft: n,
      costSchedule: reseedScaledCostRows(
        prev.costSchedule ?? [], prev.buildingSqft, n, prev.buildoutPerSqft,
      ),
    }));
  }, []);

  // Mirrors setFixturesPerSqft (Task 2.2): a build-out $/sq ft edit re-seeds the
  // same two sq-ft-scaled cost rows (Equipment & Fixtures, Build-out) since
  // reseedScaledCostRows takes both rates together. No separate provenance
  // tracking — only utilities/fixtures state a provenance badge (brief 2.2).
  const setBuildoutPerSqft = useCallback((n: number) => {
    setDraft((prev) => ({
      ...prev,
      buildoutPerSqft: n,
      costSchedule: reseedScaledCostRows(
        prev.costSchedule ?? [], prev.buildingSqft, prev.fixturesPerSqft, n,
      ),
    }));
  }, []);

  const onRentResearchStart = useCallback(() => {
    setRentResearchLoading(true);
    setRentResearchError(false);
  }, []);

  // Pre-fill rent from a server result + flag provenance "research". A prior manual
  // edit wins (never silently clobber the operator's number) — mirrors households.
  const applyRentResearch = useCallback(
    (r: RentResearch) => {
      setRentResearch(r);
      setRentResearchLoading(false);
      setRentResearchError(false);
      if (rentSourceRef.current === "user") return; // keep the operator's value
      if (typeof r.rent_per_sqft === "number") set("rentPerSqft", r.rent_per_sqft);
      rentSourceRef.current = "research";
      setRentSource("research");
    },
    [set],
  );

  const onRentResearchError = useCallback(() => {
    setRentResearchLoading(false);
    setRentResearchError(true);
    // The field keeps the anchored benchmark and stays manually editable.
  }, []);

  // --- cost schedule helpers (the editor ticket enriches the UI) -------------
  const addCostRow = useCallback(() => {
    set("costSchedule", [
      ...(draft.costSchedule ?? []),
      { category: "", month: draft.openingMonthNumber ?? 1, amount: 0 },
    ]);
  }, [draft.costSchedule, draft.openingMonthNumber, set]);

  const updateCostRow = useCallback(
    (i: number, patch: Partial<CostScheduleRow>) => {
      const rows = (draft.costSchedule ?? []).map((r, idx) =>
        idx === i ? { ...r, ...patch } : r,
      );
      set("costSchedule", rows);
    },
    [draft.costSchedule, set],
  );

  const removeCostRow = useCallback(
    (i: number) => {
      set(
        "costSchedule",
        (draft.costSchedule ?? []).filter((_, idx) => idx !== i),
      );
    },
    [draft.costSchedule, set],
  );

  // --- per-step validation gating Next (owner Decision 11 order) -------------
  // The address step gates on an attempted resolution (a resolved address OR a
  // manual fallback) — the store name is OPTIONAL now (owner Decision 14/24).
  const validators: Record<StepKey, () => boolean> = useMemo(
    () => ({
      address: () => resolved != null || resolveError != null,
      "square-footage": () =>
        draft.buildingSqft > 0 &&
        draft.salesfloorPct > 0 &&
        draft.salesfloorPct <= 100,
      "configure-donations": () =>
        hasValue(householdsValue) &&
        draft.shareY1 > 0 && draft.shareY2 > 0 && draft.shareY3 > 0 &&
        draft.shareY4 > 0 && draft.shareY5 > 0 &&
        draft.donationValue > 0,
      "startup-costs": () =>
        (draft.openingMonthNumber ?? 1) >= 1 &&
        draft.rentPerSqft >= 0 &&
        (draft.costSchedule ?? []).every(
          (r) => r.category.trim().length > 0 && r.month >= 1 && r.amount >= 0,
        ),
    }),
    [draft, householdsValue, resolved, resolveError],
  );

  const stepKey = STEPS[step];
  const canProceed = validators[stepKey]();
  const isFirst = step === 0;
  const isLast = step === STEPS.length - 1;

  const goNext = useCallback(() => {
    setStep((s) => {
      if (validators[STEPS[s]]() && s < STEPS.length - 1) {
        const next = s + 1;
        setFurthestReached((prev) => Math.max(prev, next));
        return next;
      }
      return s;
    });
  }, [validators]);

  const goBack = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);
  const goTo = useCallback((i: number) => {
    setStep(() => Math.min(Math.max(0, i), STEPS.length - 1));
  }, []);

  // Generate is blocked until households has a value (§4). Terms is implicit (true),
  // so the only real gate on the last step is the resolved/entered household count.
  const canGenerate = hasValue(householdsValue) && draft.termsAccepted;

  return {
    draft,
    set,
    step,
    stepKey,
    steps: STEPS,
    isFirst,
    isLast,
    canProceed,
    furthestReached,
    goNext,
    goBack,
    goTo,
    householdsValue,
    householdsDisabled: householdsSource === null,
    householdsSource,
    resolved,
    basis,
    resolveError,
    onResolved,
    onResolveError,
    applyBasis,
    setHouseholds,
    rentSource,
    utilitiesSource,
    fixturesSource,
    rentResearch,
    rentResearchLoading,
    rentResearchError,
    setBuildingSqft,
    setSalesfloorPct,
    setRentPerSqft,
    setUtilitiesPerSqft,
    setFixturesPerSqft,
    setBuildoutPerSqft,
    onRentResearchStart,
    applyRentResearch,
    onRentResearchError,
    costSchedule: draft.costSchedule ?? [],
    addCostRow,
    updateCostRow,
    removeCostRow,
    advancedOpen,
    toggleAdvanced,
    resumeAvailable,
    resumeDraft,
    dismissResume,
    clearDraft,
    canGenerate,
  };
}

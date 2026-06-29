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
import { useCallback, useMemo, useState } from "react";

import type { ResolveErrorKind, TradeAreaResolved } from "../api/places";
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
//   user     → the operator adjusted it (overrides the default)
//   default  → the anchored regional constant (utilities/fixtures, or initial rent)
export type AssumptionSource = "user" | "default";

// The ordered step set + labels live in ./steps (the single source of truth shared
// with the path router, Epic B #261). Re-exported here so existing
// `from "./useWizardState"` imports keep working.
export { STEPS, STEP_LABELS, type StepKey } from "./steps";
import { STEPS } from "./steps";
import type { StepKey } from "./steps";

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
  cash: 300000,
  grant: 0,
  loan: 0,
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
  // Rent tracks its provenance (user|default) like households_source, so the
  // startup-costs step can STATE who/what set it.
  rentSource: AssumptionSource;
  utilitiesSource: AssumptionSource;
  fixturesSource: AssumptionSource;
  setBuildingSqft: (n: number) => void;
  setSalesfloorPct: (n: number) => void;
  setRentPerSqft: (n: number) => void;
  setUtilitiesPerSqft: (n: number) => void;
  setFixturesPerSqft: (n: number) => void;

  // cost schedule (basic; the editor ticket enriches the step UI)
  costSchedule: CostScheduleRow[];
  addCostRow: () => void;
  updateCostRow: (i: number, patch: Partial<CostScheduleRow>) => void;
  removeCostRow: (i: number) => void;

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
  // flips to "user".
  const [rentSource, setRentSource] = useState<AssumptionSource>("default");
  const [utilitiesSource, setUtilitiesSource] = useState<AssumptionSource>("default");
  const [fixturesSource, setFixturesSource] = useState<AssumptionSource>("default");

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

  // A manual rent edit overrides the default → "user".
  const setRentPerSqft = useCallback(
    (n: number) => {
      set("rentPerSqft", n);
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
    setBuildingSqft,
    setSalesfloorPct,
    setRentPerSqft,
    setUtilitiesPerSqft,
    setFixturesPerSqft,
    costSchedule: draft.costSchedule ?? [],
    addCostRow,
    updateCostRow,
    removeCostRow,
    canGenerate,
  };
}

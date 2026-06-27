// web/src/wizard/useWizardState.ts — the shared Create-Projection wizard hook.
//
// Owns the wizard draft, the step cursor with per-step validation gating Next,
// and the households-empty-until-resolved lifecycle (Spec §4). It collects
// inputs ONLY — the projection numbers come back from the server compute on
// Generate (PRD §13 / CLAUDE.md hard rule: no client-side math). A future step
// (or the Spec B Penny drawer) inserts by extending STEPS + the validators.
import { useCallback, useMemo, useState } from "react";

import type { ResolveErrorKind, TradeAreaResolved } from "../api/places";
import {
  DEFAULT_COST_SCHEDULE,
  DEFAULT_OPENING_MONTH_NUMBER,
  type CostScheduleRow,
  type WizardDraft,
} from "./shareHelper";

export type HouseholdsSource = "census_acs" | "user_edited" | "manual";
export type Basis = "city" | "county";

/** The ordered wizard steps (Spec §3). The cost-schedule-editor ticket enriches
 * the "cost" step's component; the step list + gating live here. */
export const STEPS = ["store", "trade-area", "donor-market", "cost", "review"] as const;
export type StepKey = (typeof STEPS)[number];

export const STEP_LABELS: Record<StepKey, string> = {
  store: "Store",
  "trade-area": "Trade area",
  "donor-market": "Donor market",
  cost: "Cost schedule",
  review: "Review",
};

// The wizard seeds the non-collected engine inputs with House of Hope design
// parity (mirrors the seeded example) so Generate has a complete body; the steps
// collect name/address, households, the three shares, and the cost schedule.
export const DEFAULT_DRAFT: WizardDraft = {
  name: "",
  city: "",
  state: "",
  basis: "city",
  households: 0,
  buildingSqft: 10000,
  salesfloorPct: 70,
  leaseType: "nnn",
  donationValue: 74,
  basket: 17.08,
  donationsPerHh: 3,
  shareY1: 6,
  shareY2: 8,
  shareY3: 10,
  occupancyAnnual: 120000,
  cash: 300000,
  grant: 0,
  loan: 0,
  termsAccepted: true,
  targetOpeningDate: "",
  openingMonthNumber: DEFAULT_OPENING_MONTH_NUMBER,
  costSchedule: DEFAULT_COST_SCHEDULE.map((r) => ({ ...r })),
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

export function useWizardState(initial?: Partial<WizardDraft>): WizardState {
  const [draft, setDraft] = useState<WizardDraft>({ ...DEFAULT_DRAFT, ...initial });
  const [step, setStep] = useState(0);
  const [resolved, setResolved] = useState<TradeAreaResolved | null>(null);
  const [basis, setBasis] = useState<Basis>("city");
  const [householdsSource, setHouseholdsSource] = useState<HouseholdsSource | null>(null);
  const [householdsValue, setHouseholdsValue] = useState<number | null>(null);
  const [resolveError, setResolveError] = useState<ResolveErrorKind | null>(null);

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

  // --- per-step validation gating Next (Spec §3) -----------------------------
  const validators: Record<StepKey, () => boolean> = useMemo(
    () => ({
      store: () => draft.name.trim().length > 0,
      "trade-area": () => hasValue(householdsValue),
      "donor-market": () => draft.shareY1 > 0 && draft.shareY2 > 0 && draft.shareY3 > 0,
      cost: () =>
        (draft.openingMonthNumber ?? 1) >= 1 &&
        (draft.costSchedule ?? []).every(
          (r) => r.category.trim().length > 0 && r.month >= 1 && r.amount >= 0,
        ),
      review: () => draft.termsAccepted,
    }),
    [draft, householdsValue],
  );

  const stepKey = STEPS[step];
  const canProceed = validators[stepKey]();
  const isFirst = step === 0;
  const isLast = step === STEPS.length - 1;

  const goNext = useCallback(() => {
    setStep((s) => {
      if (validators[STEPS[s]]() && s < STEPS.length - 1) return s + 1;
      return s;
    });
  }, [validators]);

  const goBack = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);
  const goTo = useCallback((i: number) => {
    setStep(() => Math.min(Math.max(0, i), STEPS.length - 1));
  }, []);

  // Generate is blocked until households has a value (§4) + terms accepted.
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
    costSchedule: draft.costSchedule ?? [],
    addCostRow,
    updateCostRow,
    removeCostRow,
    canGenerate,
  };
}

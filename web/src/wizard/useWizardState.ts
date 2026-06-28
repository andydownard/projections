// web/src/wizard/useWizardState.ts — the shared Create-Projection wizard hook.
//
// Owns the wizard draft, the step cursor with per-step validation gating Next,
// and the households-empty-until-resolved lifecycle (Spec §4). It collects
// inputs ONLY — the projection numbers come back from the server compute on
// Generate (PRD §13 / CLAUDE.md hard rule: no client-side math). A future step
// (or the Spec B Penny drawer) inserts by extending STEPS + the validators.
import { useCallback, useMemo, useRef, useState } from "react";

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
// language as households_source, surfaced per assumption in the Space & rent step:
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
  // Occupancy is sq ft × rent (#245): 10,000 sq ft × $12 = $120,000 (golden parity
  // with the old flat occupancy default). The per-sq-ft assumptions are anchored so
  // the example 10,000 sq ft reproduces today's literals exactly.
  occupancyAnnual: 120000,
  rentPerSqft: DEFAULT_RENT_PER_SQFT,
  utilitiesPerSqft: UTILITIES_PER_SQFT,
  fixturesPerSqft: FIXTURES_PER_SQFT,
  buildoutPerSqft: BUILDOUT_PER_SQFT,
  cash: 300000,
  grant: 0,
  loan: 0,
  // #141 / PRD §21: terms acceptance must be an EXPLICIT, active choice — the box is
  // unchecked by default (canGenerate gates on it) and the value is persisted server-side.
  termsAccepted: false,
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

  // --- Space & rent (feature #245) ------------------------------------------
  // Each sq-ft assumption tracks its provenance (research|user|default) like
  // households_source, so the Space & rent step can STATE who/what set it.
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

  canGenerate: boolean;

  // #147: a concise, human-readable reason the ACTIVE gate (Next, or Generate on
  // the last step) is blocked — null when satisfiable. Surfaced in the UI next to
  // the disabled button + announced to assistive tech so a greyed control is never
  // a silent dead end (WCAG status-message guidance).
  blockReason: string | null;
}

function hasValue(n: number | null): n is number {
  return n !== null && Number.isFinite(n) && n > 0;
}

/** Join labels into a readable English list ("Year 1 and Year 2"; "a, b, and c"). */
function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function useWizardState(
  initial?: Partial<WizardDraft>,
  // The initial step cursor (Epic B #261): when the wizard mounts on a deep-linked
  // /wizard/<step-slug> route, the cursor starts there so the right step renders on
  // the first paint (no store→target flicker). Defaults to the first step. Clamped
  // to the valid range; the URL ↔ cursor sync lives in CreateProjectionPage.
  initialStep = 0,
): WizardState {
  const [draft, setDraft] = useState<WizardDraft>({ ...DEFAULT_DRAFT, ...initial });
  const [step, setStep] = useState(() =>
    Math.min(Math.max(0, Math.trunc(initialStep)), STEPS.length - 1),
  );
  const [resolved, setResolved] = useState<TradeAreaResolved | null>(null);
  const [basis, setBasis] = useState<Basis>("city");
  const [householdsSource, setHouseholdsSource] = useState<HouseholdsSource | null>(null);
  const [householdsValue, setHouseholdsValue] = useState<number | null>(null);
  const [resolveError, setResolveError] = useState<ResolveErrorKind | null>(null);

  // Space & rent provenance (feature #245). Each starts at the anchored default;
  // a manual edit flips to "user", a research pre-fill flips rent to "research".
  const [rentSource, setRentSource] = useState<AssumptionSource>("default");
  const [utilitiesSource, setUtilitiesSource] = useState<AssumptionSource>("default");
  const [fixturesSource, setFixturesSource] = useState<AssumptionSource>("default");
  const [rentResearch, setRentResearch] = useState<RentResearch | null>(null);
  const [rentResearchLoading, setRentResearchLoading] = useState(false);
  const [rentResearchError, setRentResearchError] = useState(false);

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

  // --- Space & rent setters (feature #245) -----------------------------------
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

  // --- per-step validation gating Next (Spec §3) -----------------------------
  const validators: Record<StepKey, () => boolean> = useMemo(
    () => ({
      store: () => draft.name.trim().length > 0,
      "trade-area": () => hasValue(householdsValue),
      space: () =>
        draft.buildingSqft > 0 &&
        draft.salesfloorPct > 0 &&
        draft.salesfloorPct <= 100 &&
        draft.rentPerSqft >= 0,
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

  // #147: derive the reason the active gate is unmet so the disabled Next/Generate
  // button can state WHY (and AT can announce it). Mirrors the validators above +
  // canGenerate on the last step, so the message always tracks the real gate.
  const blockReason = useMemo<string | null>(() => {
    if (isLast) {
      // The final gate is canGenerate (households + terms). List EVERY unmet
      // requirement — both can block at once, so never stop at the first.
      const missing: string[] = [];
      if (!hasValue(householdsValue))
        missing.push(
          "look up your trade-area households (go back to the Find your trade area step)",
        );
      if (!draft.termsAccepted) missing.push("accept the planning-estimates terms below");
      return missing.length === 0
        ? null
        : `To generate the projection, ${formatList(missing)}.`;
    }
    switch (stepKey) {
      case "store":
        // Next on the store step is gated on the name alone (the address is
        // collected here but gates households on the Find-your-trade-area step,
        // not this button), so name it — and only it — to stay accurate.
        return draft.name.trim().length > 0 ? null : "Enter a store name to continue.";
      case "trade-area":
        return hasValue(householdsValue)
          ? null
          : "Look up an address or enter the trade-area households to continue.";
      case "space": {
        const missing: string[] = [];
        if (!(draft.buildingSqft > 0))
          missing.push("enter the building size in square feet");
        if (!(draft.salesfloorPct > 0 && draft.salesfloorPct <= 100))
          missing.push("set the sales-floor area between 1% and 100%");
        if (!(draft.rentPerSqft >= 0))
          missing.push("enter a rent of $0 or more per square foot");
        return missing.length === 0 ? null : `To continue, ${formatList(missing)}.`;
      }
      case "donor-market": {
        const missing = (
          [
            [draft.shareY1, "Year 1"],
            [draft.shareY2, "Year 2"],
            [draft.shareY3, "Year 3"],
          ] as const
        )
          .filter(([v]) => !(v > 0))
          .map(([, label]) => label);
        return missing.length === 0
          ? null
          : `Enter a donor-market share above 0 for ${formatList(missing)} to continue.`;
      }
      case "cost": {
        // List the SPECIFIC unmet cost-step requirements (the opening month
        // and/or the per-row fields) rather than a generic catch-all, so the
        // operator fixes exactly what's blocking. Mirrors validators.cost().
        const rows = draft.costSchedule ?? [];
        const missing: string[] = [];
        if (!((draft.openingMonthNumber ?? 1) >= 1))
          missing.push("set the opening month to 1 or later");
        if (rows.some((r) => r.category.trim().length === 0))
          missing.push("name every cost row");
        if (rows.some((r) => !(r.month >= 1)))
          missing.push("put every cost row on month 1 or later");
        if (rows.some((r) => !(r.amount >= 0)))
          missing.push("give every cost row an amount of 0 or more");
        return missing.length === 0 ? null : `To continue, ${formatList(missing)}.`;
      }
      default:
        return null;
    }
  }, [isLast, stepKey, draft, householdsValue]);

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
    onRentResearchStart,
    applyRentResearch,
    onRentResearchError,
    costSchedule: draft.costSchedule ?? [],
    addCostRow,
    updateCostRow,
    removeCostRow,
    canGenerate,
    blockReason,
  };
}

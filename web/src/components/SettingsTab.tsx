// web/src/components/SettingsTab.tsx — EPIC D / D11 + Wave 3 Task 3.1: the merged
// "Key metrics & drivers" grid, now GROUPED to mirror the wizard's presentation.
//
//   - DERIVED KPIs (revenue, net income, ratios) render READ-ONLY, the server's
//     { display } string verbatim (PRD §13 — no client math).
//   - PRIMARY DRIVERS (donor shares Y1–Y5 + $/donation) stay UNGROUPED and visible
//     at the top, exactly as today.
//   - EVERY OTHER editable knob moves into a COLLAPSIBLE group keyed to the shared
//     paramGroups.ts taxonomy, rendered in wizard-step order with the heading
//     "{step label} — {group label}" (steps.ts STEP_LABELS). Groups load COLLAPSED;
//     a group with zero present controls (e.g. Timing, which has no detail-page
//     controls) is not rendered at all.
//
// A driver edit debounces a PATCH carrying If-Match: <version> (API_SPEC §1.3/§4.4);
// a 409 raises a conflict banner offering reload / overwrite / save-as-copy. The
// percent drivers are entered in their HUMAN unit (e.g. "60" for 60%); the PATCH
// boundary divides by the scale to the engine's raw fraction (the same convention as
// the wizard's shareHelper — display formatting only, never client math).
//
// Server value shapes (Task 3.1 — landed on the backend track): reserve_buffer is an
// INTEGER; fixed_annual is a SINGLE-LINE dict that ACCUMULATES server-side (we send
// only the edited line); building_sqft / salesfloor_pct / rent_per_sqft /
// nnn_opex_annual / utilities_per_sqft / sensitivity_delta go over the wire as
// STRINGS. Only the SHAPE differs — the engine is still the one math authority.
import { useEffect, useReducer, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";

import { NumberField } from "./NumberField";
import { isNegative } from "./displayLabels";
import { PatchConflictError, type PatchBody, type PatchResult } from "../api/patch";
import {
  autosaveReducer,
  initialAutosaveState,
} from "../state/autosaveReducer";
import { PARAM_GROUPS } from "../wizard/paramGroups";
import { STEP_LABELS } from "../wizard/steps";
import type { ServerValue } from "../api/client";
import type { Kpi } from "../api/viewModel";

export interface SettingsViewModel {
  laborPct: ServerValue;
  marketingPct: ServerValue;
  suppliesPct: ServerValue;
  cardPct: ServerValue;
  payrollTaxPct: ServerValue;
  salvagePct: ServerValue;
  escalator: ServerValue;
  shareY1: ServerValue;
  shareY2: ServerValue;
  shareY3: ServerValue;
  // 2.6.0 + E2 drivers — optional so a legacy snapshot (which omits them) renders
  // only the drivers it actually carries (year-count-agnostic, applied to drivers).
  shareY4?: ServerValue;
  shareY5?: ServerValue;
  donationValue?: ServerValue;
  basket?: ServerValue;
  donationsPerHouseholdPerYear?: ServerValue;
  // 1.6.0 params (Task 3.1) — each optional so a legacy snapshot that omits it
  // renders no control (and its group stays empty → hidden).
  reserveBuffer?: ServerValue;
  sensitivityDelta?: ServerValue;
  nnnOpexAnnual?: ServerValue;
  buildingSqft?: ServerValue;
  salesfloorPct?: ServerValue;
  rentPerSqft?: ServerValue;
  utilitiesPerSqft?: ServerValue;
  /** Fixed operating-cost lines ({label: $/yr}); a single-line dict PATCH per edit. */
  fixedAnnual?: Record<string, number>;
  /** Display-only chip in the space-rates group (editing lives in the wizard). */
  leaseType?: string;
}

export interface PatchHandlerArgs {
  version: number;
  body: PatchBody;
}

export interface SettingsTabProps {
  settings: SettingsViewModel;
  /** Derived server KPIs (read-only) merged into the same grid (D11). */
  kpis?: Kpi[];
  version: number;
  /** Performs the PATCH (carries If-Match); throws PatchConflictError on 409. */
  onPatch: (args: PatchHandlerArgs) => Promise<PatchResult>;
  /** "Save as copy" recovery — POST …/duplicate (API_SPEC §4.4). */
  onSaveAsCopy?: () => void;
  debounceMs?: number;
}

// A `section` places a control either UNGROUPED at the top ("primary") or inside one
// of the paramGroups.ts groups (by group id). `scale` converts the HUMAN unit shown
// in the field to the engine raw (100 for a percent entered as "60", 1 for a
// dollar/count); `decimals` is the NumberField precision (2 for money, 1 for
// percents, 0 for whole counts). `stringValue` sends the PATCH value as a STRING
// (the server contract for the 1.6.0 input/assumption knobs). `fixedAnnualLine`
// marks a control that edits ONE line of the fixedAnnual dict (its PATCH is the
// single-line accumulating dict).
interface ControlDef {
  field: keyof SettingsViewModel;
  patchKey: string;
  label: string;
  section: string;
  group: "inputs" | "assumptions";
  unit: string;
  unitPosition: "prefix" | "suffix";
  scale: number;
  decimals: number;
  stringValue?: boolean;
  fixedAnnualLine?: string;
}

// A percent control: entered in HUMAN percent ("60"), divided by 100 at the boundary.
// Percents always keep ≥1 decimal so the raw fraction is never rounded to an integer.
function pct(
  field: keyof SettingsViewModel,
  patchKey: string,
  label: string,
  group: "inputs" | "assumptions",
  section: string,
  decimals = 1,
  stringValue = false,
): ControlDef {
  return {
    field,
    patchKey,
    label,
    group,
    section,
    unit: "%",
    unitPosition: "suffix",
    scale: 100,
    decimals,
    stringValue,
  };
}

// The canonical fixed-annual operating-cost lines, in display order (mirrors the
// wizard's StepStartupCosts). A control is generated per line PRESENT in the dict.
const FIXED_ANNUAL_LINES = [
  "Insurance liability",
  "Internet, Phones",
  "Pest control",
  "Repairs/maintenance",
  "Security system",
] as const;

// The static driver controls. Primary drivers (donor shares + $/donation) stay
// ungrouped at the top; every other knob is grouped by its paramGroups.ts section.
const CONTROLS: ControlDef[] = [
  // --- Primary drivers (ungrouped, always visible at top) ---
  pct("shareY1", "share_y1", "Year 1 share", "inputs", "primary"),
  pct("shareY2", "share_y2", "Year 2 share", "inputs", "primary"),
  pct("shareY3", "share_y3", "Year 3 share", "inputs", "primary"),
  pct("shareY4", "share_y4", "Year 4 share", "inputs", "primary"),
  pct("shareY5", "share_y5", "Year 5 share", "inputs", "primary"),
  { field: "donationValue", patchKey: "donation_value", label: "Per donation", group: "inputs", section: "primary", unit: "$", unitPosition: "prefix", scale: 1, decimals: 2 },

  // --- Space & occupancy rates (square-footage step) ---
  { field: "buildingSqft", patchKey: "building_sqft", label: "Building size", group: "inputs", section: "space-rates", unit: "sqft", unitPosition: "suffix", scale: 1, decimals: 0, stringValue: true },
  pct("salesfloorPct", "salesfloor_pct", "Sales-floor area", "inputs", "space-rates", 1, true),
  { field: "utilitiesPerSqft", patchKey: "utilities_per_sqft", label: "Utilities", group: "assumptions", section: "space-rates", unit: "$/sqft/yr", unitPosition: "suffix", scale: 1, decimals: 2, stringValue: true },

  // --- Donation economics (configure-donations step) ---
  { field: "basket", patchKey: "basket", label: "Average basket", group: "assumptions", section: "donation-econ", unit: "$", unitPosition: "prefix", scale: 1, decimals: 2 },
  { field: "donationsPerHouseholdPerYear", patchKey: "donations_per_hh", label: "Donations / donor", group: "assumptions", section: "donation-econ", unit: "/yr", unitPosition: "suffix", scale: 1, decimals: 0 },
  pct("salvagePct", "salvage_pct", "Salvage", "assumptions", "donation-econ", 2),

  // --- Rent & lease (startup-costs step) ---
  pct("escalator", "escalator", "Rent escalator", "assumptions", "rent-lease", 2),
  { field: "rentPerSqft", patchKey: "rent_per_sqft", label: "Rent", group: "inputs", section: "rent-lease", unit: "$/sqft/yr", unitPosition: "suffix", scale: 1, decimals: 2, stringValue: true },
  { field: "nnnOpexAnnual", patchKey: "nnn_opex_annual", label: "NNN operating expenses", group: "inputs", section: "rent-lease", unit: "$/yr", unitPosition: "suffix", scale: 1, decimals: 0, stringValue: true },

  // --- Operating cost structure (startup-costs step) ---
  pct("laborPct", "labor_pct", "Labor", "assumptions", "cost-structure", 2),
  pct("marketingPct", "marketing_pct", "Marketing", "assumptions", "cost-structure", 2),
  pct("suppliesPct", "supplies_pct", "Supplies", "assumptions", "cost-structure", 2),
  pct("cardPct", "card_pct", "Card fees", "assumptions", "cost-structure", 2),
  pct("payrollTaxPct", "payroll_tax_pct", "Payroll tax", "assumptions", "cost-structure", 2),
  // (fixed-annual lines are generated dynamically from settings.fixedAnnual below)

  // --- Funding & capital (startup-costs step) ---
  { field: "reserveBuffer", patchKey: "reserve_buffer", label: "Reserve buffer", group: "assumptions", section: "funding", unit: "$", unitPosition: "prefix", scale: 1, decimals: 0 },
  pct("sensitivityDelta", "sensitivity_delta", "Sensitivity stress", "assumptions", "funding", 2, true),
];

/** Generate one control per fixed-annual line PRESENT in the dict (canonical order
 *  first, then any server-added extras). Absent dict → no controls (legacy snapshot). */
function fixedAnnualControls(dict: Record<string, number> | undefined): ControlDef[] {
  if (!dict || typeof dict !== "object") return [];
  const keys = Object.keys(dict);
  const ordered = [
    ...FIXED_ANNUAL_LINES.filter((l) => l in dict),
    ...keys.filter((k) => !(FIXED_ANNUAL_LINES as readonly string[]).includes(k)),
  ];
  return ordered.map((line) => ({
    field: "fixedAnnual" as const,
    patchKey: "fixed_annual",
    label: line,
    section: "cost-structure",
    group: "assumptions" as const,
    unit: "$",
    unitPosition: "prefix" as const,
    scale: 1,
    decimals: 0,
    fixedAnnualLine: line,
  }));
}

/** The accessible name for a driver field: the clean label + its unit symbol, so a
 *  screen reader hears the unit the (aria-hidden) field suffix conveys visually. */
function ariaLabel(c: ControlDef): string {
  return `${c.label} ${c.unit}`;
}

/** A stable DOM key from a control (fixed-annual lines share `field`, so key on the line). */
function controlKey(c: ControlDef): string {
  return c.fixedAnnualLine ? `fixed:${c.fixedAnnualLine}` : String(c.field);
}

/** Is a control's underlying setting present? Fixed-annual controls are only ever
 *  generated when their line exists; every other control keys on its settings field. */
function isPresent(c: ControlDef, settings: SettingsViewModel): boolean {
  if (c.fixedAnnualLine) return true;
  return settings[c.field] !== undefined;
}

/** Seed the field's HUMAN value from the stored setting (raw × scale), or the
 *  fixed-annual dict line. Returns null when absent. Display seeding only. */
function seedHuman(c: ControlDef, settings: SettingsViewModel): number | null {
  if (c.fixedAnnualLine) {
    const v = settings.fixedAnnual?.[c.fixedAnnualLine];
    return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  }
  const val = settings[c.field] as ServerValue | undefined;
  if (!val || typeof val !== "object" || !("raw" in val)) return null;
  return val.raw * c.scale;
}

// Build the partial PATCH body for one driver. The field's HUMAN value ÷ scale = the
// engine raw. Fixed-annual is a single-line accumulating dict; the 1.6.0 knobs carry
// a STRING value; everything else (the legacy drivers) carries a number as before.
function buildBody(control: ControlDef, humanValue: number): PatchBody {
  const raw = humanValue / control.scale;
  const num = control.decimals === 0 ? Math.round(raw) : raw;
  if (control.fixedAnnualLine) {
    return { assumptions: { fixed_annual: { [control.fixedAnnualLine]: num } } };
  }
  const value: number | string = control.stringValue ? String(num) : num;
  if (control.group === "inputs") return { inputs: { [control.patchKey]: value } };
  return { assumptions: { [control.patchKey]: value } };
}

/** The human label for a lease-type code (display-only chip). */
function leaseLabel(code: string | undefined): string {
  if (code === "nnn") return "NNN (triple net)";
  if (code === "gross") return "Gross";
  return String(code ?? "");
}

export function SettingsTab({
  settings,
  kpis = [],
  version,
  onPatch,
  onSaveAsCopy,
  debounceMs = 350,
}: SettingsTabProps) {
  const [state, dispatch] = useReducer(autosaveReducer, version, initialAutosaveState);
  // Per-group expand/collapse; every group loads COLLAPSED (undefined → false).
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  // The pending change (control + human value) the debounce will flush. A ref so a
  // re-render mid-debounce doesn't reset the timer.
  const pending = useRef<{ control: ControlDef; value: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const versionRef = useRef(state.version);
  versionRef.current = state.version;

  function flush() {
    const change = pending.current;
    if (!change) return;
    dispatch({ type: "SAVE_START" });
    onPatch({ version: versionRef.current, body: buildBody(change.control, change.value) })
      .then((res) => {
        pending.current = null;
        dispatch({ type: "SAVE_SUCCESS", version: res.version });
      })
      .catch((err) => {
        if (err instanceof PatchConflictError) {
          dispatch({ type: "CONFLICT", conflict: err.conflict });
        } else {
          dispatch({ type: "SAVE_ERROR" });
        }
      });
  }

  function scheduleFlush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, debounceMs);
  }

  function onEdit(control: ControlDef, value: number | null) {
    if (value === null) return;
    pending.current = { control, value };
    dispatch({ type: "EDIT" });
    scheduleFlush();
  }

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function reload() {
    pending.current = null;
    dispatch({ type: "RELOAD" });
  }

  function overwrite() {
    dispatch({ type: "OVERWRITE" });
    queueMicrotask(() => {
      versionRef.current = state.conflict?.current_version ?? versionRef.current;
      flush();
    });
  }

  function toggleGroup(id: string) {
    setOpenGroups((s) => ({ ...s, [id]: !s[id] }));
  }

  function onGroupSummaryClick(id: string, e: MouseEvent<HTMLElement>) {
    // Suppress the native <details> toggle so the controlled `open` prop stays the
    // single source of truth (the same pattern as AdvancedOptions).
    e.preventDefault();
    toggleGroup(id);
  }

  function onGroupSummaryKeyDown(id: string, e: KeyboardEvent<HTMLElement>) {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      toggleGroup(id);
    }
  }

  // D12: only "Saving…" (a pending/in-flight save) and "Save failed" surface here;
  // the steady-state "Saved automatically" text is dropped (the TopBar carries the
  // save chip). "dirty" + "saving" both read as "Saving…" (a save is coming).
  const statusText =
    state.status === "dirty" || state.status === "saving"
      ? "Saving…"
      : state.status === "error"
        ? "Save failed — retry"
        : "";

  // The full control set (static + the dynamic fixed-annual lines), then split into
  // the ungrouped primary drivers and the per-group buckets. Only PRESENT controls
  // render (legacy snapshots omit the newer keys) — a group with none is dropped.
  const allControls = [...CONTROLS, ...fixedAnnualControls(settings.fixedAnnual)];
  const present = allControls.filter((c) => isPresent(c, settings));
  const primaryControls = present.filter((c) => c.section === "primary");

  /** One editable driver cell — a labelled <NumberField> with the unit glued on. */
  function renderControl(c: ControlDef) {
    const human = seedHuman(c, settings);
    const key = controlKey(c);
    const domId = key.replace(/[^a-z0-9]+/gi, "-");
    return (
      <div key={key} className="kpis-grid__cell kpis-grid__cell--driver">
        <span className="kpis-grid__label" id={`driver-${domId}-label`}>
          {/* The pencil marks this cell as editable (non-color cue). */}
          <span className="kpis-grid__edit-icon" aria-hidden="true">
            ✎
          </span>{" "}
          {c.label}
        </span>
        <NumberField
          value={human}
          onChange={(v) => onEdit(c, v)}
          unit={c.unit}
          unitPosition={c.unitPosition}
          decimals={c.decimals}
          min={0}
          aria-label={ariaLabel(c)}
        />
      </div>
    );
  }

  return (
    <section className="settings-tab kpis-grid" aria-label="Key metrics & settings" role="region">
      {/* Review-first: status sits above the controls (mobile-375). */}
      <div className="settings-tab__status" data-testid="autosave-status" aria-live="polite">
        {statusText}
      </div>

      {state.status === "conflict" && state.conflict && (
        <div className="settings-tab__conflict" role="alert">
          <p>{state.conflict.message || "This projection changed since you loaded it."}</p>
          <div className="settings-tab__conflict-actions">
            <button type="button" onClick={reload}>
              Reload (discard my changes)
            </button>
            <button type="button" onClick={overwrite}>
              Overwrite with my changes
            </button>
            <button type="button" onClick={() => onSaveAsCopy?.()}>
              Save as a copy
            </button>
          </div>
        </div>
      )}

      {/* KPIs + the primary donor-share drivers — the always-visible top grid. */}
      <div className="kpis-grid__cells">
        {/* Derived KPIs — READ-ONLY (revenue, net income, ratios). Display verbatim. */}
        {kpis.map((k) => (
          <div
            key={`kpi-${k.label}`}
            className="kpis-grid__cell kpis-grid__cell--derived"
            data-testid={/^total revenue$/i.test(k.label) ? "kpi-revenue" : `kpi-${k.label}`}
          >
            <span className="kpis-grid__label">{k.label}</span>
            <span
              className="kpis-grid__value num"
              data-negative={isNegative(k.value) ? "true" : undefined}
            >
              {k.value.display}
            </span>
            {k.sub && <span className="kpis-grid__sub">{k.sub}</span>}
          </div>
        ))}

        {/* Primary drivers (donor shares Y1–Y5 + $/donation), ungrouped. */}
        {primaryControls.map(renderControl)}
      </div>

      {/* One collapsible group per paramGroups.ts entry, in wizard-step order. The
          taxonomy list is already ordered by step, so iterating it directly yields
          the wizard order. A group with zero present controls (e.g. Timing) is
          skipped. Groups load collapsed; the control grid mounts only when open. */}
      {PARAM_GROUPS.map((group) => {
        const groupControls = present.filter((c) => c.section === group.id);
        const showLeaseChip = group.id === "space-rates" && settings.leaseType !== undefined;
        if (groupControls.length === 0 && !showLeaseChip) return null;

        const heading = `${STEP_LABELS[group.step]} — ${group.label}`;
        const open = openGroups[group.id] ?? false;
        const count = groupControls.length + (showLeaseChip ? 1 : 0);

        return (
          <details key={group.id} className="kpis-grid__group" open={open}>
            <summary
              className="kpis-grid__group-summary"
              data-testid={`settings-group-${group.id}`}
              tabIndex={0}
              aria-expanded={open}
              onClick={(e) => onGroupSummaryClick(group.id, e)}
              onKeyDown={(e) => onGroupSummaryKeyDown(group.id, e)}
            >
              <h3 className="kpis-grid__group-heading">{heading}</h3>
              <span className="kpis-grid__group-badge">
                {count} {count === 1 ? "setting" : "settings"}
              </span>
            </summary>
            {open && (
              <div className="kpis-grid__cells">
                {groupControls.map(renderControl)}
                {showLeaseChip && (
                  <div
                    className="kpis-grid__cell kpis-grid__cell--chip"
                    data-testid="settings-lease-type"
                  >
                    <span className="kpis-grid__label">Lease type</span>
                    <span
                      className="kpis-grid__chip"
                      title="Lease type is editable in the wizard"
                    >
                      {leaseLabel(settings.leaseType)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </details>
        );
      })}
    </section>
  );
}

export default SettingsTab;

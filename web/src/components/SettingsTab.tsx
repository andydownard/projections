// web/src/components/SettingsTab.tsx — EPIC D / D11: the merged "Key metrics &
// drivers" grid (the old KPI strip + the settings sliders fused into ONE compact
// grid with inline units).
//
//   - DERIVED KPIs (revenue, net income, ratios) render READ-ONLY, the server's
//     { display } string verbatim (PRD §13 — no client math).
//   - EDITABLE DRIVERS (labor / marketing / supplies / card / payroll-tax / salvage
//     %, rent escalator, the 5 donor shares, $/donation, average basket, and
//     donations/donor/yr) render a <NumberField> with the unit glued to the field.
//
// A driver edit debounces a PATCH carrying If-Match: <version> (API_SPEC §1.3/§4.4);
// a 409 raises a conflict banner offering reload / overwrite / save-as-copy. The
// percent drivers are entered in their HUMAN unit (e.g. "60" for 60%); the PATCH
// boundary divides by the scale to the engine's raw fraction (the same convention as
// the wizard's shareHelper — display formatting only, never client math). D12: the
// "Saved automatically" idle text is gone (the TopBar carries the save chip).
import { useEffect, useReducer, useRef } from "react";

import { NumberField } from "./NumberField";
import { isNegative } from "./displayLabels";
import { PatchConflictError, type PatchBody, type PatchResult } from "../api/patch";
import {
  autosaveReducer,
  initialAutosaveState,
} from "../state/autosaveReducer";
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

// Each editable driver maps a settings field → the PATCH key + its owning group.
// `scale` converts the HUMAN unit shown in the field to the engine raw (100 for a
// percent entered as "60", 1 for a dollar/count); `decimals` is the NumberField
// precision (2 for money, 1 for percents, 0 for whole counts).
interface ControlDef {
  field: keyof SettingsViewModel;
  patchKey: string;
  label: string;
  group: "inputs" | "assumptions";
  unit: string;
  unitPosition: "prefix" | "suffix";
  scale: number;
  decimals: number;
}

const pct = (
  field: keyof SettingsViewModel,
  patchKey: string,
  label: string,
  group: "inputs" | "assumptions",
  decimals = 1,
): ControlDef => ({
  field,
  patchKey,
  label,
  group,
  unit: "%",
  unitPosition: "suffix",
  scale: 100,
  decimals,
});

// The driver controls, in grid order. Cost %s + escalator are Assumptions; donor
// shares + $/donation are engine Inputs; basket + donations/yr are Assumptions.
// `label` is the CLEAN name (no unit); the unit is shown only by the field's
// suffix/prefix and is appended to the accessible name (see `ariaLabel`).
const CONTROLS: ControlDef[] = [
  pct("laborPct", "labor_pct", "Labor", "assumptions", 2),
  pct("marketingPct", "marketing_pct", "Marketing", "assumptions", 2),
  pct("suppliesPct", "supplies_pct", "Supplies", "assumptions", 2),
  pct("cardPct", "card_pct", "Card fees", "assumptions", 2),
  pct("payrollTaxPct", "payroll_tax_pct", "Payroll tax", "assumptions", 2),
  pct("salvagePct", "salvage_pct", "Salvage", "assumptions", 2),
  pct("escalator", "escalator", "Rent escalator", "assumptions", 2),
  pct("shareY1", "share_y1", "Year 1 share", "inputs"),
  pct("shareY2", "share_y2", "Year 2 share", "inputs"),
  pct("shareY3", "share_y3", "Year 3 share", "inputs"),
  pct("shareY4", "share_y4", "Year 4 share", "inputs"),
  pct("shareY5", "share_y5", "Year 5 share", "inputs"),
  { field: "donationValue", patchKey: "donation_value", label: "Per donation", group: "inputs", unit: "$", unitPosition: "prefix", scale: 1, decimals: 2 },
  { field: "basket", patchKey: "basket", label: "Average basket", group: "assumptions", unit: "$", unitPosition: "prefix", scale: 1, decimals: 2 },
  { field: "donationsPerHouseholdPerYear", patchKey: "donations_per_hh", label: "Donations / donor", group: "assumptions", unit: "/yr", unitPosition: "suffix", scale: 1, decimals: 0 },
];

/** The accessible name for a driver field: the clean label + its unit symbol, so a
 *  screen reader hears the unit the (aria-hidden) field suffix conveys visually. */
function ariaLabel(c: ControlDef): string {
  return `${c.label} ${c.unit}`;
}

// Build the partial PATCH body for one driver: the field's HUMAN value ÷ scale =
// the engine raw. Donor shares + $/donation are Inputs; the rest are Assumptions.
function buildBody(control: ControlDef, humanValue: number): PatchBody {
  const raw = humanValue / control.scale;
  const value = control.decimals === 0 ? Math.round(raw) : raw;
  if (control.group === "inputs") return { inputs: { [control.patchKey]: value } };
  return { assumptions: { [control.patchKey]: value } };
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

  // D12: only "Saving…" (a pending/in-flight save) and "Save failed" surface here;
  // the steady-state "Saved automatically" text is dropped (the TopBar carries the
  // save chip). "dirty" + "saving" both read as "Saving…" (a save is coming).
  const statusText =
    state.status === "dirty" || state.status === "saving"
      ? "Saving…"
      : state.status === "error"
        ? "Save failed — retry"
        : "";

  // Render only the driver controls whose setting is actually present (legacy
  // snapshots omit the 2.6.0 / E2 drivers) — year-count-agnostic, for drivers.
  const controls = CONTROLS.filter((c) => settings[c.field] !== undefined);

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

        {/* Editable drivers — a <NumberField> with the unit glued to the field. */}
        {controls.map((c) => {
          const sv = settings[c.field];
          const human = sv ? sv.raw * c.scale : null;
          return (
            <div key={c.field} className="kpis-grid__cell kpis-grid__cell--driver">
              <span className="kpis-grid__label" id={`driver-${c.field}-label`}>
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
        })}
      </div>
    </section>
  );
}

export default SettingsTab;

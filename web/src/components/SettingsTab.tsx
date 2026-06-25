// web/src/components/SettingsTab.tsx — SLICE 4: Settings & assumptions tab.
//
// Sliders for the cost %s + occupancy + escalator + the three demand shares,
// seeded from the server `settings` view-model ({ raw, display }). The DISPLAY
// string is the server's (PRD §13 — no client math); the slider's numeric `raw`
// is just the control position the user PATCHes back. Every change debounces a
// PATCH carrying If-Match: <version> (API_SPEC §1.3/§4.4). The bar shows
// "Saving…" / "Saved automatically", and a 409 raises a conflict banner offering
// reload / overwrite / save-as-copy (API_SPEC §1.4, PRD §19.4).
//
// Mobile-375 is review-first: the autosave status sits above the controls so a
// narrow-screen user sees save state before scrolling the sliders.
import { useEffect, useReducer, useRef } from "react";

import { PatchConflictError, type PatchBody, type PatchResult } from "../api/patch";
import {
  autosaveReducer,
  initialAutosaveState,
  saveLabel,
} from "../state/autosaveReducer";
import type { ServerValue } from "../api/client";

export interface SettingsViewModel {
  laborPct: ServerValue;
  marketingPct: ServerValue;
  suppliesPct: ServerValue;
  cardPct: ServerValue;
  payrollTaxPct: ServerValue;
  salvagePct: ServerValue;
  escalator: ServerValue;
  occupancyAnnual: ServerValue;
  shareY1: ServerValue;
  shareY2: ServerValue;
  shareY3: ServerValue;
}

export interface PatchHandlerArgs {
  version: number;
  body: PatchBody;
}

export interface SettingsTabProps {
  settings: SettingsViewModel;
  version: number;
  /** Performs the PATCH (carries If-Match); throws PatchConflictError on 409. */
  onPatch: (args: PatchHandlerArgs) => Promise<PatchResult>;
  /** "Save as copy" recovery — POST …/duplicate (API_SPEC §4.4). */
  onSaveAsCopy?: () => void;
  debounceMs?: number;
}

// Each control maps a settings field → the assumptions key the PATCH body uses
// (API_SPEC §4.4). Percent sliders move in `raw` (0..1) space.
interface ControlDef {
  field: keyof SettingsViewModel;
  patchKey: string;
  label: string;
  kind: "pct" | "money";
  min: number;
  max: number;
  step: number;
}

const PCT_CONTROLS: ControlDef[] = [
  { field: "laborPct", patchKey: "labor_pct", label: "Labor (payroll) % of revenue", kind: "pct", min: 0, max: 1, step: 0.005 },
  { field: "marketingPct", patchKey: "marketing_pct", label: "Marketing & outreach % of revenue", kind: "pct", min: 0, max: 0.2, step: 0.0025 },
  { field: "suppliesPct", patchKey: "supplies_pct", label: "Supplies & processing % of revenue", kind: "pct", min: 0, max: 0.2, step: 0.0025 },
  { field: "cardPct", patchKey: "card_pct", label: "Credit card fees % of revenue", kind: "pct", min: 0, max: 0.1, step: 0.0025 },
  { field: "payrollTaxPct", patchKey: "payroll_tax_pct", label: "Payroll taxes % of payroll", kind: "pct", min: 0, max: 0.2, step: 0.0025 },
  { field: "salvagePct", patchKey: "salvage_pct", label: "Salvage % of retail", kind: "pct", min: 0, max: 0.05, step: 0.001 },
  { field: "escalator", patchKey: "escalator", label: "Annual rent escalator", kind: "pct", min: 0, max: 0.1, step: 0.0025 },
];

const SHARE_CONTROLS: ControlDef[] = [
  { field: "shareY1", patchKey: "share_y1", label: "Year 1 share (donor market)", kind: "pct", min: 0, max: 0.3, step: 0.005 },
  { field: "shareY2", patchKey: "share_y2", label: "Year 2 share (donor market)", kind: "pct", min: 0, max: 0.3, step: 0.005 },
  { field: "shareY3", patchKey: "share_y3", label: "Year 3 share (donor market)", kind: "pct", min: 0, max: 0.3, step: 0.005 },
  // NOTE: aria-labels carry "Year N … share" so each is independently addressable
  //       (three explicit shares, PRD §7.1 — no auto-midpoint).
];

const OCCUPANCY: ControlDef = {
  field: "occupancyAnnual",
  patchKey: "occupancy_annual",
  label: "Annual occupancy (rent)",
  kind: "money",
  min: 0,
  max: 600000,
  step: 1000,
};

// Shares live under inputs.demand; everything else under assumptions (API_SPEC §4.4).
function buildBody(control: ControlDef, raw: number): PatchBody {
  if (control.field.startsWith("share")) {
    return { inputs: { demand: { [control.patchKey]: raw } } };
  }
  return { assumptions: { [control.patchKey]: raw } };
}

export function SettingsTab({
  settings,
  version,
  onPatch,
  onSaveAsCopy,
  debounceMs = 350,
}: SettingsTabProps) {
  const [state, dispatch] = useReducer(autosaveReducer, version, initialAutosaveState);

  // The pending change (control + raw value) the debounce will flush. A ref so a
  // re-render mid-debounce doesn't reset the timer.
  const pending = useRef<{ control: ControlDef; raw: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The version is held in a ref so the debounced flush always sends the latest
  // (e.g. after an OVERWRITE bumped it to current_version) without re-arming.
  const versionRef = useRef(state.version);
  versionRef.current = state.version;

  function flush() {
    const change = pending.current;
    if (!change) return;
    dispatch({ type: "SAVE_START" });
    onPatch({ version: versionRef.current, body: buildBody(change.control, change.raw) })
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

  function onSlide(control: ControlDef, value: string) {
    pending.current = { control, raw: Number(value) };
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
    // Re-arm a save at the server's current_version, then flush immediately so
    // the PATCH carries If-Match: <current_version> (API_SPEC §1.4 overwrite path).
    dispatch({ type: "OVERWRITE" });
    // versionRef updates on the next render; flush after that commit.
    queueMicrotask(() => {
      versionRef.current = state.conflict?.current_version ?? versionRef.current;
      flush();
    });
  }

  const allControls = [...PCT_CONTROLS, OCCUPANCY, ...SHARE_CONTROLS];

  return (
    <section className="settings-tab" aria-label="Settings & assumptions" role="region">
      {/* Review-first: status sits above the controls (mobile-375). */}
      <div className="settings-tab__status" data-testid="autosave-status" aria-live="polite">
        {saveLabel(state)}
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

      <div className="settings-tab__controls">
        {allControls.map((c) => {
          const sv = settings[c.field];
          return (
            <label key={c.field} className="settings-tab__control">
              <span className="settings-tab__control-label">{c.label}</span>
              <input
                type="range"
                aria-label={c.label}
                min={c.min}
                max={c.max}
                step={c.step}
                defaultValue={sv.raw}
                onChange={(e) => onSlide(c, e.target.value)}
              />
              {/* Server display string — rendered verbatim (no client math). */}
              <output className="settings-tab__control-value">{sv.display}</output>
            </label>
          );
        })}
      </div>
    </section>
  );
}

export default SettingsTab;

// web/src/state/autosaveReducer.ts — SLICE 4: the autosave state machine.
//
// The Settings tab debounces a PATCH after each slider change. This reducer owns
// the SAVE LIFECYCLE only — it never computes a projection figure (PRD §13). It
// tracks the optimistic-concurrency version (API_SPEC §1.3) and, on a stale
// mutation, the 409 conflict body so the UI can offer reload / overwrite /
// save-as-copy (API_SPEC §1.4, PRD §19.4).
//
// Why a re-dirty guard: a debounced save can be in flight when the user moves a
// slider again. SAVE_SUCCESS for the in-flight request must bump the version but
// NOT clear the freshly-pending edit, or that edit would never get persisted.

export type RecoveryOption = "reload" | "overwrite" | "save_as_copy";

/** The 409 body the server returns on a stale mutation (API_SPEC §1.4). */
export interface ConflictBody {
  error: "version_conflict";
  message: string;
  current_version: number;
  your_version: number;
  // The complete view-model at current_version (same shape as the §3 200 body).
  current_state: unknown;
  recovery: readonly RecoveryOption[];
}

export type AutosaveStatus =
  | "idle" // loaded, nothing pending
  | "dirty" // an edit is waiting for the debounce to fire
  | "saving" // a PATCH is in flight
  | "saved" // last PATCH succeeded, nothing pending
  | "error" // a non-conflict failure; retryable
  | "conflict"; // a 409 — recovery required before further saves

export interface AutosaveState {
  status: AutosaveStatus;
  /** The version the next PATCH will send as If-Match. */
  version: number;
  conflict: ConflictBody | null;
}

export type AutosaveAction =
  | { type: "EDIT" }
  | { type: "SAVE_START" }
  | { type: "SAVE_SUCCESS"; version: number }
  | { type: "SAVE_ERROR" }
  | { type: "CONFLICT"; conflict: ConflictBody }
  | { type: "RELOAD" }
  | { type: "OVERWRITE" };

export function initialAutosaveState(version: number): AutosaveState {
  return { status: "idle", version, conflict: null };
}

export function autosaveReducer(state: AutosaveState, action: AutosaveAction): AutosaveState {
  switch (action.type) {
    case "EDIT":
      // Any local change marks the model dirty so the debounce will save it.
      // Even mid-save, this re-dirties so the in-flight SAVE_SUCCESS won't
      // swallow the new edit.
      return { ...state, status: "dirty", conflict: null };

    case "SAVE_START":
      return { ...state, status: "saving" };

    case "SAVE_SUCCESS": {
      // Always adopt the server's new version. Only return to "saved" if no edit
      // arrived while this request was in flight (status would be "dirty" again).
      const stillDirty = state.status === "dirty";
      return {
        ...state,
        version: action.version,
        status: stillDirty ? "dirty" : "saved",
        conflict: null,
      };
    }

    case "SAVE_ERROR":
      // Non-conflict failure (network/5xx). Keep the version; the change is still
      // pending and can be retried.
      return { ...state, status: "error" };

    case "CONFLICT":
      // Stale mutation (API_SPEC §1.4). Hold the server's current state + version
      // so the UI can render the latest and offer recovery without a round-trip.
      return { ...state, status: "conflict", conflict: action.conflict };

    case "RELOAD": {
      // Discard local edits, adopt the server's current_version.
      const v = state.conflict?.current_version ?? state.version;
      return { status: "saved", version: v, conflict: null };
    }

    case "OVERWRITE": {
      // Force my values: re-arm a save carrying If-Match: <current_version>. RETAIN
      // the conflict body (wave-3 w2): the banner is cleared on SAVE_SUCCESS ONLY, so
      // a non-409 failure of the replay (500/network) keeps the banner actionable
      // rather than stranding "Save failed" with no recovery. A fresh 409 replaces it
      // via CONFLICT; a new local EDIT clears it (the user moved on).
      const v = state.conflict?.current_version ?? state.version;
      return { ...state, status: "dirty", version: v };
    }

    default:
      return state;
  }
}

const LABELS: Record<AutosaveStatus, string> = {
  idle: "Saved automatically",
  saved: "Saved automatically",
  dirty: "Saving…",
  saving: "Saving…",
  error: "Couldn’t save — retry",
  conflict: "This projection changed elsewhere",
};

/** The status string shown in the autosave indicator. */
export function saveLabel(state: AutosaveState): string {
  return LABELS[state.status];
}

// web/src/state/detailHeader.ts — bridges the detail page's header chips
// (model version + save state) up to the single shared TopBar (#150).
//
// TopBar is rendered ONCE in App as the persistent banner, above the active
// route. The model-version / save-state chips are detail-page-only (DESIGN_PROMPT
// header anchor), but the values live in ProjectionDetail, a child of <main>. A
// tiny external store — the same useSyncExternalStore primitive App already uses
// for routing — lets the detail page publish those values and the shell read them
// without a router/context dependency.
//
// Renders NOTHING computed: it carries the server-owned model_version string and a
// save-state enum verbatim (no client math, PRD §13). The detail page resets it on
// unmount and App also gates the chips on the detail route, so no chip ever leaks
// onto another route.
import { useSyncExternalStore } from "react";

import type { SaveState } from "../components/TopBar";

export interface DetailHeader {
  /** Server-owned model version (computed_json.model_version); undefined ⇒ no chip. */
  modelVersion?: string;
  /** Autosave state for the header save chip; "idle" ⇒ no chip. */
  saveState: SaveState;
}

const EMPTY: DetailHeader = { modelVersion: undefined, saveState: "idle" };

let state: DetailHeader = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Merge a partial update into the detail-header state and notify subscribers. */
export function setDetailHeader(next: Partial<DetailHeader>): void {
  const merged: DetailHeader = { ...state, ...next };
  if (merged.modelVersion === state.modelVersion && merged.saveState === state.saveState) {
    return; // no-op: keep the snapshot reference stable for useSyncExternalStore
  }
  state = merged;
  emit();
}

/** Reset to the empty (no-chip) state — called when the detail page unmounts. */
export function clearDetailHeader(): void {
  if (state === EMPTY) return;
  state = EMPTY;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): DetailHeader {
  return state;
}

/** Subscribe the shell to the current detail-header chips. */
export function useDetailHeader(): DetailHeader {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

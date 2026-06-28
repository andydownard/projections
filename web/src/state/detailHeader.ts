// web/src/state/detailHeader.ts — bridges the detail page's header save chip up
// to the single shared TopBar (#150).
//
// TopBar is rendered ONCE in App as the persistent banner, above the active
// route. The save-state chip is detail-page-only (DESIGN_PROMPT header anchor),
// but the value lives in ProjectionDetail, a child of <main>. A tiny external
// store — the same useSyncExternalStore primitive App already uses for routing —
// lets the detail page publish it and the shell read it without a router/context
// dependency.
//
// The model_version is NO LONGER published or displayed (#38) — it remains on
// computed_json (engine versioning contract + upgrade affordance); only the chip
// render is gone. Renders NOTHING computed: it carries a save-state enum verbatim
// (no client math, PRD §13). The detail page resets it on unmount and App also
// gates the chip on the detail route, so no chip ever leaks onto another route.
import { useSyncExternalStore } from "react";

import type { SaveState } from "../components/TopBar";

export interface DetailHeader {
  /** Autosave state for the header save chip; "idle" ⇒ no chip. */
  saveState: SaveState;
}

const EMPTY: DetailHeader = { saveState: "idle" };

let state: DetailHeader = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Merge a partial update into the detail-header state and notify subscribers. */
export function setDetailHeader(next: Partial<DetailHeader>): void {
  const merged: DetailHeader = { ...state, ...next };
  if (merged.saveState === state.saveState) {
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

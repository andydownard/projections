// web/src/wizard/draft.ts — wizard draft persistence (draft recovery after step 1).
//
// HARD RULE (handoff D2 AC): "no server record until Generate." The wizard creates
// NOTHING server-side until the final Generate. To avoid losing a half-entered
// projection on an accidental reload, we persist the in-progress draft to
// localStorage AFTER the user advances past step 1, and offer to recover it on the
// next wizard mount. This is a pure client affordance over local input — it never
// computes a projection figure (PRD §13) and carries no capability token.

import type { WizardDraft } from "./shareHelper";

export const DRAFT_KEY = "projections.wizard_draft";

export interface SavedDraft {
  step: number;
  draft: Partial<WizardDraft>;
  savedAt: string;
}

/** Persist the in-progress draft. Called only once the user is past step 1. */
export function saveDraft(step: number, draft: Partial<WizardDraft>): void {
  const payload: SavedDraft = { step, draft, savedAt: new Date().toISOString() };
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
  } catch {
    // Storage may be unavailable (private mode); draft recovery is best-effort.
  }
}

/** Read a recoverable draft, or null if none/corrupt. */
export function loadDraft(): SavedDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedDraft;
    if (typeof parsed.step !== "number" || typeof parsed.draft !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Clear the draft — on Generate (it is now a server record) or explicit discard. */
export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // best-effort
  }
}

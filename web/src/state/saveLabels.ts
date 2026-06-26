// web/src/state/saveLabels.ts — the ONE canonical autosave vocabulary (UX fix #10).
//
// The same save lifecycle is surfaced by the TopBar chip, the ProjectionDetail
// status line, and the SettingsTab bar (via the autosave reducer). Before this
// they each invented their own wording ("All changes saved" / "Saved
// automatically" / "Save failed — retry"), so the same state read as different
// things. This map is the single source of truth — import it, never re-type a
// save string. It owns NO math (PRD §13); it is display copy only.
export type SaveState = "idle" | "saved" | "saving" | "error";

export const SAVE_LABEL: Record<SaveState, string> = {
  idle: "Saved",
  saved: "Saved",
  saving: "Saving…",
  error: "Couldn't save — retry",
};

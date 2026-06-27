// web/src/state/autosaveReducer.test.ts — SLICE 4: autosave state machine.
//
// The Settings tab autosaves: every slider change marks the model dirty, a
// debounced PATCH carries If-Match: <version>, and the UI shows
// "Saved automatically" / "Saving…" / a 409 conflict banner with
// reload / overwrite / save-as-copy (API_SPEC §1.3/§1.4, PRD §19.4/§24/§25).
//
// The reducer owns NO math (PRD §13) — it only tracks save lifecycle + version.
import { describe, expect, it } from "vitest";

import {
  autosaveReducer,
  initialAutosaveState,
  saveLabel,
  type AutosaveState,
} from "./autosaveReducer";

describe("autosaveReducer — save lifecycle", () => {
  it("starts idle at the loaded version with no pending changes", () => {
    const s = initialAutosaveState(7);
    expect(s.status).toBe("idle");
    expect(s.version).toBe(7);
    expect(s.conflict).toBeNull();
  });

  it("EDIT marks the model dirty (a save is pending)", () => {
    const s = autosaveReducer(initialAutosaveState(7), { type: "EDIT" });
    expect(s.status).toBe("dirty");
    expect(s.version).toBe(7);
  });

  it("SAVE_START moves dirty → saving", () => {
    let s = autosaveReducer(initialAutosaveState(7), { type: "EDIT" });
    s = autosaveReducer(s, { type: "SAVE_START" });
    expect(s.status).toBe("saving");
  });

  it("SAVE_SUCCESS bumps the version and returns to saved (clean)", () => {
    let s = autosaveReducer(initialAutosaveState(7), { type: "EDIT" });
    s = autosaveReducer(s, { type: "SAVE_START" });
    s = autosaveReducer(s, { type: "SAVE_SUCCESS", version: 8 });
    expect(s.status).toBe("saved");
    expect(s.version).toBe(8);
    expect(s.conflict).toBeNull();
  });

  it("an EDIT during a save re-dirties so the next debounce saves again", () => {
    let s = autosaveReducer(initialAutosaveState(7), { type: "EDIT" });
    s = autosaveReducer(s, { type: "SAVE_START" });
    s = autosaveReducer(s, { type: "EDIT" });
    // a SAVE_SUCCESS for the in-flight request must NOT clear the new edit
    s = autosaveReducer(s, { type: "SAVE_SUCCESS", version: 8 });
    expect(s.version).toBe(8);
    expect(s.status).toBe("dirty");
  });

  it("SAVE_ERROR (non-conflict) surfaces a retryable error without losing the dirty flag", () => {
    let s = autosaveReducer(initialAutosaveState(7), { type: "EDIT" });
    s = autosaveReducer(s, { type: "SAVE_START" });
    s = autosaveReducer(s, { type: "SAVE_ERROR" });
    expect(s.status).toBe("error");
    expect(s.version).toBe(7); // version unchanged on failure
  });
});

describe("autosaveReducer — 409 conflict (API_SPEC §1.4)", () => {
  const conflictBody = {
    error: "version_conflict" as const,
    message: "This projection changed since you loaded it.",
    current_version: 9,
    your_version: 7,
    current_state: { settings: { laborPct: { raw: 0.6, display: "60%" } } },
    recovery: ["reload", "overwrite", "save_as_copy"] as const,
  };

  it("CONFLICT enters the conflict state carrying the server's current state + version", () => {
    let s = autosaveReducer(initialAutosaveState(7), { type: "EDIT" });
    s = autosaveReducer(s, { type: "SAVE_START" });
    s = autosaveReducer(s, { type: "CONFLICT", conflict: conflictBody });
    expect(s.status).toBe("conflict");
    expect(s.conflict).not.toBeNull();
    expect(s.conflict?.current_version).toBe(9);
    expect(s.conflict?.your_version).toBe(7);
    expect(s.conflict?.recovery).toContain("overwrite");
  });

  it("RELOAD adopts the server's current version and clears the conflict (discard local)", () => {
    let s = autosaveReducer(initialAutosaveState(7), { type: "EDIT" });
    s = autosaveReducer(s, { type: "CONFLICT", conflict: conflictBody });
    s = autosaveReducer(s, { type: "RELOAD" });
    expect(s.status).toBe("saved");
    expect(s.version).toBe(9); // jumped to server's current_version
    expect(s.conflict).toBeNull();
  });

  it("OVERWRITE re-arms a save at the server's current_version (force my values)", () => {
    let s = autosaveReducer(initialAutosaveState(7), { type: "EDIT" });
    s = autosaveReducer(s, { type: "CONFLICT", conflict: conflictBody });
    s = autosaveReducer(s, { type: "OVERWRITE" });
    expect(s.status).toBe("dirty"); // a save is pending again
    expect(s.version).toBe(9); // PATCH will carry If-Match: 9
    expect(s.conflict).toBeNull();
  });
});

describe("saveLabel — the status strings shown in the bar", () => {
  const at = (status: AutosaveState["status"]): string =>
    saveLabel({ ...initialAutosaveState(1), status });

  it("maps each status to its human label", () => {
    expect(at("idle")).toMatch(/saved automatically/i);
    expect(at("saved")).toMatch(/saved automatically/i);
    expect(at("dirty")).toMatch(/saving|unsaved/i);
    expect(at("saving")).toMatch(/saving…|saving/i);
    expect(at("error")).toMatch(/couldn’t save|could not save|retry/i);
    expect(at("conflict")).toMatch(/changed/i);
  });
});

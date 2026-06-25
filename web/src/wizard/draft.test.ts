import { afterEach, describe, expect, it } from "vitest";

import { DRAFT_KEY, clearDraft, loadDraft, saveDraft } from "./draft";

// SLICE 2 — draft recovery after step 1 (handoff D2 AC: "no server record until
// Generate"). The wizard persists the in-progress draft locally so an accidental
// reload mid-wizard does not lose entered inputs. Pure client affordance.

afterEach(() => {
  localStorage.clear();
});

describe("wizard draft persistence", () => {
  it("round-trips a saved draft with its step", () => {
    saveDraft(2, { name: "House of Hope", city: "Longview", households: 31800 });
    const loaded = loadDraft();
    expect(loaded).not.toBeNull();
    expect(loaded!.step).toBe(2);
    expect(loaded!.draft.name).toBe("House of Hope");
    expect(loaded!.draft.households).toBe(31800);
    expect(typeof loaded!.savedAt).toBe("string");
  });

  it("returns null when there is no draft", () => {
    expect(loadDraft()).toBeNull();
  });

  it("returns null (does not throw) on a corrupt draft", () => {
    localStorage.setItem(DRAFT_KEY, "{not json");
    expect(loadDraft()).toBeNull();
  });

  it("clears the draft (so Generate leaves no recoverable copy)", () => {
    saveDraft(3, { name: "X" });
    clearDraft();
    expect(loadDraft()).toBeNull();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

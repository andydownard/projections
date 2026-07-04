import { describe, expect, it } from "vitest";

import { groupsForStep, PARAM_GROUPS, type ParamGroup } from "./paramGroups";
import { STEPS, type StepKey } from "./steps";

// paramGroups.ts is the single source of the wizard's "advanced" grouping
// taxonomy — the Advanced Options disclosure on each step AND the Settings tab
// both render from this same list, so a group can never drift between the two
// surfaces (Wave 2 Task 2.1, the foundation the rest of the wave builds on).

describe("PARAM_GROUPS — the shared grouping taxonomy", () => {
  it("defines the six named groups with a stable id, label, and owning step", () => {
    expect(PARAM_GROUPS).toEqual([
      { id: "space-rates", label: "Space & occupancy rates", step: "square-footage" },
      { id: "donation-econ", label: "Donation economics", step: "configure-donations" },
      { id: "rent-lease", label: "Rent & lease", step: "startup-costs" },
      { id: "cost-structure", label: "Operating cost structure", step: "startup-costs" },
      { id: "funding", label: "Funding & capital", step: "startup-costs" },
      { id: "timing", label: "Timing", step: "startup-costs" },
    ]);
  });

  it("every group id is unique", () => {
    const ids = PARAM_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every group's step is a real StepKey (no drift against steps.ts)", () => {
    for (const g of PARAM_GROUPS) {
      expect(STEPS as readonly string[]).toContain(g.step);
    }
  });

  it("the address step has no advanced groups (nothing to disclose there)", () => {
    expect(groupsForStep("address")).toEqual([]);
  });
});

describe("groupsForStep — filters by owning step", () => {
  it("returns only the groups whose step matches", () => {
    const cases: [StepKey, string[]][] = [
      ["square-footage", ["space-rates"]],
      ["configure-donations", ["donation-econ"]],
      ["startup-costs", ["rent-lease", "cost-structure", "funding", "timing"]],
    ];
    for (const [step, expectedIds] of cases) {
      const groups: ParamGroup[] = groupsForStep(step);
      expect(groups.map((g) => g.id)).toEqual(expectedIds);
    }
  });
});

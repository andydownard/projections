// web/src/wizard/paramGroups.ts — the single source for the wizard's "advanced"
// grouping taxonomy (Wave 2 Task 2.1). Each wizard step's Advanced Options
// disclosure AND the Settings tab render their groups from this SAME list, so a
// group's id/label/owning-step can never drift between the two surfaces. No
// client math here (PRD §13) — this is pure UI grouping metadata, not a
// computed value.
import type { StepKey } from "./steps";

export interface ParamGroup {
  id: string;
  label: string;
  step: StepKey;
}

export const PARAM_GROUPS: readonly ParamGroup[] = [
  { id: "space-rates", label: "Space & occupancy rates", step: "square-footage" },
  { id: "donation-econ", label: "Donation economics", step: "configure-donations" },
  { id: "rent-lease", label: "Rent & lease", step: "startup-costs" },
  { id: "cost-structure", label: "Operating cost structure", step: "startup-costs" },
  { id: "funding", label: "Funding & capital", step: "startup-costs" },
  { id: "timing", label: "Timing", step: "startup-costs" },
] as const;

/** The advanced groups owned by a given step, in taxonomy order. The address
 * step owns none — it has nothing to disclose. */
export const groupsForStep = (s: StepKey): ParamGroup[] =>
  PARAM_GROUPS.filter((g) => g.step === s);

// web/src/components/RecoChip.tsx — recommendation chip.
//
// The API emits a SEMANTIC enum; the client maps enum → a CSS token class (never
// inline hex — CLAUDE.md / API_SPEC §3). Meaning carries TEXT, not color alone
// (a11y / DoD: no color-only meaning).
import type { RecoTag } from "../api/projections";

const RECO_LABEL: Record<RecoTag, string> = {
  proceed: "Proceed",
  revise: "Revise",
  find_cheaper_rent: "Find cheaper rent",
  raise_cash: "Raise cash",
  delay: "Delay",
  do_not_proceed: "Do not proceed",
};

export interface RecoChipProps {
  tag: RecoTag;
}

export function RecoChip({ tag }: RecoChipProps) {
  return (
    <span
      className="reco-chip"
      data-testid="reco-chip"
      data-tag={tag}
      aria-label={`Recommendation: ${RECO_LABEL[tag]}`}
    >
      {RECO_LABEL[tag]}
    </span>
  );
}

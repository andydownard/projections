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

// Per-tag status glyph so the verdict survives in grayscale / colorblind / print
// (a11y / DoD: meaning carries an ICON + TEXT, never color alone). The glyph is
// purely decorative — aria-hidden — because the aria-label already speaks the
// verdict. proceed → check, do_not_proceed → cross, everything else (the
// conditional/revise verdicts) → a triangle "caution" mark.
const RECO_GLYPH: Record<RecoTag, string> = {
  proceed: "✓", // ✓
  revise: "△", // △
  find_cheaper_rent: "△", // △
  raise_cash: "△", // △
  delay: "△", // △
  do_not_proceed: "✕", // ✕
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
      <span className="reco-chip__glyph" data-testid="reco-chip-glyph" aria-hidden="true">
        {RECO_GLYPH[tag]}
      </span>
      {RECO_LABEL[tag]}
    </span>
  );
}

export default RecoChip;

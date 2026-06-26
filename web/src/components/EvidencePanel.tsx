// web/src/components/EvidencePanel.tsx — the trust surface (PRD §15).
//
// Renders the server-emitted evidence[] (households from the Census, rent when
// researched) with verified-vs-estimated conveyed by ICON + TEXT, not color
// alone, plus source/geography/MOE. "Every number shows its evidence" made
// visible — the differentiator vs. a spreadsheet. No client math.
import type { EvidenceItem } from "../api/viewModel";

const fmtInt = (n: number) => new Intl.NumberFormat("en-US").format(n);

function evidenceValue(e: EvidenceItem): string {
  if (e.value == null) return "—";
  if (e.field === "households") {
    const n = Number(e.value);
    return Number.isFinite(n) ? `~${fmtInt(n)} households` : String(e.value);
  }
  return String(e.value);
}

export interface EvidencePanelProps {
  evidence: EvidenceItem[];
}

export function EvidencePanel({ evidence }: EvidencePanelProps) {
  if (!evidence || evidence.length === 0) return null;
  return (
    <section className="evidence" aria-label="Evidence and confidence" data-testid="evidence-panel">
      <h3 className="evidence__heading">Evidence &amp; confidence</h3>
      <ul className="evidence__list">
        {evidence.map((e, i) => {
          const verified = e.confidence === "verified";
          return (
            <li key={`${e.field}-${i}`} className="evidence__item">
              <div className="evidence__head">
                <span className="evidence__label">{e.label}</span>
                <span
                  className={`evidence__badge evidence__badge--${verified ? "verified" : "estimated"}`}
                >
                  {verified ? "✓ Verified" : "≈ Estimated"}
                </span>
              </div>
              <div className="evidence__value num">{evidenceValue(e)}</div>
              <p className="evidence__meta">
                {[
                  e.source,
                  e.geography,
                  e.moe != null ? `±${fmtInt(e.moe)} households (MOE)` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

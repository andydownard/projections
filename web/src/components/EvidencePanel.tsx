// web/src/components/EvidencePanel.tsx — the trust surface (PRD §15).
//
// Renders the server-emitted evidence[] (households from the Census, rent when
// researched) with verified-vs-estimated conveyed by ICON + TEXT, not color
// alone, plus source/geography/MOE. "Every number shows its evidence" made
// visible — the differentiator vs. a spreadsheet. No client math.
import type { EvidenceItem } from "../api/viewModel";

// The server is the sole formatting authority (PRD §13): render its display
// strings VERBATIM — no client-side Intl / number formatting, no client math.
function evidenceValue(e: EvidenceItem): string {
  if (e.value_display != null) return e.value_display;
  if (e.value == null) return "—";
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
                  e.moe_display ?? null,
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

// web/src/components/DecisionBanner.tsx — the go/no-go decision artifact.
//
// The decision ships together (PRD §12): a verdict banner (semantic reco tag →
// color token via RecoChip, meaning carried in TEXT) plus the three decision
// metrics — startup capital, break-even month, first-year cash gap. All strings
// are the server's `display` (no client math).
import { RecoChip } from "./RecoChip";
import type { Metrics, Reco } from "../api/viewModel";

export interface DecisionBannerProps {
  reco: Reco;
  metrics: Metrics;
}

interface MetricDef {
  testid: string;
  label: string;
  pick: (m: Metrics) => { display: string };
}

const METRICS: MetricDef[] = [
  { testid: "metric-capital", label: "Startup capital required", pick: (m) => m.capital },
  { testid: "metric-breakeven", label: "Break-even", pick: (m) => m.breakeven },
  { testid: "metric-cashgap", label: "First-year cash gap", pick: (m) => m.cashGap },
];

export function DecisionBanner({ reco, metrics }: DecisionBannerProps) {
  return (
    <section
      className="decision-banner"
      data-testid="decision-banner"
      data-tag={reco.tag}
      aria-label="Decision"
    >
      <div className="decision-banner__verdict">
        <RecoChip tag={reco.tag} />
        <div>
          <p className="decision-banner__headline">{reco.headline}</p>
          <p className="decision-banner__sub">{reco.sub}</p>
        </div>
      </div>
      <dl className="decision-banner__metrics">
        {METRICS.map((d) => (
          <div key={d.testid} className="metric" data-testid={d.testid}>
            <dt className="metric__label">{d.label}</dt>
            <dd className="metric__value">{d.pick(metrics).display}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

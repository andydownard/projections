// web/src/components/DecisionBanner.tsx — the go/no-go decision artifact.
//
// The decision ships together (PRD §12): a verdict banner (semantic reco tag →
// color token via RecoChip, meaning carried in TEXT) plus the decision metrics —
// startup capital, break-even, payback, first-year cash gap. All strings are the
// server's `display` (no client math). Break-even and Payback each surface their
// plain-language product definition through a keyboard-accessible help control
// (icon + text, not color alone), and an unreached milestone renders an explicit
// N/A-with-reason — never a misleading 0 (issue #117).
import { RecoChip } from "./RecoChip";
import { cashGapLabel } from "./displayLabels";
import type { Metrics, Milestone, Milestones, Reco } from "../api/viewModel";

export interface DecisionBannerProps {
  reco: Reco;
  metrics: Metrics;
  /** Server {raw,display} milestones (issue #117). When present, Break-even is
   *  sourced from `breakEven` (carrying its N/A-with-reason flag) and a Payback
   *  metric is added. Optional so legacy snapshots still render. */
  milestones?: Milestones;
}

// The exact product definitions (issue #117 / spec §8) — surfaced verbatim.
const BREAKEVEN_DEF =
  "The milestone where your ongoing revenue matches your ongoing expenses. " +
  "Crossing this line means your day-to-day operations are officially profitable.";
const PAYBACK_DEF =
  "The length of time it takes for those accumulated profits to equal your " +
  "initial startup costs. Reaching the end of this period means you have " +
  "officially recovered your investment.";

/** A keyboard-focusable info control whose definition is announced to screen
 *  readers via aria-describedby and shown on hover/focus/tap (tooltip). */
function HelpTip({ id, term, definition }: { id: string; term: string; definition: string }) {
  return (
    <span className="helptip">
      <button
        type="button"
        className="helptip__btn"
        aria-label={`What is the ${term}?`}
        aria-describedby={id}
      >
        <span aria-hidden="true">i</span>
      </button>
      <span role="tooltip" id={id} className="helptip__bubble">
        {definition}
      </span>
    </span>
  );
}

interface MetricCell {
  testid: string;
  label: string;
  value: Milestone | { display: string };
  /** Optional N/A reason (shown when the value is unreached). */
  reason?: string;
  help?: { id: string; term: string; definition: string };
}

export function DecisionBanner({ reco, metrics, milestones }: DecisionBannerProps) {
  // Break-even prefers the milestone (carries its N/A reason) when available,
  // else the legacy metrics field. No client formatting — server display only.
  const breakeven: Milestone | { display: string } = milestones
    ? milestones.breakEven
    : metrics.breakeven;
  const breakevenReason = milestones ? milestones.breakEven.reason : undefined;

  const cells: MetricCell[] = [
    // #324: one capital label across the app — "Capital required" (MetricBar / KPI /
    // list all use it), so the board never sees two names for the same figure.
    { testid: "metric-capital", label: "Capital required", value: metrics.capital },
    {
      testid: "metric-breakeven",
      label: "Break-even",
      value: breakeven,
      reason: breakevenReason,
      help: { id: "helptip-breakeven", term: "Break-even Point", definition: BREAKEVEN_DEF },
    },
  ];

  // Payback only when the server emits milestones (legacy snapshots have no field).
  if (milestones) {
    cells.push({
      testid: "metric-payback",
      label: "Payback",
      value: milestones.payback,
      reason: milestones.payback.reason,
      help: { id: "helptip-payback", term: "Payback Period", definition: PAYBACK_DEF },
    });
  }

  // #194: sign-aware label — a positive trough is a cushion (lowest cash balance),
  // not a "gap". Server `display` is rendered verbatim; only the label flips by sign.
  cells.push({
    testid: "metric-cashgap",
    label: cashGapLabel(metrics.cashGap),
    value: metrics.cashGap,
  });

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
        {cells.map((c) => {
          const isNa = "raw" in c.value && c.value.raw == null;
          return (
            <div key={c.testid} className="metric" data-testid={c.testid}>
              <dt className="metric__label">
                {c.label}
                {c.help && (
                  <HelpTip id={c.help.id} term={c.help.term} definition={c.help.definition} />
                )}
              </dt>
              <dd className="metric__value">{c.value.display}</dd>
              {/* Explicit N/A-with-reason (never a misleading 0). */}
              {isNa && c.reason && <p className="metric__reason">{c.reason}</p>}
            </div>
          );
        })}
      </dl>
    </section>
  );
}

// web/src/components/ProjectionsList.tsx — v2 owner-scoped list (EPIC L redesign).
//
// Owner-scoped; no global index. Columns: Location (name + updated date),
// Recommendation (RecoChip), Income (sparkline Y1..Y5 net income + Y5 label),
// Capital required (red), Payback, Breakeven, Caret. The entire row is the click
// target → /p/<slug>/edit.
//
// Audit P2 restore: the initial v2 redesign dropped the Recommendation chip and
// right-aligned the Payback/Breakeven month counts as plain left-aligned text.
// The server never stopped emitting `reco_tag` on every list row — this is a
// "decision-and-funding tool, not a calculator" (CLAUDE.md), so hiding the
// go/no-go headline from the list was a real regression, not a simplification.
// Payback/Breakeven now share the `.num` tabular-nums treatment with the other
// numeric columns.
//
// Money arrives as server {raw, display} and is rendered VERBATIM — no client math
// (PRD §13 / SERVER). The sparkline receives the raw numeric points extracted from
// the server's income_series; the Y5 label is the server's display string.
import type { ProjectionListItem } from "../api/projections";
import { RecoChip } from "./RecoChip";
import { Sparkline } from "./Sparkline";
import { formatListDate, isNegative } from "./displayLabels";

export interface ProjectionsListProps {
  projections: ProjectionListItem[];
  onCreate: () => void;
  /** Called with the view_slug when a row is activated → routes to /p/<slug>/edit.
   *  The list is owner-scoped, so every listed row is owner-editable. */
  onRowClick: (viewSlug: string) => void;
}

export function ProjectionsList({
  projections,
  onCreate,
  onRowClick,
}: ProjectionsListProps) {
  if (projections.length === 0) {
    return (
      <section className="list-empty" aria-labelledby="list-heading">
        {/* L1: h1 is "Projections" on both empty and populated states (v2). */}
        <header className="list__header">
          <h1 id="list-heading">Projections</h1>
          <button type="button" className="btn btn--primary" onClick={onCreate}>
            New projection
          </button>
        </header>
        <p>No projections yet. Build a board-ready projection from a few inputs.</p>
      </section>
    );
  }

  return (
    <section className="list" aria-labelledby="list-heading">
      {/* L1: h1 is "Projections" (drop "Your"). */}
      <header className="list__header">
        <h1 id="list-heading">Projections</h1>
        <button type="button" className="btn btn--primary" onClick={onCreate}>
          New projection
        </button>
      </header>
      <table className="list__table">
        <thead>
          <tr>
            {/* L3 column headers (v2 redesign). Recommendation restored (audit P2):
                the server never stopped emitting reco_tag; the list UI had silently
                dropped the decision headline this "decision, not a calculator" tool
                exists to surface. */}
            <th scope="col">Location</th>
            <th scope="col">Recommendation</th>
            <th scope="col">Income</th>
            <th scope="col" className="num">
              Capital required
            </th>
            <th scope="col" className="num">
              Payback
            </th>
            <th scope="col" className="num">
              Breakeven
            </th>
            {/* Caret column: no visible label; aria-label tells screen readers this
                column holds the row-open affordance. */}
            <th scope="col" className="list__caret-col" aria-label="Open"></th>
          </tr>
        </thead>
        <tbody>
          {projections.map((p) => {
            // Extract the raw numeric points for the sparkline from the server's
            // income_series (array of {raw, display}). No math — just plucking the
            // raw value the server already computed.
            const sparkPoints = (p.income_series || []).map((v) => v.raw);
            const sparkAriaLabel = `Annual net income Year 1 to Year 5 for ${p.name}, ending at ${p.y5_income?.display ?? "N/A"}`;

            return (
              // L2: the entire row is the click target → /p/<slug>/edit.
              // role="button" + tabIndex={0} + keyboard handler make it accessible
              // (Enter/Space fire the same action as a click, per WCAG 2.1 AA).
              <tr
                key={p.view_slug}
                data-testid={`projection-row-${p.view_slug}`}
                className="list__row"
                role="button"
                tabIndex={0}
                aria-label={`Open ${p.name}`}
                onClick={() => onRowClick(p.view_slug)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onRowClick(p.view_slug);
                  }
                }}
              >
                {/* L3 col 1: Location — name on top; updated date directly below in
                    the same font but --text-muted (2-line cell). */}
                <td>
                  <div className="list__location">
                    <span className="list__name">{p.name}</span>
                    <span className="list__date">{formatListDate(p.updated_at)}</span>
                  </div>
                </td>

                {/* Recommendation — the semantic go/no-go chip (audit P2 restore).
                    RecoChip maps the server's enum to a CSS token; meaning carries
                    text, never color alone. */}
                <td>
                  <RecoChip tag={p.reco_tag} />
                </td>

                {/* L3 col 2: Income sparkline (annual net income Y1..Y5) + Y5 label.
                    The Sparkline component is GEOMETRY ONLY — it receives server raw
                    points and the server's display label; no client math (PRD §13). */}
                <td className="list__income-cell">
                  <Sparkline
                    points={sparkPoints}
                    y5Label={p.y5_income?.display}
                    aria-label={sparkAriaLabel}
                  />
                </td>

                {/* L3 col 3: Capital required — red (--error), tabular right-aligned.
                    The server's display string is rendered verbatim; isNegative reads
                    the sign of the server raw value for the color cue (#148 pattern). */}
                <td
                  className="num list__capital"
                  data-negative={isNegative(p.capital_required) ? "true" : undefined}
                >
                  {p.capital_required.display}
                </td>

                {/* L3 col 4: Payback — server display string verbatim, right-aligned
                    tabular-nums (audit P2: this month-count column rendered
                    left-aligned like text next to the right-aligned money columns). */}
                <td className="num">{p.payback.display}</td>

                {/* L3 col 5: Breakeven — server display string verbatim, right-aligned
                    tabular-nums (same audit P2 fix). */}
                <td className="num">{p.breakeven.display}</td>

                {/* L3 col 6: Caret — visual affordance for the row click target.
                    aria-hidden because the row's own aria-label already names the
                    action ("Open <name>"). */}
                <td className="list__caret" aria-hidden="true">›</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

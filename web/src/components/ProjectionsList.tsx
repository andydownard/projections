// web/src/components/ProjectionsList.tsx — owner-scoped list page (PRD §19.1).
//
// Owner-scoped; no global index. Each row: name, location + basis, updated,
// Year-1 revenue, net income, capital required, and a recommendation chip. Money
// is the server { display } rendered VERBATIM (no client math). Empty state is
// utilitarian (heading + a single Create action; no marketing illustration).
import type { ProjectionListItem } from "../api/projections";
import { RecoChip } from "./RecoChip";
import { TradeAreaMap } from "./TradeAreaMap";
import { basisLabel, formatListDate, isNegative } from "./displayLabels";

export interface ProjectionsListProps {
  projections: ProjectionListItem[];
  onCreate: () => void;
  onOpen: (viewSlug: string) => void;
  /** Open the EDITABLE detail (Settings/sliders/overrides/autosave) for an owned
   *  projection (#143). The list is owner-scoped, so every row is editable by its
   *  owner; the owner token in localStorage authorizes the PATCH (no secret in the
   *  URL). Omitted ⇒ no Edit affordance renders. */
  onEdit?: (viewSlug: string) => void;
}

export function ProjectionsList({
  projections,
  onCreate,
  onOpen,
  onEdit,
}: ProjectionsListProps) {
  if (projections.length === 0) {
    return (
      <section className="list-empty" aria-labelledby="empty-heading">
        {/* QA P1 (decision #4): the create button is CONSISTENT with the populated
            state — same upper-right `.list__header` placement, same label + styling.
            (Previously this was a "Create projection" button on the LEFT below the
            copy; now it matches the populated "New projection" header control.) */}
        <header className="list__header">
          <h1 id="empty-heading">No projections yet</h1>
          <button type="button" className="btn btn--primary" onClick={onCreate}>
            New projection
          </button>
        </header>
        <p>Build a board-ready 3-year projection from a few inputs.</p>
      </section>
    );
  }

  return (
    <section className="list" aria-labelledby="list-heading">
      <header className="list__header">
        <h1 id="list-heading">Your projections</h1>
        <button type="button" className="btn btn--primary" onClick={onCreate}>
          New projection
        </button>
      </header>
      <table className="list__table">
        <thead>
          <tr>
            <th scope="col">Projection</th>
            <th scope="col">Updated</th>
            <th scope="col" className="num">
              Y1 revenue
            </th>
            <th scope="col" className="num">
              Y1 net
            </th>
            <th scope="col" className="num">
              Capital required
            </th>
            <th scope="col">Recommendation</th>
          </tr>
        </thead>
        <tbody>
          {projections.map((p) => (
            <tr key={p.view_slug} data-testid={`projection-row-${p.view_slug}`}>
              <td>
                <div className="list__cell">
                  <TradeAreaMap
                    slug={p.view_slug}
                    location={
                      p.coords
                        ? { lat: p.coords.lat, lng: p.coords.lng, formatted_address: p.location }
                        : null
                    }
                    size="thumb"
                  />
                  <div>
                    <button
                      type="button"
                      className="list__open"
                      aria-label={`Open ${p.name}`}
                      onClick={() => onOpen(p.view_slug)}
                    >
                      {p.name}
                    </button>
                    <span className="list__sub">
                      {/* #151: render a human basis label, never the raw enum
                          code (e.g. "city" → "City"). */}
                      {p.location} · {basisLabel(p.basis)}
                    </span>
                    {onEdit && (
                      <button
                        type="button"
                        data-testid={`projection-edit-${p.view_slug}`}
                        aria-label={`Edit ${p.name}`}
                        onClick={() => onEdit(p.view_slug)}
                        // PE1 inline style: a compact secondary action that doesn't
                        // depend on shared tokens.css (avoids cross-agent CSS churn).
                        style={{
                          display: "inline-block",
                          marginTop: "0.25rem",
                          padding: "0.125rem 0.5rem",
                          fontSize: "var(--text-sm)",
                          fontWeight: 600,
                          color: "var(--brand-primary)",
                          background: "transparent",
                          border: "1px solid var(--line)",
                          borderRadius: "6px",
                          cursor: "pointer",
                        }}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </div>
              </td>
              {/* #151: friendly, locale-stable date — not a raw ISO slice. */}
              <td>{formatListDate(p.updated_at)}</td>
              {/* #148: losses get the error color PAIRED with the server's
                  parentheses (the non-color cue); positives are unflagged. */}
              <td className="num" data-negative={isNegative(p.y1_revenue) ? "true" : undefined}>
                {p.y1_revenue.display}
              </td>
              <td className="num" data-negative={isNegative(p.y1_net) ? "true" : undefined}>
                {p.y1_net.display}
              </td>
              <td className="num" data-negative={isNegative(p.capital_required) ? "true" : undefined}>
                {p.capital_required.display}
              </td>
              <td>
                <RecoChip tag={p.reco_tag} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

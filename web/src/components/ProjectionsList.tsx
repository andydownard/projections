// web/src/components/ProjectionsList.tsx — owner-scoped list page (PRD §19.1).
//
// Owner-scoped; no global index. Each row: name, location + basis, updated,
// Year-1 revenue, net profit, capital required, and a recommendation chip. Money
// is the server { display } rendered VERBATIM (no client math). Empty state is
// utilitarian (heading + Create + start-from-example; no marketing illustration).
import type { ProjectionListItem } from "../api/projections";
import { RecoChip } from "./RecoChip";
import { TradeAreaMap } from "./TradeAreaMap";

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

function formatUpdated(iso: string): string {
  // Display-only date; not a projection figure. Render server timestamp shortened.
  return iso.slice(0, 10);
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
        <h1 id="empty-heading">No projections yet</h1>
        <p>Build a board-ready 3-year projection from a few inputs.</p>
        <div className="list-empty__actions">
          <button type="button" className="btn btn--primary" onClick={onCreate}>
            Create projection
          </button>
          <button type="button" className="btn" onClick={onCreate}>
            Start from example
          </button>
        </div>
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
                      {p.location} · {p.basis}
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
                          fontSize: "0.75rem",
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
              <td>{formatUpdated(p.updated_at)}</td>
              <td className="num">{p.y1_revenue.display}</td>
              <td className="num">{p.y1_net.display}</td>
              <td className="num">{p.capital_required.display}</td>
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

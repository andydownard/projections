// web/src/pages/ListPage.tsx — the global projections list (PRD §19.1).
//
// This project has no authentication (owner decision, 2026-09-13): listProjections
// returns every projection in the database, unfiltered. Money arrives as server
// { display } and is rendered VERBATIM (no client math).
//
// v2 (EPIC L): the entire row is the click target → /p/<slug>/edit. Moving a
// projection to Trash is a detail-page-only action (its own "Delete" button +
// confirm dialog on /p/<slug>/edit) — the list carries no per-row actions menu.
// The header "Trash" link opens the Trash view (/trash) where trashed
// projections can be restored or permanently deleted.
import { useEffect, useState } from "react";

import { listProjections, type ProjectionListItem } from "../api/projections";
import { ProjectionsList } from "../components/ProjectionsList";

function navigate(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function ListPage() {
  const [projections, setProjections] = useState<ProjectionListItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    listProjections()
      .then((resp) => {
        if (alive) setProjections(resp.projections);
      })
      .catch(() => {
        if (alive) setProjections([]);
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!loaded) {
    return (
      <section className="list-loading" aria-busy="true">
        <p>Loading projections…</p>
      </section>
    );
  }

  return (
    <ProjectionsList
      projections={projections}
      onCreate={() => navigate("/wizard")}
      // v2 (L2): the entire row is the click target; always routes to the editable
      // detail (/p/<slug>/edit) — no credential of any kind gates the edit.
      onRowClick={(slug) => navigate(`/p/${slug}/edit`)}
      onOpenTrash={() => navigate("/trash")}
    />
  );
}

export default ListPage;

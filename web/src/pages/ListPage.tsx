// web/src/pages/ListPage.tsx — owner-scoped list page (PRD §19.1 / §20).
//
// OWNER-SCOPED, no global index: listProjections sends Authorization: Bearer
// <owner_token> from localStorage and the server filters by owner_token_hash.
// Without a token there is nothing to list — the utilitarian empty state shows.
// Money arrives as server { display } and is rendered VERBATIM (no client math).
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
        // Owner-scoped read failure falls back to the empty state; never a global list.
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
        <p>Loading your projections…</p>
      </section>
    );
  }

  return (
    <ProjectionsList
      projections={projections}
      onCreate={() => navigate("/wizard")}
      onOpen={(slug) => navigate(`/p/${slug}`)}
    />
  );
}

export default ListPage;

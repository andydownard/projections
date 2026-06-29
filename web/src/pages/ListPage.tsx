// web/src/pages/ListPage.tsx — owner-scoped list page (PRD §19.1 / §20).
//
// OWNER-SCOPED, no global index: listProjections sends Authorization: Bearer
// <owner_token> from localStorage and the server filters by owner_token_hash.
// Without a token there is nothing to list — the utilitarian empty state shows.
// Money arrives as server { display } and is rendered VERBATIM (no client math).
//
// v2 (EPIC L): the entire row is the click target → /p/<slug>/edit. The per-row
// "⋯" menu offers "Move to Trash" → a confirm dialog → POST /trash (If-Match) →
// the row drops out of the list and a toast confirms. The header "Trash" link opens
// the Trash view (/trash) where trashed projections can be restored or permanently
// deleted. All owner-scoped; no secret in any URL.
import { useEffect, useState } from "react";

import {
  LifecycleConflictError,
  listProjections,
  trashProjection,
  type ProjectionListItem,
} from "../api/projections";
import { ProjectionsList } from "../components/ProjectionsList";
import { TrashConfirmDialog } from "../components/TrashConfirmDialog";
import { useToast } from "../components/Toast";
import { TRASH_CONFLICT, TRASH_MOVED, trashCouldNot } from "../api/trashMessages";

function navigate(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function ListPage() {
  const [projections, setProjections] = useState<ProjectionListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  // The row the owner is confirming a trash for (null = no dialog open).
  const [pendingTrash, setPendingTrash] = useState<ProjectionListItem | null>(null);
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();

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

  async function confirmTrash() {
    if (!pendingTrash) return;
    const target = pendingTrash;
    setBusy(true);
    try {
      await trashProjection({ viewSlug: target.view_slug, version: target.version });
      // Optimistically drop the row from the active list.
      setProjections((rows) => rows.filter((r) => r.view_slug !== target.view_slug));
      showToast(TRASH_MOVED);
    } catch (err) {
      if (err instanceof LifecycleConflictError) {
        showToast(TRASH_CONFLICT);
      } else {
        showToast(trashCouldNot("move to Trash"));
      }
    } finally {
      setBusy(false);
      setPendingTrash(null);
    }
  }

  if (!loaded) {
    return (
      <section className="list-loading" aria-busy="true">
        <p>Loading your projections…</p>
      </section>
    );
  }

  return (
    <>
      <ProjectionsList
        projections={projections}
        onCreate={() => navigate("/wizard")}
        // v2 (L2): the entire row is the click target; always routes to the editable
        // detail (/p/<slug>/edit). No secret in the URL — the owner token in
        // localStorage authorizes the PATCH (ProjectionDetail's token fallback).
        onRowClick={(slug) => navigate(`/p/${slug}/edit`)}
        onTrash={(item) => setPendingTrash(item)}
        onOpenTrash={() => navigate("/trash")}
      />
      {pendingTrash && (
        <TrashConfirmDialog
          name={pendingTrash.name}
          busy={busy}
          onConfirm={confirmTrash}
          onClose={() => setPendingTrash(null)}
        />
      )}
    </>
  );
}

export default ListPage;

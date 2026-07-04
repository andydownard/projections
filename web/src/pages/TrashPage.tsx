// web/src/pages/TrashPage.tsx — the owner Trash view (API_SPEC §4.8).
//
// Lists this owner's SOFT-DELETED projections (GET /api/projections?trashed=true,
// owner-scoped — never global). Each row offers:
//   • Restore  → POST /restore (If-Match) → the projection returns to the list.
//   • Delete permanently → the STRONG type-to-confirm purge → DELETE /{slug}, which
//     erases the projection AND cascades to its revisions/narratives/transcripts
//     (#202). Irreversible, so it is gated behind ConfirmPurgeDialog (DESTRUCTIVE).
//
// No secret rides any URL; the owner token in localStorage authorizes every call.
import { useEffect, useState } from "react";

import {
  LifecycleConflictError,
  listTrashed,
  purgeProjection,
  restoreProjection,
  type ProjectionListItem,
} from "../api/projections";
import { ConfirmPurgeDialog } from "../components/ConfirmPurgeDialog";
import { useToast } from "../components/Toast";
import { formatListDate } from "../components/displayLabels";
import {
  TRASH_CONFLICT,
  TRASH_PURGED,
  TRASH_RESTORED,
  trashCouldNot,
} from "../api/trashMessages";

function navigate(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function TrashPage() {
  const [items, setItems] = useState<ProjectionListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pendingPurge, setPendingPurge] = useState<ProjectionListItem | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const { showToast } = useToast();

  useEffect(() => {
    let alive = true;
    listTrashed()
      .then((resp) => {
        if (alive) setItems(resp.projections);
      })
      .catch(() => {
        if (alive) setItems([]);
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  function drop(slug: string) {
    setItems((rows) => rows.filter((r) => r.view_slug !== slug));
  }

  function reportError(err: unknown, retryVerb: string) {
    if (err instanceof LifecycleConflictError) {
      showToast(TRASH_CONFLICT);
    } else {
      showToast(trashCouldNot(retryVerb));
    }
  }

  async function onRestore(item: ProjectionListItem) {
    setBusySlug(item.view_slug);
    try {
      await restoreProjection({ viewSlug: item.view_slug, version: item.version });
      drop(item.view_slug);
      showToast(TRASH_RESTORED);
    } catch (err) {
      reportError(err, "restore");
    } finally {
      setBusySlug(null);
    }
  }

  async function confirmPurge() {
    if (!pendingPurge) return;
    const target = pendingPurge;
    setBusySlug(target.view_slug);
    try {
      await purgeProjection({ viewSlug: target.view_slug, version: target.version });
      drop(target.view_slug);
      showToast(TRASH_PURGED);
    } catch (err) {
      reportError(err, "delete");
    } finally {
      setBusySlug(null);
      setPendingPurge(null);
    }
  }

  return (
    <section className="trash" aria-labelledby="trash-heading">
      <header className="list__header">
        <h1 id="trash-heading">Trash</h1>
        <a
          href="/"
          className="btn btn--ghost"
          data-testid="back-to-projections"
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            navigate("/");
          }}
        >
          Back to projections
        </a>
      </header>

      {!loaded ? (
        <p aria-busy="true">Loading Trash…</p>
      ) : items.length === 0 ? (
        <p data-testid="trash-empty">Trash is empty. Deleted projections appear here.</p>
      ) : (
        <>
          <p className="trash__note">
            These projections are hidden from your list. Restore one, or delete it
            permanently to erase all of its data. Permanent delete cannot be undone.
          </p>
          <table className="list__table">
            <thead>
              <tr>
                <th scope="col">Location</th>
                <th scope="col" className="num">Capital required</th>
                <th scope="col" aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.view_slug} data-testid={`trash-row-${p.view_slug}`}>
                  <td>
                    <div className="list__location">
                      <span className="list__name">{p.name}</span>
                      <span className="list__date">{formatListDate(p.updated_at)}</span>
                    </div>
                  </td>
                  <td className="num list__capital">{p.capital_required?.display ?? "—"}</td>
                  <td className="trash__actions">
                    <button
                      type="button"
                      className="btn"
                      data-testid={`restore-${p.view_slug}`}
                      disabled={busySlug === p.view_slug}
                      onClick={() => onRestore(p)}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger"
                      data-testid={`purge-${p.view_slug}`}
                      disabled={busySlug === p.view_slug}
                      onClick={() => setPendingPurge(p)}
                    >
                      Delete permanently
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {pendingPurge && (
        <ConfirmPurgeDialog
          name={pendingPurge.name}
          busy={busySlug === pendingPurge.view_slug}
          onConfirm={confirmPurge}
          onClose={() => setPendingPurge(null)}
        />
      )}
    </section>
  );
}

export default TrashPage;

// web/src/pages/RoleView.tsx — read-only role share link (/r/<slug>, M5).
//
// The verdict travels verbatim (M5-G3): the same decision banner + metrics a
// board/funder sees. Read-only — no editable affordance. Numbers are the
// server's stored snapshot.
//
// A bad/expired/removed slug 404s; the fetch rejects, so we render a load-failed
// DegradedState (not an infinite spinner — issue #146), the surface degrades but
// never crashes.
import { useEffect, useState } from "react";

import { fetchRoleView, type ViewModel } from "../api/viewModel";
import { DecisionBanner } from "../components/DecisionBanner";
import { DegradedState } from "../components/DegradedState";

export interface RoleViewProps {
  slug: string;
}

/** SPA-navigate home (the shell re-renders on popstate). */
function goHome() {
  window.history.pushState(null, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function RoleView({ slug }: RoleViewProps) {
  const [vm, setVm] = useState<ViewModel | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    void fetchRoleView(slug)
      .then((data) => {
        if (!cancelled) setVm(data);
      })
      .catch(() => {
        // 404 / network failure: degrade to a labelled error state, never spin.
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (loadError) {
    return (
      <div className="role-view">
        <DegradedState kind="load-failed" onAction={goHome} actionLabel="Go to home" />
      </div>
    );
  }

  if (!vm) return <div className="role-view role-view--loading">Loading…</div>;

  return (
    <div className="role-view" data-role={vm.role}>
      {/* Read-only notice (M7 I2): a shared link can read/download/export but not
          edit — announced politely (role="status"), meaning carried in text. */}
      <DegradedState kind="read-only" />
      <DecisionBanner reco={vm.reco} metrics={vm.metrics} milestones={vm.milestones} />
    </div>
  );
}

export default RoleView;

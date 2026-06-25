// web/src/pages/RoleView.tsx — read-only role share link (/r/<slug>, M5).
//
// The verdict travels verbatim (M5-G3): the same decision banner + metrics a
// board/funder sees. Read-only — no editable affordance. Numbers are the
// server's stored snapshot.
import { useEffect, useState } from "react";

import { fetchRoleView, type ViewModel } from "../api/viewModel";
import { DecisionBanner } from "../components/DecisionBanner";

export interface RoleViewProps {
  slug: string;
}

export function RoleView({ slug }: RoleViewProps) {
  const [vm, setVm] = useState<ViewModel | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchRoleView(slug).then((data) => {
      if (!cancelled) setVm(data);
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (!vm) return <div className="role-view role-view--loading">Loading…</div>;

  return (
    <div className="role-view" data-role={vm.role}>
      <DecisionBanner reco={vm.reco} metrics={vm.metrics} />
    </div>
  );
}

export default RoleView;

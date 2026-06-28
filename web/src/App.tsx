// web/src/App.tsx — the SPA shell + a tiny dependency-free path router (M2+).
//
// Persistent top bar (banner, product name, server-owned version chip) over the
// active route. The shell renders the server view-model; it computes NO
// projection math (PRD §13). Routes: / (home), /wizard, /p/<slug>[/edit],
// /r/<slug>.
import { useSyncExternalStore } from "react";

import { TopBar } from "./components/TopBar";
import { PennyGeneralAssistant } from "./components/PennyDrawer";
import { parseRoute, type Route } from "./router/route";
import { ListPage } from "./pages/ListPage";
import { CreateProjectionPage } from "./pages/CreateProjectionPage";
import { ProjectionDetail } from "./pages/ProjectionDetail";
import { RoleView } from "./pages/RoleView";
import { useDetailHeader } from "./state/detailHeader";
import "./tokens.css";

// Subscribe to history changes so the SPA re-renders on navigation without a
// router dependency.
function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
}
function getSnapshot() {
  return window.location.pathname + window.location.search;
}

/**
 * Whether the App shell should mount the GENERAL-help Penny on this route (#264,
 * Epic E #3). Penny must be openable on every primary route, but the wizard and the
 * detail EDIT page each mount their OWN context-aware Penny (draft-mode /
 * apply-and-narrate, with a token + view-model the shell does not have), so the shell
 * adds a general-help Penny only where a page has none: the home/list and the
 * read-only detail view. That general Penny offers help and never errors on a
 * projection-less route.
 */
export function appProvidesGeneralPenny(route: Route): boolean {
  if (route.kind === "home") return true;
  if (route.kind === "detail" && !route.edit) return true;
  return false;
}

export function App() {
  useSyncExternalStore(subscribe, getSnapshot);
  const route = parseRoute(window.location.pathname, window.location.search);

  // The save-state chip is DETAIL-PAGE-ONLY (DESIGN_PROMPT header anchor, #150).
  // The detail page publishes it to a tiny external store; the shell reads it here
  // and passes it to the single shared TopBar, gated on the detail route so the
  // chip never leaks onto home/wizard/role. The model_version is no longer shown
  // anywhere (#38) — it stays on computed_json; only the display is gone.
  const detailHeader = useDetailHeader();
  const isDetail = route.kind === "detail";

  // General-help Penny is openable on home + the read-only detail view; the wizard
  // and detail-edit pages mount their own (#264). With ?ai=off she degrades to the
  // muted Settings FAB (never a dead-end). Honor the per-route AI opt-out where the
  // route carries one (the detail view); home has none, so Penny is enabled there.
  const generalPenny = appProvidesGeneralPenny(route);
  const aiOff = route.kind === "detail" ? route.aiOff : false;

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <TopBar saveState={isDetail ? detailHeader.saveState : "idle"} />
      <main id="main" className="app__main" tabIndex={-1}>
        {route.kind === "home" && <ListPage />}
        {route.kind === "wizard" && (
          <CreateProjectionPage aiOff={route.aiOff} step={route.step} />
        )}
        {route.kind === "detail" && (
          <ProjectionDetail slug={route.slug} edit={route.edit} aiOff={route.aiOff} />
        )}
        {route.kind === "role" && <RoleView slug={route.slug} />}
        {route.kind === "notfound" && <section className="notfound">Not found</section>}
      </main>
      {generalPenny && <PennyGeneralAssistant aiEnabled={!aiOff} />}
    </div>
  );
}

export default App;

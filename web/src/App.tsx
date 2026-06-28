// web/src/App.tsx — the SPA shell + a tiny dependency-free path router (M2+).
//
// Persistent top bar (banner, product name, server-owned version chip) over the
// active route. The shell renders the server view-model; it computes NO
// projection math (PRD §13). Routes: / (home), /wizard, /p/<slug>[/edit],
// /r/<slug>.
import { useSyncExternalStore } from "react";

import { TopBar } from "./components/TopBar";
import { parseRoute } from "./router/route";
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

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <TopBar saveState={isDetail ? detailHeader.saveState : "idle"} />
      <main id="main" className="app__main" tabIndex={-1}>
        {route.kind === "home" && <ListPage />}
        {route.kind === "wizard" && <CreateProjectionPage aiOff={route.aiOff} />}
        {route.kind === "detail" && (
          <ProjectionDetail slug={route.slug} edit={route.edit} aiOff={route.aiOff} />
        )}
        {route.kind === "role" && <RoleView slug={route.slug} />}
        {route.kind === "notfound" && <section className="notfound">Not found</section>}
      </main>
    </div>
  );
}

export default App;

// web/src/router/route.ts — a tiny dependency-free path router + fragment scrub.
//
// The SPA renders by pathname (Vite dev / FastAPI both fall back to index.html).
// We avoid a router dependency: parseRoute maps a pathname to a typed Route.
//
// SECURITY (SECURITY.md §2.5 / CLAUDE.md): the edit/role secret arrives ONLY in
// the URL fragment (#edit-secret). readFragmentSecret reads it once and the
// caller scrubs it from the address bar so it never lands in history/logs.

import { isStepKey, type StepKey } from "../wizard/steps";

export type Route =
  | { kind: "home" }
  // Epic B (#261): each wizard step is its own route — /wizard/<step-slug>. `step`
  // is the recognized StepKey, or null for the bare /wizard or an UNKNOWN slug
  // (the caller redirects null to the first/furthest-valid step).
  | { kind: "wizard"; aiOff: boolean; step: StepKey | null }
  | { kind: "detail"; slug: string; edit: boolean; aiOff: boolean }
  | { kind: "role"; slug: string }
  // The owner Trash view: soft-deleted projections, restore / permanent delete.
  | { kind: "trash" }
  | { kind: "notfound" };

export function parseRoute(pathname: string, search = ""): Route {
  const aiOff = new URLSearchParams(search).get("ai") === "off";
  if (pathname === "/" || pathname === "") return { kind: "home" };
  if (pathname === "/trash" || pathname === "/trash/") return { kind: "trash" };
  // /wizard            -> wizard, no specific step (redirect to step 1)
  // /wizard/<slug>     -> wizard at that step (unknown slug -> step: null -> redirect)
  if (pathname === "/wizard" || pathname === "/wizard/") {
    return { kind: "wizard", aiOff, step: null };
  }
  const w = pathname.match(/^\/wizard\/([^/]+)\/?$/);
  if (w) {
    const slug = decodeURIComponent(w[1]);
    return { kind: "wizard", aiOff, step: isStepKey(slug) ? slug : null };
  }

  // /p/<slug>            -> read-only detail
  // /p/<slug>/edit       -> editable detail
  const p = pathname.match(/^\/p\/([^/]+)(\/edit)?\/?$/);
  if (p) {
    return { kind: "detail", slug: decodeURIComponent(p[1]), edit: !!p[2], aiOff };
  }
  // /r/<slug>            -> role share link
  const r = pathname.match(/^\/r\/([^/]+)\/?$/);
  if (r) return { kind: "role", slug: decodeURIComponent(r[1]) };

  return { kind: "notfound" };
}

/** The capability secret in the URL fragment (e.g. "#edit-secret" -> "edit-secret"). */
export function readFragmentSecret(hash: string): string | null {
  const raw = (hash || "").replace(/^#/, "").trim();
  return raw.length > 0 ? raw : null;
}

// web/src/router/route.ts — a tiny dependency-free path router + fragment scrub.
//
// The SPA renders by pathname (Vite dev / FastAPI both fall back to index.html).
// We avoid a router dependency: parseRoute maps a pathname to a typed Route.
//
// SECURITY (SECURITY.md §2.5 / CLAUDE.md): the edit/role secret arrives ONLY in
// the URL fragment (#edit-secret). readFragmentSecret reads it once and the
// caller scrubs it from the address bar so it never lands in history/logs.

export type Route =
  | { kind: "home" }
  | { kind: "wizard"; aiOff: boolean }
  | { kind: "detail"; slug: string; edit: boolean; aiOff: boolean }
  | { kind: "role"; slug: string }
  | { kind: "notfound" };

export function parseRoute(pathname: string, search = ""): Route {
  const aiOff = new URLSearchParams(search).get("ai") === "off";
  if (pathname === "/" || pathname === "") return { kind: "home" };
  if (pathname === "/wizard") return { kind: "wizard", aiOff };

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

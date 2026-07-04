// web/src/auth/signInRedirect.ts — the durable redirect target for a satellite
// sign-in round-trip (SIGNIN-4 / Epic #318 follow-up).
//
// Both sign-in buttons (the forced gate + the header control) bounce the owner to
// the PRIMARY (rallytasks.com) via clerk.buildSignInUrl({ redirectUrl }). Clerk
// appends __clerk_synced and carries this redirectUrl as the redirect_url so the
// primary returns the owner to THIS satellite after sign-in.
//
// We pass the current page WITHOUT its URL fragment:
//   - A fragment is never sent to a server and is meaningless as a redirect_url
//     target — the primary cannot act on it, so it is pure noise in the query.
//   - More importantly, edit / role share links carry their capability SECRET in
//     the fragment (e.g. /p/<slug>/edit#<edit-token>). Folding window.location.href
//     verbatim into redirect_url would copy that secret into a cross-apex query
//     string (and the primary's logs) — exactly the "secret in URL/query/log" leak
//     the capability-token model forbids (Regression #10 / Override SESSION). App
//     already scrubs the fragment before the gate mounts; stripping here is the
//     belt-and-braces guarantee so no caller can ever leak it.
//
// Dependency-free (imports nothing from @clerk/clerk-react) so it stays inert and
// tree-shake-safe on the ship-dark path and is trivially unit-testable.

/** The current page (origin + path + query) with any `#fragment` removed. */
export function signInRedirectTarget(): string {
  const href = window.location.href;
  const hashIndex = href.indexOf("#");
  return hashIndex === -1 ? href : href.slice(0, hashIndex);
}

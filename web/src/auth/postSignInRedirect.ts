// web/src/auth/postSignInRedirect.ts — capture-and-replay of a shared deep link
// across the Clerk sign-in round-trip (EPIC #323).
//
// A recipient who opens a share link "/p/<slug>/edit#<edit-token>" while signed out
// hits the forced owner gate. App captures the intended destination (the path, never
// the fragment secret) into sessionStorage BEFORE the gate shows. After sign-in the
// gate's SignedIn branch consumes it exactly ONCE (clearing it immediately) and
// navigates there if not already — so a recipient always lands on the shared
// projection even if the Clerk redirect dropped them on the home list, with no
// redirect loop.
//
// sessionStorage (not localStorage): the intent is scoped to this tab's sign-in
// round-trip and must not leak to other tabs or persist after it fires.

const KEY = "projections.post_signin_redirect";

/** Remember where to land after sign-in (a path + query, never the fragment). */
export function capturePostSignInRedirect(path: string): void {
  try {
    sessionStorage.setItem(KEY, path);
  } catch {
    // Private-mode / storage-disabled: degrade to no auto-redirect (Clerk's own
    // forceRedirectUrl still returns the recipient to the share link).
  }
}

/** Read-and-clear the captured destination (fires once); null when none. */
export function takePostSignInRedirect(): string | null {
  try {
    const dest = sessionStorage.getItem(KEY);
    if (dest) sessionStorage.removeItem(KEY);
    return dest;
  } catch {
    return null;
  }
}

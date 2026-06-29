// web/src/auth/ClaimLegacyOwnerToken.tsx — bridges a legacy capability owner token
// onto the signed-in Clerk identity (the claim/bridge effect).
//
// Mounted INSIDE the active <ClerkProvider> (alongside ClerkTokenBridge), so it is
// part of the Clerk code-split chunk and NEVER loads on the ship-dark path (no
// VITE_CLERK_PUBLISHABLE_KEY ⇒ ClerkAuthProvider is not imported ⇒ this is not
// imported). It imports @clerk/clerk-react only here, on the Clerk-active path.
//
// On the first signed-out→signed-in transition where a localStorage owner_token
// exists, it POSTs /api/projections/claim with the Clerk JWT bearer so the
// projections the owner created before signing in keep showing in their (now
// Clerk-keyed) list. Fires at most once per session (a ref guard). The owner_token
// is LEFT in localStorage afterward — a harmless fallback, never cleared.
import { useAuth } from "@clerk/clerk-react";
import { useEffect, useRef } from "react";

import { getOwnerToken } from "../api/projections";

export function ClaimLegacyOwnerToken() {
  const { isSignedIn, getToken } = useAuth();
  const fired = useRef(false);

  useEffect(() => {
    if (!isSignedIn || fired.current) return;
    const ownerToken = getOwnerToken();
    if (!ownerToken) return;
    // Guard BEFORE the async work so a re-render mid-flight can never double-fire.
    fired.current = true;
    void (async () => {
      try {
        const jwt = await getToken();
        if (!jwt) return;
        await fetch("/api/projections/claim", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ owner_token: ownerToken }),
        });
        // Keep ownerToken in localStorage — a harmless signed-out fallback. The claim
        // is idempotent server-side, so re-firing in a later session links 0 more.
      } catch {
        // Best-effort bridge: a failed claim leaves the capability path intact (the
        // owner_token still authorizes today's flow). Do not clear, do not retry.
      }
    })();
  }, [isSignedIn, getToken]);

  return null;
}

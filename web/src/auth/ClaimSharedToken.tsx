// web/src/auth/ClaimSharedToken.tsx — binds locally-held edit tokens to the signed-in
// Clerk account so editable shares FOLLOW the account (EPIC #323).
//
// Mirrors ClaimLegacyOwnerToken: mounted INSIDE the active <ClerkProvider> (alongside
// ClerkTokenBridge / ClaimLegacyOwnerToken), so it is part of the Clerk code-split
// chunk and NEVER loads on the ship-dark path. It imports @clerk/clerk-react only here.
//
// On the first signed-out→signed-in transition, it walks every locally-stored
// per-projection edit token (the ones a share link "/p/<slug>/edit#<token>" dropped
// into localStorage) and POSTs each (slug + token) to /api/projections/<slug>/claim-share
// with the Clerk JWT bearer. The server mints a share_grant on the recipient's Clerk
// sub ONLY when the token matches that slug's edit_token_hash — so a stale/foreign
// token simply 403s and is ignored. From then on the projection shows in the
// recipient's "Shared with me" list and they may edit it via their JWT on ANY device.
//
// Fires at most once per session (a ref guard). The edit tokens are LEFT in
// localStorage afterward — a harmless same-device fallback; the claim is idempotent
// server-side, so re-firing in a later session creates 0 new grants. The token rides
// the request BODY only — never a URL path/query/log (Regression #10).
import { useAuth } from "@clerk/clerk-react";
import { useEffect, useRef } from "react";

import { listEditTokenEntries } from "../api/projections";

export function ClaimSharedToken() {
  const { isSignedIn, getToken } = useAuth();
  const fired = useRef(false);

  useEffect(() => {
    if (!isSignedIn || fired.current) return;
    const entries = listEditTokenEntries();
    if (entries.length === 0) return;
    // Guard BEFORE the async work so a re-render mid-flight can never double-fire.
    fired.current = true;
    void (async () => {
      try {
        const jwt = await getToken();
        if (!jwt) return;
        await Promise.all(
          entries.map(({ viewSlug, token }) =>
            fetch(`/api/projections/${encodeURIComponent(viewSlug)}/claim-share`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${jwt}`,
              },
              body: JSON.stringify({ edit_token: token }),
            }).catch(() => {
              // Best-effort per token: a 403 (stale/foreign token) or transient
              // failure is ignored; the capability path still works on this device.
            }),
          ),
        );
      } catch {
        // Best-effort bridge: a failed claim leaves the capability path intact. Do
        // not clear the tokens, do not retry.
      }
    })();
  }, [isSignedIn, getToken]);

  return null;
}

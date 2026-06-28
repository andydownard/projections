// web/src/auth/ClerkTokenBridge.tsx — bridges Clerk's React-only getToken() out to
// the plain api-client modules.
//
// Mounted inside the active <ClerkProvider>, it registers useAuth().getToken with
// the clerkToken module so authHeader() can attach a short-lived Clerk session JWT
// as Authorization: Bearer for owner calls. Renders nothing; unregisters on
// unmount so a torn-down provider never leaves a stale getter behind.
import { useAuth } from "@clerk/clerk-react";
import { useEffect } from "react";

import { setClerkTokenGetter } from "./clerkToken";

export function ClerkTokenBridge() {
  const { getToken } = useAuth();
  useEffect(() => {
    setClerkTokenGetter(() => getToken());
    return () => setClerkTokenGetter(null);
  }, [getToken]);
  return null;
}

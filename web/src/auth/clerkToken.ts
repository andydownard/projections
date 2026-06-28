// web/src/auth/clerkToken.ts — the React↔plain-module bridge for the Clerk session token.
//
// Clerk's getToken() is reachable only from React (useAuth). The api-client
// modules are plain async functions, so the in-tree <ClerkTokenBridge> registers
// the getter here and the single authHeader() helper (api/authHeader.ts) reads it.
// clerkActive() gates everything on the build-time publishable key: with Clerk OFF
// (no VITE_CLERK_PUBLISHABLE_KEY) the owner-token path is byte-for-byte today.
//
// SHIP-DARK invariant: this module imports NOTHING from @clerk/clerk-react, so it
// is inert (and tree-shake-safe) when the satellite is off.

type TokenGetter = () => Promise<string | null>;

let getter: TokenGetter | null = null;

/** Register (or, with null, unregister) the Clerk session-token getter. */
export function setClerkTokenGetter(next: TokenGetter | null): void {
  getter = next;
}

/** True only when the build was given a Clerk publishable key (satellite on). */
export function clerkActive(): boolean {
  return Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
}

/**
 * The current short-lived Clerk session JWT, or null when signed out / Clerk off.
 * Never throws — a failing getToken() resolves to null so the owner-token path
 * can take over (fail-open to the existing capability flow, never a hard error).
 */
export async function getClerkToken(): Promise<string | null> {
  if (!getter) return null;
  try {
    return await getter();
  } catch {
    return null;
  }
}

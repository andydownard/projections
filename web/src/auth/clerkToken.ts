// web/src/auth/clerkToken.ts — the React↔plain-module bridge for the Clerk session
// token, AND the single source of truth for "is Clerk active right now."
//
// Clerk's getToken() is reachable only from React (useAuth). The api-client
// modules are plain async functions, so the in-tree <ClerkTokenBridge> registers
// the getter here and the single authHeader() helper (api/authHeader.ts) reads it.
//
// clerkActive() is imported by every consumer that needs to know whether Clerk is
// on (App.tsx, TopBar.tsx, authHeader.ts, ProjectionDetail.tsx, RootProviders.tsx)
// — DELIBERATELY ONE function, not one per call site. This app is served from TWO
// public domains by the same build (projections.rallytasks.com, the Clerk-enabled
// home, and projections.thriftly.com, left Clerk-free after its old cross-apex
// satellite CNAME hung and caused a full-site outage, 2026-10-02), so key-presence
// ALONE is not enough — a build with the key set serves both domains, and every
// consumer must agree on the SAME host check or a consumer that skips it can mount
// Clerk UI with no <ClerkProvider> ancestor (because another consumer correctly
// refused to mount the provider for this host) and hang/crash instead of
// gracefully falling back to the no-Clerk path. (This happened once already,
// 2026-10-03, when only the provider's mount point was host-gated and a second,
// independent consumer — App.tsx's ClerkOwnerGate — was not; fixed by
// consolidating every check onto this one function.)
//
// SHIP-DARK invariant: this module imports NOTHING from @clerk/clerk-react, so it
// is inert (and tree-shake-safe) when Clerk is off.

type TokenGetter = () => Promise<string | null>;

let getter: TokenGetter | null = null;

/** Register (or, with null, unregister) the Clerk session-token getter. */
export function setClerkTokenGetter(next: TokenGetter | null): void {
  getter = next;
}

// Exact-match or proper-subdomain match only (never a naive substring check —
// "notprojections.rallytasks.com.evil.com" must NOT match "rallytasks.com").
// "localhost" covers local dev AND is jsdom's default test hostname, so existing
// tests that stub only the publishable key (no hostname) keep working unchanged.
const CLERK_ALLOWED_HOSTS = ["projections.rallytasks.com", "localhost", "127.0.0.1"];

function hostMatches(hostname: string, allowed: string): boolean {
  return hostname === allowed || hostname.endsWith(`.${allowed}`);
}

/** Whether the given hostname (default: the real one) is on the Clerk allowlist. */
export function clerkEnabledForHost(
  hostname: string = typeof window !== "undefined" ? window.location.hostname : "",
): boolean {
  return CLERK_ALLOWED_HOSTS.some((allowed) => hostMatches(hostname, allowed));
}

/** True only when the build has a Clerk publishable key AND the host allows it. */
export function clerkActive(): boolean {
  return Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) && clerkEnabledForHost();
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

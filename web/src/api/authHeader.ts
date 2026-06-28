// web/src/api/authHeader.ts — the single owner auth-header helper (both paths).
//
// When the Clerk satellite is active AND the owner is signed in, owner-scoped
// calls carry a short-lived Clerk session JWT (await getToken()) as
// Authorization: Bearer. Otherwise they carry the existing capability owner token
// from localStorage. With Clerk OFF (no VITE_CLERK_PUBLISHABLE_KEY) the Clerk
// branch is skipped entirely, so the behaviour is byte-for-byte the
// capability-token app of today (ship dark).
//
// Scope: this is the OWNER path only. Viewers' capability secrets (view_slug, the
// role/edit fragment tokens) never flow through here — they stay no-login.

import { clerkActive, getClerkToken } from "../auth/clerkToken";
import { getOwnerToken } from "./projections";

/**
 * Resolve the owner Authorization header. Prefers a Clerk session JWT (when the
 * satellite is on and the owner is signed in); falls back to the localStorage
 * owner token; returns {} when there is no owner identity at all.
 */
export async function authHeader(): Promise<Record<string, string>> {
  if (clerkActive()) {
    const clerkToken = await getClerkToken();
    if (clerkToken) return { Authorization: `Bearer ${clerkToken}` };
  }
  const owner = getOwnerToken();
  if (owner) return { Authorization: `Bearer ${owner}` };
  return {};
}

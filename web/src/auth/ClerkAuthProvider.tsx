// web/src/auth/ClerkAuthProvider.tsx — the Clerk provider for projections.rallytasks.com.
//
// projections.rallytasks.com shares the SAME apex as the Clerk primary
// (rallytasks.com) — Clerk shares sessions across same-apex subdomains
// automatically (confirmed against Clerk's own docs, 2026-10-02), so this needs
// NONE of the cross-apex satellite machinery the old projections.thriftly.com
// integration required (isSatellite / domain / signInUrl / allowedRedirectOrigins
// / forced post-sign-in redirects). That cross-apex setup — routing through a
// custom clerk.thriftly.com CNAME — is what hung and caused a full-site outage
// (2026-10-02); dropping it here is a deliberate simplification, not an oversight.
//
// This is the ONLY module that imports @clerk/clerk-react at the top level, and it
// is lazy-loaded by RootProviders so the import runs ONLY when
// VITE_CLERK_PUBLISHABLE_KEY is set AND the host is on the Clerk-enabled allowlist
// (see auth/clerkToken.ts's clerkActive/clerkEnabledForHost — projections.thriftly.com must never
// re-gain Clerk from this same build).
import { ClerkProvider } from "@clerk/clerk-react";
import type { ReactNode } from "react";

import { ClaimLegacyOwnerToken } from "./ClaimLegacyOwnerToken";
import { ClaimSharedToken } from "./ClaimSharedToken";
import { ClerkTokenBridge } from "./ClerkTokenBridge";

export default function ClerkAuthProvider({
  publishableKey,
  children,
}: {
  publishableKey: string;
  children: ReactNode;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ClerkTokenBridge />
      <ClaimLegacyOwnerToken />
      <ClaimSharedToken />
      {children}
    </ClerkProvider>
  );
}

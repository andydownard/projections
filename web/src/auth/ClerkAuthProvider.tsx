// web/src/auth/ClerkAuthProvider.tsx — the cross-apex Clerk SATELLITE provider.
//
// projections.thriftly.com is a Clerk satellite of the rallytasks.com primary (a
// DIFFERENT apex). This is the ONLY module that imports @clerk/clerk-react at the
// top level, and it is lazy-loaded by RootProviders so the Clerk import path runs
// ONLY when VITE_CLERK_PUBLISHABLE_KEY is set (ship dark: with no key, this file
// is code-split out of the booted path entirely).
//
// Plan §2C.2: isSatellite + domain + signInUrl on the satellite provider. We do
// NOT enable auto-sync — clerk-react v5 has no satelliteAutoSync prop, and its
// default (no auto first-visit redirect) IS the intended "satelliteAutoSync=false"
// behaviour: the owner signs in explicitly on the PRIMARY (buildSignInUrl, see
// OwnerAuthControls) and is redirected back here. No passkeys (cross-apex,
// shared-dashboard setting).
import { ClerkProvider } from "@clerk/clerk-react";
import type { ReactNode } from "react";

import { ClaimLegacyOwnerToken } from "./ClaimLegacyOwnerToken";
import { ClerkTokenBridge } from "./ClerkTokenBridge";

// Defaults track the satellite host / primary sign-in; prod overrides via env.
const DEFAULT_DOMAIN = "thriftly.com";
const DEFAULT_SIGN_IN_URL = "https://rallytasks.com/sign-in";

// Where the primary returns the owner AFTER sign-in (SIGNIN-4). The magic-link /
// OAuth completion must land back on THIS satellite, not the primary. Defaults to
// this origin; prod can override via env. This is the provider-level fallback; the
// sign-in buttons ALSO pass an explicit redirectUrl = the current page.
function signInRedirectUrl(): string {
  const override = import.meta.env.VITE_CLERK_AFTER_SIGN_IN_URL;
  if (override) return override;
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "https://projections.thriftly.com";
}

function allowedRedirectOrigins(): string[] {
  const csv = import.meta.env.VITE_ALLOWED_REDIRECT_ORIGINS;
  if (csv) {
    return csv
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
  }
  // Default to this satellite's own origin (where the primary bounces back).
  if (typeof window !== "undefined" && window.location?.origin) {
    return [window.location.origin];
  }
  return ["https://projections.thriftly.com"];
}

export default function ClerkAuthProvider({
  publishableKey,
  children,
}: {
  publishableKey: string;
  children: ReactNode;
}) {
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      isSatellite
      domain={import.meta.env.VITE_CLERK_DOMAIN || DEFAULT_DOMAIN}
      signInUrl={import.meta.env.VITE_CLERK_SIGN_IN_URL || DEFAULT_SIGN_IN_URL}
      allowedRedirectOrigins={allowedRedirectOrigins()}
      // SIGNIN-4: force the post-sign-in landing back onto this satellite so the
      // magic-link round-trip returns here (not the primary). `forceRedirectUrl`
      // is the v5 prop; `afterSignInUrl` is kept for back-compat.
      signInForceRedirectUrl={signInRedirectUrl()}
      afterSignInUrl={signInRedirectUrl()}
    >
      <ClerkTokenBridge />
      <ClaimLegacyOwnerToken />
      {children}
    </ClerkProvider>
  );
}

// web/src/RootProviders.tsx — the app's provider shell + the Clerk gate.
//
// Clerk is OFF by default. When VITE_CLERK_PUBLISHABLE_KEY is unset, RootProviders
// renders the app EXACTLY as today (StrictMode + TanStack Query) and the Clerk
// import path is NEVER executed — ClerkAuthProvider is lazy-loaded, so
// @clerk/clerk-react is code-split out of the booted path.
//
// This app is served from TWO public domains by the same build:
// projections.rallytasks.com (the new Clerk-enabled home — same apex as the Clerk
// primary, so no satellite/cross-apex config is needed at all, see
// ClerkAuthProvider.tsx) and projections.thriftly.com (left exactly as the
// no-Clerk stopgap it was fixed to be, 2026-10-02 — its old cross-apex satellite
// CNAME, clerk.thriftly.com, was the cause of a full-site outage: ClerkOwnerGate
// blocked the whole app behind a Clerk script load that hung forever).
//
// A single Vite build bakes in one global VITE_CLERK_PUBLISHABLE_KEY for every
// visitor regardless of which domain they're on, so key-presence ALONE is not
// enough to gate Clerk — it must also be paired with a runtime hostname check,
// or enabling Clerk for the new domain would silently re-enable it on
// thriftly.com too and risk recreating the exact outage this just fixed.
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense, type ReactNode } from "react";

import { ToastProvider } from "./components/Toast";

// lazy(() => import(...)) does NOT execute the import until the component renders,
// so the dark path (no key, or a disallowed host) never touches Clerk.
const ClerkAuthProvider = lazy(() => import("./auth/ClerkAuthProvider"));

/** The build-time Clerk publishable key, or undefined when Clerk is off. */
export function clerkPublishableKey(): string | undefined {
  return import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || undefined;
}

// Exact-match or proper-subdomain match only (never a naive substring check —
// "notprojections.rallytasks.com.evil.com" must NOT match "rallytasks.com").
const CLERK_ALLOWED_HOSTS = ["projections.rallytasks.com", "localhost", "127.0.0.1"];

function hostMatches(hostname: string, allowed: string): boolean {
  return hostname === allowed || hostname.endsWith(`.${allowed}`);
}

/** Whether Clerk should mount for the given hostname (defaults to the real one). */
export function clerkEnabledForHost(
  hostname: string = typeof window !== "undefined" ? window.location.hostname : "",
): boolean {
  return CLERK_ALLOWED_HOSTS.some((allowed) => hostMatches(hostname, allowed));
}

export function RootProviders({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: ReactNode;
}) {
  const publishableKey = clerkPublishableKey();
  const clerkActive = Boolean(publishableKey) && clerkEnabledForHost();
  const tree = <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

  // ToastProvider wraps the outermost tree so any page — wizard, detail, list —
  // can call useToast() to surface success messages (app-suggestion, terms accept).
  // It sits outside QueryClientProvider so it doesn't depend on the query client
  // and is never unmounted by a query boundary reset.
  return (
    <StrictMode>
      <ToastProvider>
        {clerkActive && publishableKey ? (
          <Suspense fallback={null}>
            <ClerkAuthProvider publishableKey={publishableKey}>{tree}</ClerkAuthProvider>
          </Suspense>
        ) : (
          tree
        )}
      </ToastProvider>
    </StrictMode>
  );
}

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
// CNAME, clerk.thriftly.com, was the cause of a full-site outage).
//
// The mount gate below uses clerkActive() from auth/clerkToken.ts — the SAME
// single source of truth every other Clerk-aware consumer (App.tsx, TopBar.tsx,
// authHeader.ts, ProjectionDetail.tsx) already imports. It is NOT reimplemented
// here: a second, independent "is Clerk on" check that only this file knew about
// once caused exactly the bug this consolidation prevents — App.tsx's
// ClerkOwnerGate stayed key-only-gated while this file alone learned the
// hostname rule, so ClerkOwnerGate mounted with no <ClerkProvider> ancestor on a
// disallowed host and hung the page (2026-10-03).
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense, type ReactNode } from "react";

import { clerkActive } from "./auth/clerkToken";
import { ToastProvider } from "./components/Toast";

// lazy(() => import(...)) does NOT execute the import until the component renders,
// so the dark path (no key, or a disallowed host) never touches Clerk.
const ClerkAuthProvider = lazy(() => import("./auth/ClerkAuthProvider"));

/** The build-time Clerk publishable key, or undefined when Clerk is off. */
export function clerkPublishableKey(): string | undefined {
  return import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || undefined;
}

export function RootProviders({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: ReactNode;
}) {
  const publishableKey = clerkPublishableKey();
  const tree = <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

  // ToastProvider wraps the outermost tree so any page — wizard, detail, list —
  // can call useToast() to surface success messages (app-suggestion, terms accept).
  // It sits outside QueryClientProvider so it doesn't depend on the query client
  // and is never unmounted by a query boundary reset.
  return (
    <StrictMode>
      <ToastProvider>
        {clerkActive() && publishableKey ? (
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

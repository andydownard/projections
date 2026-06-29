// web/src/RootProviders.tsx — the app's provider shell + the SHIP-DARK Clerk gate.
//
// The Clerk satellite is OFF by default. When VITE_CLERK_PUBLISHABLE_KEY is unset,
// RootProviders renders the app EXACTLY as today (StrictMode + TanStack Query) and
// the Clerk import path is NEVER executed — ClerkAuthProvider is lazy-loaded, so
// @clerk/clerk-react is code-split out of the booted path. When the key is set, the
// app is wrapped in the cross-apex satellite <ClerkProvider> (ClerkAuthProvider).
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense, type ReactNode } from "react";

import { ToastProvider } from "./components/Toast";

// lazy(() => import(...)) does NOT execute the import until the component renders,
// so the dark path (no key) never touches Clerk.
const ClerkAuthProvider = lazy(() => import("./auth/ClerkAuthProvider"));

/** The build-time Clerk publishable key, or undefined when the satellite is off. */
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
        {publishableKey ? (
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

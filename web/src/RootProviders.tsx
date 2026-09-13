// web/src/RootProviders.tsx — the app's provider shell.
//
// This project has no authentication (owner decision, 2026-09-13).
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";

import { ToastProvider } from "./components/Toast";

export function RootProviders({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: ReactNode;
}) {
  // ToastProvider wraps the outermost tree so any page — wizard, detail, list —
  // can call useToast() to surface success messages (app-suggestion, terms accept).
  // It sits outside QueryClientProvider so it doesn't depend on the query client
  // and is never unmounted by a query boundary reset.
  return (
    <StrictMode>
      <ToastProvider>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </ToastProvider>
    </StrictMode>
  );
}

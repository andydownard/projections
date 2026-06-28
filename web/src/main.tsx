import { QueryClient } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { RootProviders } from "./RootProviders";

// TanStack Query holds the server-owned computed_json cache (keyed by view_slug).
const queryClient = new QueryClient();

// RootProviders wraps the app in the Clerk satellite <ClerkProvider> ONLY when
// VITE_CLERK_PUBLISHABLE_KEY is set (ship dark); with no key it renders the app
// exactly as today and never executes the Clerk import path.
createRoot(document.getElementById("root")!).render(
  <RootProviders queryClient={queryClient}>
    <App />
  </RootProviders>,
);

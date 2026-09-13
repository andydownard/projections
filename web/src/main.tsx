import { QueryClient } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { RootProviders } from "./RootProviders";

// TanStack Query holds the server-owned computed_json cache (keyed by view_slug).
const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <RootProviders queryClient={queryClient}>
    <App />
  </RootProviders>,
);

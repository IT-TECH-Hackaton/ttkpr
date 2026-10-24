import { registerSW } from "virtual:pwa-register";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./lib/maplibre";
import { router } from "./router";
import "./styles.css";

const queryClient = new QueryClient({
  // "always": offline, queries still run and are answered from saved copies.
  defaultOptions: { queries: { staleTime: 60_000, retry: 1, networkMode: "always" } },
});

// The page itself comes from the service worker's copy of the app. When a deploy brings a new
// version, the new worker takes over and the page reloads once — nobody stays on an old build.
registerSW({ immediate: true });

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

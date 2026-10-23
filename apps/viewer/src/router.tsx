import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { Landing } from "./screens/Landing";
import { MapScreen } from "./screens/MapScreen";

export interface MapSearch {
  level?: string;
  poi?: string;
  pano?: string;
}

const rootRoute = createRootRoute({ component: Outlet });

const landingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Landing,
});

export const mapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/m/$slug",
  validateSearch: (search: Record<string, unknown>): MapSearch => ({
    level: typeof search.level === "string" ? search.level : undefined,
    poi: typeof search.poi === "string" ? search.poi : undefined,
    pano: typeof search.pano === "string" ? search.pano : undefined,
  }),
  component: MapScreen,
});

const routeTree = rootRoute.addChildren([landingRoute, mapRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

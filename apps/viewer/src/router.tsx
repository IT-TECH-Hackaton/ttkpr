import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { Landing } from "./screens/Landing";
import { MapScreen } from "./screens/MapScreen";

export interface MapSearch {
  level?: string;
  poi?: string;
  pano?: string;
  /** Route ends: a POI id or "@lon,lat,levelId". */
  from?: string;
  to?: string;
  /** Route without stairs and escalators. */
  acc?: boolean;
  /** "Вы здесь": the POI a QR sign at the venue points to. */
  here?: string;
  /** Walking the route through panoramas: index of the current one. */
  walk?: number;
}

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

const rootRoute = createRootRoute({ component: Outlet });

const landingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Landing,
});

export const mapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/m/$slug",
  validateSearch: (search: Record<string, unknown>): MapSearch => {
    const walk = Number(search.walk);
    return {
      level: str(search.level),
      poi: str(search.poi),
      pano: str(search.pano),
      from: str(search.from),
      to: str(search.to),
      acc: search.acc === true || search.acc === "true" || search.acc === "1" ? true : undefined,
      here: str(search.here),
      walk: search.walk !== undefined && Number.isInteger(walk) && walk >= 0 ? walk : undefined,
    };
  },
  component: MapScreen,
});

const routeTree = rootRoute.addChildren([landingRoute, mapRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

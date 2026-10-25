import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
} from "@tanstack/react-router";
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
  /** An organizer's prepared route (tour id). */
  tour?: string;
  /** Studio preview: the current draft instead of the published version (team only). */
  preview?: true;
}

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
// The router JSON-parses query values: "?acc=1" arrives as the number 1.
const flag = (value: unknown) =>
  value === true || value === 1 || value === "true" || value === "1" ? true : undefined;

const rootRoute = createRootRoute({ component: Outlet });

const landingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // Its own chunk: a shared map link (/m/…) never downloads the landing page.
  component: lazyRouteComponent(() => import("./screens/Landing"), "Landing"),
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
      acc: flag(search.acc),
      here: str(search.here),
      tour: str(search.tour),
      preview: flag(search.preview),
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

import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { me } from "@ttkpr/api-client";
import { ApiError, unwrap } from "./lib/api";
import { STUDIO_BASE } from "./lib/links";
import { meQueryKey } from "./lib/session";
import { AuthScreen } from "./screens/Auth";
import { CaptureScreen } from "./screens/Capture";
import { EditorScreen } from "./screens/Editor";
import { InviteScreen } from "./screens/Invite";
import { MapsScreen } from "./screens/Maps";
import { ProfileScreen } from "./screens/Profile";
import { ShareScreen } from "./screens/Share";
import { StatsScreen } from "./screens/Stats";
import { TeamScreen } from "./screens/Team";

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

async function currentUser(queryClient: QueryClient) {
  return queryClient.ensureQueryData({
    queryKey: meQueryKey,
    queryFn: async () => {
      try {
        return await unwrap(me());
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
}

/** Organizer-only pages: no session -> login, then back to where the user was going. */
const authed = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  beforeLoad: async ({ context, location }) => {
    if (!(await currentUser(context.queryClient))) {
      throw redirect({ to: "/login", search: { next: location.href } });
    }
  },
  component: Outlet,
});

const validateNext = (search: Record<string, unknown>) => ({
  next: typeof search.next === "string" ? search.next : undefined,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: validateNext,
  component: function Login() {
    const { next } = loginRoute.useSearch();
    return <AuthScreen mode="login" next={next} />;
  },
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  validateSearch: validateNext,
  component: function Register() {
    const { next } = registerRoute.useSearch();
    return <AuthScreen mode="register" next={next} />;
  },
});

const mapsRoute = createRoute({
  getParentRoute: () => authed,
  path: "/",
  component: function Maps() {
    // "?create=true" (from the editor menu) opens the new-map dialog right away.
    return <MapsScreen startCreating={new URLSearchParams(location.search).has("create")} />;
  },
});

const profileRoute = createRoute({
  getParentRoute: () => authed,
  path: "/profile",
  component: ProfileScreen,
});

const teamRoute = createRoute({
  getParentRoute: () => authed,
  path: "/maps/$mapId/team",
  component: function Team() {
    const { mapId } = teamRoute.useParams();
    return <TeamScreen mapId={mapId} />;
  },
});

const statsRoute = createRoute({
  getParentRoute: () => authed,
  path: "/maps/$mapId/stats",
  component: function Stats() {
    const { mapId } = statsRoute.useParams();
    return <StatsScreen mapId={mapId} />;
  },
});

/** Invite links: /invite#t=…; works signed out (asks to sign in first). */
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite",
  component: InviteScreen,
});

const editorRoute = createRoute({
  getParentRoute: () => authed,
  path: "/maps/$mapId",
  component: function Editor() {
    const { mapId } = editorRoute.useParams();
    return <EditorScreen key={mapId} mapId={mapId} />;
  },
});

const shareRoute = createRoute({
  getParentRoute: () => authed,
  path: "/maps/$mapId/share",
  component: function Share() {
    const { mapId } = shareRoute.useParams();
    return <ShareScreen mapId={mapId} />;
  },
});

/** Opened on the phone from the QR code; authorised by the token in the URL fragment. */
const captureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/capture/$mapId",
  component: function Capture() {
    const { mapId } = captureRoute.useParams();
    return <CaptureScreen mapId={mapId} />;
  },
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  registerRoute,
  captureRoute,
  inviteRoute,
  authed.addChildren([mapsRoute, profileRoute, editorRoute, shareRoute, teamRoute, statsRoute]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, basepath: STUDIO_BASE });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

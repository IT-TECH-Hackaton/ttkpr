/// <reference lib="webworker" />
// Service worker of the visitor app (vite-plugin-pwa, injectManifest).
//
// Two kinds of map data in the caches:
// - OFFLINE_CACHE: maps the visitor explicitly saved ("Сохранить офлайн"), written by the page
//   (src/lib/offline.ts) and never expired;
// - runtime caches: whatever was viewed, bounded and expiring.
// Saved copies always win, so a saved map opens identically with or without the network.

import type { RouteHandlerCallbackOptions } from "workbox-core/types";
import { ExpirationPlugin } from "workbox-expiration";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from "workbox-strategies";
import { OFFLINE_CACHE } from "./lib/offline-constants";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
void self.skipWaiting();
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// App routes (/m/{slug}) work offline through the precached shell. The studio shares the origin
// (/studio/) but is not part of this app.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//, /^\/media\//, /^\/studio(\/|$)/],
  }),
);

async function saved(request: Request): Promise<Response | undefined> {
  return (await caches.open(OFFLINE_CACHE)).match(request);
}

const isManifest = ({ url }: { url: URL }) => url.pathname.endsWith("/manifest.json");
const isImmutable = ({ url }: { url: URL }) =>
  url.pathname.startsWith("/media/") ||
  /\/api\/public\/maps\/[^/]+\/v\/\d+\/bundle\.json$/.test(url.pathname) ||
  /^\/demo\/(v\d+|pano-[^/]+)\//.test(url.pathname);
const isGlyph = ({ url }: { url: URL }) => url.pathname.endsWith(".pbf");

const manifests = new NetworkFirst({ cacheName: "map-manifests", networkTimeoutSeconds: 3 });
const immutable = new CacheFirst({
  cacheName: "map-runtime",
  plugins: [new ExpirationPlugin({ maxEntries: 1500, maxAgeSeconds: 60 * 60 * 24 * 30 })],
});
const glyphs = new StaleWhileRevalidate({ cacheName: "map-glyphs" });

// Manifest: the network decides which version is current; offline, the saved one.
registerRoute(isManifest, async (options: RouteHandlerCallbackOptions) => {
  try {
    return await manifests.handle(options);
  } catch (error) {
    const copy = await saved(options.request as Request);
    if (copy) return copy;
    throw error;
  }
});

registerRoute(isImmutable, async (options: RouteHandlerCallbackOptions) => {
  return (await saved(options.request as Request)) ?? immutable.handle(options);
});

registerRoute(isGlyph, async (options: RouteHandlerCallbackOptions) => {
  return (await saved(options.request as Request)) ?? glyphs.handle(options);
});

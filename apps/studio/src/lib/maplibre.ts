// MapLibre v6 looks for its worker next to its own module URL, which Vite rewrites.
// Bundle the worker explicitly and point MapLibre at it (dev and production alike).
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);

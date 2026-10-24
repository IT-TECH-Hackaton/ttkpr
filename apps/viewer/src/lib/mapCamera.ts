import type { Map as MapLibreMap } from "maplibre-gl";

// The visitor map registers itself so the zoom buttons can reach the current view.
let current: MapLibreMap | null = null;

export function registerMap(map: MapLibreMap | null) {
  current = map;
}

export const zoomIn = () => current?.zoomIn();
export const zoomOut = () => current?.zoomOut();

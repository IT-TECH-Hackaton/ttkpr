import { fromLocal, type LonLat, toLocal } from "@ttkpr/map-core";
import type { Map as MapLibreMap } from "maplibre-gl";
import { formatGridSize, gridCellMeters } from "./grid";
import { metersPerPixel } from "./snap";

// The editor map registers itself so panels can place things relative to the current view.
let current: MapLibreMap | null = null;
const viewListeners = new Set<() => void>();

export function registerMap(map: MapLibreMap | null) {
  current = map;
  notifyView();
}

/** Fired when the editor map pans or zooms, and when it is created or destroyed. */
export function notifyView() {
  for (const listener of viewListeners) listener();
}

export function subscribeView(listener: () => void): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

/** Side of the background square at the current zoom, before the map exists — null. */
export function gridSizeLabel(): string | null {
  if (!current) return null;
  const center = current.getCenter();
  return formatGridSize(gridCellMeters(metersPerPixel(center.lat, current.getZoom())));
}

/** Zoom controls of the editor chrome. */
export const zoomIn = () => current?.zoomIn();
export const zoomOut = () => current?.zoomOut();
export function fitTo(bounds: [[number, number], [number, number]] | null, fallback: LonLat) {
  if (!current) return;
  if (bounds) current.fitBounds(bounds, { padding: 80, duration: 400 });
  else current.easeTo({ center: fallback, zoom: 18.5 });
}

export function viewCenter(): LonLat | null {
  const c = current?.getCenter();
  return c ? [c.lng, c.lat] : null;
}

/** Visible width of the map in meters around the centre. */
export function viewWidthMeters(anchor: LonLat): number | null {
  if (!current) return null;
  const b = current.getBounds();
  const [x1] = toLocal(anchor, [b.getWest(), b.getCenter().lat]);
  const [x2] = toLocal(anchor, [b.getEast(), b.getCenter().lat]);
  return Math.abs(x2 - x1);
}

export interface Placement {
  center: LonLat;
  widthM: number;
  heightM: number;
  rotationDeg: number;
}

export type Corners = [LonLat, LonLat, LonLat, LonLat];

/** Corners (TL, TR, BR, BL) of a rectangle placed in local meters. */
export function placementCorners(anchor: LonLat, p: Placement): Corners {
  const [cx, cy] = toLocal(anchor, p.center);
  const t = (p.rotationDeg * Math.PI) / 180;
  const corner = (dx: number, dy: number): LonLat => {
    // Clockwise rotation (as seen on a north-up map).
    const x = cx + dx * Math.cos(t) + dy * Math.sin(t);
    const y = cy - dx * Math.sin(t) + dy * Math.cos(t);
    return fromLocal(anchor, [x, y]);
  };
  const w = p.widthM / 2;
  const h = p.heightM / 2;
  return [corner(-w, h), corner(w, h), corner(w, -h), corner(-w, -h)];
}

export function cornersPlacement(anchor: LonLat, corners: LonLat[]): Placement {
  const pts = corners.map((c) => toLocal(anchor, c));
  const [tl = [0, 0], tr = [1, 0], , bl = [0, -1]] = pts;
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return {
    center: fromLocal(anchor, [cx, cy]),
    widthM: Math.hypot(tr[0] - tl[0], tr[1] - tl[1]),
    heightM: Math.hypot(bl[0] - tl[0], bl[1] - tl[1]),
    rotationDeg: (-Math.atan2(tr[1] - tl[1], tr[0] - tl[0]) * 180) / Math.PI,
  };
}

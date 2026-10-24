// Snapping for fast plan drawing: corners stick to existing room corners, then to walls,
// then to a grid. Doors land on the nearest wall, aligned with it. All maths in local meters.

import type { MapDocument } from "@ttkpr/api-client";
import { fromLocal, type LonLat, toLocal, type XY } from "@ttkpr/map-core";

export type SnapKind = "vertex" | "edge" | "grid" | "free";

export interface Snapped {
  position: LonLat;
  kind: SnapKind;
}

export interface SnapOptions {
  levelId: string;
  /** Search radius in meters (usually ~12 screen pixels converted at the current zoom). */
  toleranceM: number;
  /** Grid step in meters; 0 disables the grid. */
  gridM: number;
}

type Segment = [XY, XY];

/** Meters per CSS pixel at a latitude and MapLibre zoom (512 px tiles, not 256). */
export function metersPerPixel(lat: number, zoom: number): number {
  return (78271.51696 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

function levelRings(doc: MapDocument, levelId: string): XY[][] {
  const anchor = doc.venue.anchor;
  return (doc.units ?? [])
    .filter((u) => u.levelId === levelId)
    .map((u) => (u.geometry.coordinates[0] ?? []).map((c) => toLocal(anchor, c as LonLat)));
}

function segments(rings: XY[][]): Segment[] {
  const result: Segment[] = [];
  for (const ring of rings) {
    for (let i = 0; i + 1 < ring.length; i++) result.push([ring[i] as XY, ring[i + 1] as XY]);
  }
  return result;
}

function closestOnSegment(p: XY, [a, b]: Segment): { point: XY; t: number; dist: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const point: XY = [a[0] + t * dx, a[1] + t * dy];
  return { point, t, dist: Math.hypot(p[0] - point[0], p[1] - point[1]) };
}

export function snapPoint(doc: MapDocument, at: LonLat, opts: SnapOptions): Snapped {
  const anchor = doc.venue.anchor;
  const p = toLocal(anchor, at);
  const rings = levelRings(doc, opts.levelId);

  let best: XY | null = null;
  let bestDist = opts.toleranceM;
  for (const ring of rings) {
    for (const v of ring) {
      const d = Math.hypot(p[0] - v[0], p[1] - v[1]);
      if (d < bestDist) {
        best = v;
        bestDist = d;
      }
    }
  }
  if (best) return { position: fromLocal(anchor, best), kind: "vertex" };

  bestDist = opts.toleranceM;
  for (const seg of segments(rings)) {
    const hit = closestOnSegment(p, seg);
    if (hit.dist < bestDist) {
      best = hit.point;
      bestDist = hit.dist;
    }
  }
  if (best) return { position: fromLocal(anchor, best), kind: "edge" };

  if (opts.gridM > 0) {
    const g = opts.gridM;
    return {
      position: fromLocal(anchor, [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g]),
      kind: "grid",
    };
  }
  return { position: at, kind: "free" };
}

/** Axis-aligned (in a rotated frame) rectangle from two opposite corners. */
export function rectangleRing(doc: MapDocument, a: LonLat, b: LonLat, rotationDeg = 0): LonLat[] {
  const anchor = doc.venue.anchor;
  const t = (rotationDeg * Math.PI) / 180;
  const toFrame = ([x, y]: XY): XY => [
    x * Math.cos(t) - y * Math.sin(t),
    x * Math.sin(t) + y * Math.cos(t),
  ];
  const fromFrame = ([x, y]: XY): XY => [
    x * Math.cos(t) + y * Math.sin(t),
    -x * Math.sin(t) + y * Math.cos(t),
  ];
  const [ax, ay] = toFrame(toLocal(anchor, a));
  const [bx, by] = toFrame(toLocal(anchor, b));
  const corners: XY[] = [
    [ax, ay],
    [bx, ay],
    [bx, by],
    [ax, by],
  ];
  const ring = corners.map((c) => fromLocal(anchor, fromFrame(c)));
  return [...ring, ring[0] as LonLat];
}

export const DOOR_WIDTHS: Record<string, number> = {
  door: 0.9,
  double: 1.6,
  passage: 2.0,
  entrance: 1.8,
  window: 1.2,
};

/** Door of a given width centred on the nearest wall point, along the wall. */
export function doorOnWall(
  doc: MapDocument,
  at: LonLat,
  levelId: string,
  widthM: number,
  toleranceM: number,
): [LonLat, LonLat] | null {
  const anchor = doc.venue.anchor;
  const p = toLocal(anchor, at);
  let best: { seg: Segment; hit: ReturnType<typeof closestOnSegment> } | null = null;
  for (const seg of segments(levelRings(doc, levelId))) {
    const hit = closestOnSegment(p, seg);
    if (hit.dist <= toleranceM && (!best || hit.dist < best.hit.dist)) best = { seg, hit };
  }
  if (!best) return null;
  const [a, b] = best.seg;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 0.3) return null;
  const half = Math.min(widthM, len) / 2;
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  // Keep the whole door on the wall segment.
  const along = Math.max(half, Math.min(len - half, best.hit.t * len));
  const cx = a[0] + ux * along;
  const cy = a[1] + uy * along;
  return [
    fromLocal(anchor, [cx - ux * half, cy - uy * half]),
    fromLocal(anchor, [cx + ux * half, cy + uy * half]),
  ];
}

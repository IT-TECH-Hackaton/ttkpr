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

const MIN_DOOR_M = 0.3;

function along(origin: XY, dir: XY, p: XY): number {
  return (p[0] - origin[0]) * dir[0] + (p[1] - origin[1]) * dir[1];
}

function atT(origin: XY, dir: XY, t: number): XY {
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t];
}

/** The wall under the door, or the door's own direction when it sits on none. */
function doorAxis(
  doc: MapDocument,
  levelId: string,
  line: LonLat[],
): { origin: XY; dir: XY; min: number; max: number } | null {
  const anchor = doc.venue.anchor;
  const a = toLocal(anchor, line[0] as LonLat);
  const b = toLocal(anchor, line[line.length - 1] as LonLat);
  const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const mid: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let best: { seg: Segment; dist: number } | null = null;
  for (const seg of segments(levelRings(doc, levelId))) {
    const hit = closestOnSegment(mid, seg);
    if (!best || hit.dist < best.dist) best = { seg, dist: hit.dist };
  }
  if (best && best.dist <= 0.75) {
    const [s0, s1] = best.seg;
    const len = Math.hypot(s1[0] - s0[0], s1[1] - s0[1]);
    if (len < 1e-6) return null;
    return {
      origin: s0,
      dir: [(s1[0] - s0[0]) / len, (s1[1] - s0[1]) / len],
      min: 0,
      max: len,
    };
  }
  if (span < 1e-6) return null;
  return {
    origin: a,
    dir: [(b[0] - a[0]) / span, (b[1] - a[1]) / span],
    min: -30,
    max: span + 30,
  };
}

export function doorLength(anchor: LonLat, line: LonLat[]): number {
  if (line.length < 2) return 0;
  const a = toLocal(anchor, line[0] as LonLat);
  const b = toLocal(anchor, line[line.length - 1] as LonLat);
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Set the door's length, keeping its centre and staying on the wall. */
export function resizeDoor(
  doc: MapDocument,
  levelId: string,
  line: LonLat[],
  lengthM: number,
): [LonLat, LonLat] | null {
  if (line.length < 2) return null;
  const axis = doorAxis(doc, levelId, line);
  if (!axis) return null;
  const anchor = doc.venue.anchor;
  const ta = along(axis.origin, axis.dir, toLocal(anchor, line[0] as LonLat));
  const tb = along(axis.origin, axis.dir, toLocal(anchor, line[line.length - 1] as LonLat));
  const center = (ta + tb) / 2;
  const room = Math.max(0, axis.max - axis.min);
  const length = Math.min(Math.max(lengthM, MIN_DOOR_M), 30, room || MIN_DOOR_M);
  let start = center - length / 2;
  let end = center + length / 2;
  if (start < axis.min) {
    end += axis.min - start;
    start = axis.min;
  }
  if (end > axis.max) {
    start -= end - axis.max;
    end = axis.max;
  }
  start = Math.max(axis.min, start);
  end = Math.min(axis.max, end);
  const t0 = ta <= tb ? start : end;
  const t1 = ta <= tb ? end : start;
  return [
    fromLocal(anchor, atT(axis.origin, axis.dir, t0)),
    fromLocal(anchor, atT(axis.origin, axis.dir, t1)),
  ];
}

/** Pull one end along the wall. The other end stays. */
export function stretchDoor(
  doc: MapDocument,
  levelId: string,
  line: LonLat[],
  end: 0 | 1,
  pointer: LonLat,
): [LonLat, LonLat] | null {
  if (line.length < 2) return null;
  const axis = doorAxis(doc, levelId, line);
  if (!axis) return null;
  const anchor = doc.venue.anchor;
  const fixed = toLocal(anchor, line[end === 0 ? line.length - 1 : 0] as LonLat);
  const fixedT = along(axis.origin, axis.dir, fixed);
  let nextT = along(axis.origin, axis.dir, toLocal(anchor, pointer));
  nextT = Math.max(axis.min, Math.min(axis.max, nextT));
  if (Math.abs(nextT - fixedT) < MIN_DOOR_M) {
    const sign = nextT >= fixedT ? 1 : -1;
    const candidate = fixedT + sign * MIN_DOOR_M;
    const towardMax = axis.max - fixedT;
    const towardMin = fixedT - axis.min;
    if (candidate >= axis.min && candidate <= axis.max) nextT = candidate;
    else if (Math.max(towardMax, towardMin) < MIN_DOOR_M - 1e-6) nextT = fixedT;
    else nextT = towardMax >= towardMin ? fixedT + towardMax : fixedT - towardMin;
  }
  const moving = atT(axis.origin, axis.dir, nextT);
  const coords: XY[] = end === 0 ? [moving, fixed] : [fixed, moving];
  return [fromLocal(anchor, coords[0] as XY), fromLocal(anchor, coords[1] as XY)];
}

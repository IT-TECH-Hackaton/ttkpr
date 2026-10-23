// Planar helpers for routing, in local meters (x east, y north).

import type { XY } from "../geo";

export const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function closestOnSegment(p: XY, a: XY, b: XY): { point: XY; t: number; d: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const point: XY = [a[0] + t * dx, a[1] + t * dy];
  return { point, t, d: dist(p, point) };
}

/** Distance from a point to a ring's boundary. */
export function distanceToRing(p: XY, ring: XY[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < ring.length; i++) {
    best = Math.min(best, closestOnSegment(p, ring[i] as XY, ring[i + 1] as XY).d);
  }
  return best;
}

/** Ray casting; points within `tolerance` of the boundary count as inside. */
export function insideRing(p: XY, ring: XY[], tolerance = 0): boolean {
  if (tolerance > 0 && distanceToRing(p, ring) <= tolerance) return true;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as XY;
    const [xj, yj] = ring[j] as XY;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** A walkable straight line: every sample of the segment lies inside the room. */
export function visibleInside(a: XY, b: XY, ring: XY[], step = 0.25, tolerance = 0.05): boolean {
  const length = dist(a, b);
  const samples = Math.max(2, Math.ceil(length / step));
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    if (!insideRing([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ring, tolerance))
      return false;
  }
  return true;
}

export function signedArea(ring: XY[]): number {
  let area = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const [x1, y1] = ring[i] as XY;
    const [x2, y2] = ring[i + 1] as XY;
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

/**
 * Concave corners pushed `inset` meters into the room: paths bend around them instead of
 * cutting through walls. Convex rooms have none.
 */
export function reflexCorners(ring: XY[], inset = 0.45): XY[] {
  const pts = ring.slice(0, -1);
  const ccw = signedArea(ring) > 0;
  const result: XY[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[(i - 1 + pts.length) % pts.length] as XY;
    const cur = pts[i] as XY;
    const next = pts[(i + 1) % pts.length] as XY;
    const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
    const reflex = ccw ? cross < 0 : cross > 0;
    if (!reflex) continue;
    // Bisector of the two edge directions pointing away from the corner.
    const u = norm([prev[0] - cur[0], prev[1] - cur[1]]);
    const v = norm([next[0] - cur[0], next[1] - cur[1]]);
    const bis = norm([u[0] + v[0], u[1] + v[1]]);
    // At a reflex corner the inside lies opposite the bisector of the two edges.
    const candidate: XY = [cur[0] - bis[0] * inset, cur[1] - bis[1] * inset];
    const other: XY = [cur[0] + bis[0] * inset, cur[1] + bis[1] * inset];
    result.push(insideRing(candidate, ring) ? candidate : other);
  }
  return result;
}

function norm([x, y]: XY): XY {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}

/** Turn at `b` going a -> b -> c, degrees: positive = left, negative = right. */
export function turnAngle(a: XY, b: XY, c: XY): number {
  const h1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const h2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = ((h2 - h1) * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

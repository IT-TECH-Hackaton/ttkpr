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

/** [minX, minY, maxX, maxY]. */
export type BBox = [number, number, number, number];

export function ringBounds(ring: XY[]): BBox {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

/** The ring with its first point repeated at the end (GeoJSON style), whatever it came as. */
export function closeRing(points: XY[]): XY[] {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return [];
  return first[0] === last[0] && first[1] === last[1] ? points : [...points, first];
}

const cross = (o: XY, a: XY, b: XY) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Do segments ab and cd share a point (crossing, touching or overlapping)? */
export function segmentsIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true;
  const onSegment = (p: XY, q: XY, r: XY) =>
    Math.min(p[0], q[0]) <= r[0] &&
    r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] &&
    r[1] <= Math.max(p[1], q[1]);
  return (
    (d1 === 0 && onSegment(c, d, a)) ||
    (d2 === 0 && onSegment(c, d, b)) ||
    (d3 === 0 && onSegment(a, b, c)) ||
    (d4 === 0 && onSegment(a, b, d))
  );
}

/** Shortest distance between segments ab and cd (0 when they meet). */
export function segmentDistance(a: XY, b: XY, c: XY, d: XY): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    closestOnSegment(a, c, d).d,
    closestOnSegment(b, c, d).d,
    closestOnSegment(c, a, b).d,
    closestOnSegment(d, a, b).d,
  );
}

/** Shortest distance from segment ab to the boundary of a closed ring. */
export function segmentRingDistance(a: XY, b: XY, ring: XY[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < ring.length && best > 0; i++) {
    best = Math.min(best, segmentDistance(a, b, ring[i] as XY, ring[i + 1] as XY));
  }
  return best;
}

/** Does the open segment ab run through the interior of a closed ring (not just along it)? */
export function crossesInterior(a: XY, b: XY, ring: XY[]): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const ts = [0, 1];
  for (let i = 0; i + 1 < ring.length; i++) {
    const c = ring[i] as XY;
    const d = ring[i + 1] as XY;
    const ex = d[0] - c[0];
    const ey = d[1] - c[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue; // parallel: touching along an edge is not crossing
    const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den;
    const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  for (let i = 1; i < ts.length; i++) {
    const t0 = ts[i - 1] as number;
    const t1 = ts[i] as number;
    if (t1 - t0 < 1e-9) continue;
    const t = (t0 + t1) / 2;
    const mid: XY = [a[0] + dx * t, a[1] + dy * t];
    if (insideRing(mid, ring) && distanceToRing(mid, ring) > 1e-6) return true;
  }
  return false;
}

/**
 * A closed, simple, convex ring: a straight line between two points inside stays inside.
 * Anything doubtful (open ring, repeated points, a star winding twice) counts as not convex.
 */
export function isConvexRing(ring: XY[]): boolean {
  const first = ring[0];
  const last = ring.at(-1);
  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) return false;
  const pts = ring.slice(0, -1);
  const n = pts.length;
  if (n < 3) return false;
  let sign = 0;
  let turning = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i] as XY;
    const b = pts[(i + 1) % n] as XY;
    const c = pts[(i + 2) % n] as XY;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const vx = c[0] - b[0];
    const vy = c[1] - b[1];
    const turn = ux * vy - uy * vx;
    const along = ux * vx + uy * vy;
    if (Math.abs(turn) < 1e-9) {
      if (along < 0) return false; // folds back on itself
      continue;
    }
    if (sign === 0) sign = Math.sign(turn);
    else if (Math.sign(turn) !== sign) return false;
    turning += Math.atan2(turn, along);
  }
  return Math.abs(Math.abs(turning) - 2 * Math.PI) < 0.01;
}

/**
 * Convex corners of an obstacle pushed `offset` outward: at least `offset` from every side, so
 * routes bend around the obstacle at that distance. Sharp corners get two points (a bevel)
 * instead of a far-away miter.
 */
export function outwardCorners(ring: XY[], offset: number): XY[] {
  const pts = ring.slice(0, -1);
  const ccw = signedArea(ring) > 0;
  const result: XY[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[(i - 1 + pts.length) % pts.length] as XY;
    const cur = pts[i] as XY;
    const next = pts[(i + 1) % pts.length] as XY;
    const turn = cross(prev, cur, next);
    if (Math.abs(turn) < 1e-9 || turn > 0 !== ccw) continue; // straight or concave
    const u1 = norm([cur[0] - prev[0], cur[1] - prev[1]]);
    const u2 = norm([next[0] - cur[0], next[1] - cur[1]]);
    // Outward normals: right of the direction for a counter-clockwise ring, left otherwise.
    const n1: XY = ccw ? [u1[1], -u1[0]] : [-u1[1], u1[0]];
    const n2: XY = ccw ? [u2[1], -u2[0]] : [-u2[1], u2[0]];
    const k = 1 + n1[0] * n2[0] + n1[1] * n2[1];
    if (k >= 0.5) {
      result.push([
        cur[0] + (offset * (n1[0] + n2[0])) / k,
        cur[1] + (offset * (n1[1] + n2[1])) / k,
      ]);
    } else {
      result.push([cur[0] + offset * (n1[0] + u1[0]), cur[1] + offset * (n1[1] + u1[1])]);
      result.push([cur[0] + offset * (n2[0] - u2[0]), cur[1] + offset * (n2[1] - u2[1])]);
    }
  }
  return result;
}

/** Do two closed rings overlap (share interior or boundary points)? */
export function ringsOverlap(a: XY[], b: XY[]): boolean {
  const [ax0, ay0, ax1, ay1] = ringBounds(a);
  const [bx0, by0, bx1, by1] = ringBounds(b);
  if (ax0 > bx1 || bx0 > ax1 || ay0 > by1 || by0 > ay1) return false;
  if (a.some((p) => insideRing(p, b)) || b.some((p) => insideRing(p, a))) return true;
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      if (segmentsIntersect(a[i] as XY, a[i + 1] as XY, b[j] as XY, b[j + 1] as XY)) return true;
    }
  }
  return false;
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

// Walking a route through panoramas: which panoramas lie along it, in order, where to look,
// and the route drawn on the floor inside each of them.

import type { Pano } from "@ttkpr/api-client";
import type { MapBundle } from "../bundle";
import { bearingDeg, normalizeDeg, projectToPano, toLocal, type XY } from "../geo";
import { closestOnSegment, dist } from "./geometry";
import type { Route } from "./route";

interface Segment {
  levelId: string;
  a: XY;
  b: XY;
  /** Distance along the whole route at `a`. */
  start: number;
}

function segments(route: Route): Segment[] {
  const result: Segment[] = [];
  let along = 0;
  for (let i = 1; i < route.path.length; i++) {
    const p = route.path[i - 1] as Route["path"][number];
    const q = route.path[i] as Route["path"][number];
    if (p.levelId !== q.levelId) continue; // floor change: no horizontal distance
    result.push({ levelId: p.levelId, a: p.xy, b: q.xy, start: along });
    along += dist(p.xy, q.xy);
  }
  return result;
}

export interface RoutePano {
  pano: Pano;
  /** Meters from the start of the route. */
  along: number;
  /** Distance from the route line. */
  offsetM: number;
}

/** Ready panoramas within `maxOffsetM` of the route, in walking order. */
export function panosAlongRoute(bundle: MapBundle, route: Route, maxOffsetM = 4): RoutePano[] {
  const segs = segments(route);
  const found: RoutePano[] = [];
  for (const pano of bundle.panos ?? []) {
    if (pano.status !== "ready" || !pano.tiles) continue;
    const xy = toLocal(bundle.venue.anchor, pano.position);
    let best: RoutePano | null = null;
    for (const seg of segs) {
      if (seg.levelId !== pano.levelId) continue;
      const hit = closestOnSegment(xy, seg.a, seg.b);
      if (hit.d <= maxOffsetM && (!best || hit.d < best.offsetM)) {
        best = { pano, along: seg.start + hit.t * dist(seg.a, seg.b), offsetM: hit.d };
      }
    }
    if (best) found.push(best);
  }
  found.sort((x, y) => x.along - y.along);
  // Two panoramas at almost the same spot: keep the one closer to the line.
  return found.filter((p, i) => {
    const prev = found[i - 1];
    return !prev || p.along - prev.along > 1.5 || p.offsetM < prev.offsetM;
  });
}

/** Largest stretch of the route without a panorama, to warn about gaps. */
export function largestGapM(route: Route, along: RoutePano[]): number {
  const marks = [0, ...along.map((p) => p.along), route.distanceM];
  let gap = 0;
  for (let i = 1; i < marks.length; i++)
    gap = Math.max(gap, (marks[i] as number) - (marks[i - 1] as number));
  return gap;
}

/**
 * The route point closest to `from` (same level) and the point `ahead` meters further along.
 * Their direction is where the route goes even when the panorama stands off the line.
 */
function pointAhead(
  route: Route,
  levelId: string,
  from: XY,
  ahead: number,
): { at: XY; ahead: XY } | null {
  const segs = segments(route).filter((s) => s.levelId === levelId);
  let best: { seg: Segment; t: number; d: number } | null = null;
  for (const seg of segs) {
    const hit = closestOnSegment(from, seg.a, seg.b);
    if (!best || hit.d < best.d) best = { seg, t: hit.t, d: hit.d };
  }
  if (!best) return null;
  let remaining = ahead;
  let i = segs.indexOf(best.seg);
  const at: XY = [
    best.seg.a[0] + (best.seg.b[0] - best.seg.a[0]) * best.t,
    best.seg.a[1] + (best.seg.b[1] - best.seg.a[1]) * best.t,
  ];
  let cursor = at;
  while (i < segs.length) {
    const seg = segs[i] as Segment;
    const left = dist(cursor, seg.b);
    if (left >= remaining) {
      const k = remaining / (left || 1);
      return {
        at,
        ahead: [cursor[0] + (seg.b[0] - cursor[0]) * k, cursor[1] + (seg.b[1] - cursor[1]) * k],
      };
    }
    remaining -= left;
    i++;
    cursor = (segs[i] as Segment | undefined)?.a ?? seg.b;
  }
  return { at, ahead: cursor };
}

/** Yaw (degrees, inside the panorama) to look along the route. */
export function yawAlongRoute(bundle: MapBundle, route: Route, pano: Pano): number | null {
  const xy = toLocal(bundle.venue.anchor, pano.position);
  const found = pointAhead(route, pano.levelId, xy, 3);
  if (!found || dist(found.at, found.ahead) < 0.3) return null; // the route ends here
  return normalizeDeg(bearingDeg(found.at, found.ahead) - (pano.headingDeg ?? 0));
}

/** The route drawn on the floor inside a panorama: polylines of [yaw, pitch] in degrees. */
export function routeOnFloor(
  bundle: MapBundle,
  route: Route,
  pano: Pano,
  radiusM = 25,
  stepM = 0.5,
): [number, number][][] {
  const pose = {
    xy: toLocal(bundle.venue.anchor, pano.position),
    headingDeg: pano.headingDeg ?? 0,
    cameraHeightM: pano.cameraHeightM ?? 1.5,
  };
  const lines: [number, number][][] = [];
  let current: [number, number][] = [];
  const flush = () => {
    if (current.length > 1) lines.push(current);
    current = [];
  };
  for (const seg of segments(route)) {
    if (seg.levelId !== pano.levelId) {
      flush();
      continue;
    }
    const length = dist(seg.a, seg.b);
    const n = Math.max(1, Math.ceil(length / stepM));
    for (let i = 0; i <= n; i++) {
      const p: XY = [
        seg.a[0] + ((seg.b[0] - seg.a[0]) * i) / n,
        seg.a[1] + ((seg.b[1] - seg.a[1]) * i) / n,
      ];
      const d = dist(p, pose.xy);
      if (d > radiusM || d < 0.6) {
        flush();
        continue;
      }
      const { yaw, pitch } = projectToPano(pose, p, 0);
      current.push([yaw, pitch]);
    }
  }
  flush();
  return lines;
}

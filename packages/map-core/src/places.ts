// Where things are: the room and the zone around a point or a place.

import type { Poi, Unit, Zone } from "@ttkpr/api-client";
import type { MapBundle } from "./bundle";
import { fromLocal, type LonLat, toLocal, type XY } from "./geo";
import { closeRing, insideRing, signedArea } from "./routing/geometry";

function localRing(bundle: MapBundle, coordinates: LonLat[] | undefined): XY[] {
  return closeRing((coordinates ?? []).map((c) => toLocal(bundle.venue.anchor, c as LonLat)));
}

/** The smallest of the areas containing the point (a room inside a hall wins). */
function smallestAt<T extends { levelId: string; geometry: { coordinates: LonLat[][] } }>(
  bundle: MapBundle,
  items: T[] | undefined,
  levelId: string,
  position: LonLat,
): T | null {
  const xy = toLocal(bundle.venue.anchor, position);
  let best: T | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const item of items ?? []) {
    if (item.levelId !== levelId) continue;
    const ring = localRing(bundle, item.geometry.coordinates[0] as LonLat[] | undefined);
    if (ring.length < 4 || !insideRing(xy, ring)) continue;
    const area = Math.abs(signedArea(ring));
    if (area < bestArea) {
      best = item;
      bestArea = area;
    }
  }
  return best;
}

/** The room (any unit, walkable or not) under a point. */
export function unitAt(bundle: MapBundle, levelId: string, position: LonLat): Unit | null {
  return smallestAt(bundle, bundle.units, levelId, position);
}

/** The zone (фудкорт, зона тишины) under a point. */
export function zoneAt(bundle: MapBundle, levelId: string, position: LonLat): Zone | null {
  return smallestAt(bundle, bundle.zones, levelId, position);
}

/** The room and zone a place is in, for its card ("Зал A · Фудкорт"). */
export function placeOf(bundle: MapBundle, poi: Poi): { unit: Unit | null; zone: Zone | null } {
  return {
    unit: unitAt(bundle, poi.levelId, poi.position),
    zone: zoneAt(bundle, poi.levelId, poi.position),
  };
}

/** Places inside a room or a zone, in document order. */
export function poisIn(bundle: MapBundle, area: Unit | Zone): Poi[] {
  const ring = localRing(bundle, area.geometry.coordinates[0] as LonLat[] | undefined);
  if (ring.length < 4) return [];
  return (bundle.pois ?? []).filter(
    (p) => p.levelId === area.levelId && insideRing(toLocal(bundle.venue.anchor, p.position), ring),
  );
}

/**
 * A point inside a polygon for its label or search result: the centroid when it is inside, else
 * the middle of the widest horizontal chord through it (L- and U-shaped rooms).
 */
export function labelPoint(bundle: MapBundle, coordinates: LonLat[][]): LonLat | null {
  const ring = localRing(bundle, coordinates[0]);
  if (ring.length < 4) return null;
  const area = signedArea(ring);
  let cx = 0;
  let cy = 0;
  if (Math.abs(area) > 1e-9) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [x1, y1] = ring[i] as XY;
      const [x2, y2] = ring[i + 1] as XY;
      const k = x1 * y2 - x2 * y1;
      cx += (x1 + x2) * k;
      cy += (y1 + y2) * k;
    }
    cx /= 6 * area;
    cy /= 6 * area;
  } else {
    [cx, cy] = ring[0] as XY;
  }
  if (insideRing([cx, cy], ring)) return fromLocal(bundle.venue.anchor, [cx, cy]);
  // Crossings of the horizontal line y = cy with the outline, paired into inside chords.
  const xs: number[] = [];
  for (let i = 0; i + 1 < ring.length; i++) {
    const [x1, y1] = ring[i] as XY;
    const [x2, y2] = ring[i + 1] as XY;
    if (y1 > cy !== y2 > cy) xs.push(x1 + ((cy - y1) * (x2 - x1)) / (y2 - y1));
  }
  xs.sort((a, b) => a - b);
  let best: XY | null = null;
  let width = 0;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const w = (xs[i + 1] as number) - (xs[i] as number);
    if (w > width) {
      width = w;
      best = [((xs[i] as number) + (xs[i + 1] as number)) / 2, cy];
    }
  }
  return fromLocal(bundle.venue.anchor, best ?? (ring[0] as XY));
}

/** Size of a room in metres: the sides of its outline's bounding box (in the room's own
 * orientation for rotated rectangles) and its floor area. */
export function unitSize(
  bundle: MapBundle,
  unit: Unit,
): { widthM: number; depthM: number; areaM2: number } | null {
  const ring = localRing(bundle, unit.geometry.coordinates[0] as LonLat[] | undefined);
  if (ring.length < 4) return null;
  // The longest edge sets the room's axes, so a rotated rectangle measures as drawn.
  let angle = 0;
  let longest = 0;
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1] as XY;
    const [bx, by] = ring[i] as XY;
    const len = Math.hypot(bx - ax, by - ay);
    if (len > longest) {
      longest = len;
      angle = Math.atan2(by - ay, bx - ax);
    }
  }
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const us = ring.map(([x, y]) => x * cos - y * sin);
  const vs = ring.map(([x, y]) => x * sin + y * cos);
  return {
    widthM: Math.max(...us) - Math.min(...us),
    depthM: Math.max(...vs) - Math.min(...vs),
    areaM2: Math.abs(signedArea(ring)),
  };
}

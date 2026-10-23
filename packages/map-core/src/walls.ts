// 3D view of a floor: walls along room outlines, with gaps where the doors are, for MapLibre's
// fill-extrusion. Built from the plan itself — no 3D model needed.

import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { MapBundle } from "./bundle";
import { fromLocal, type LonLat, toLocal, type XY } from "./geo";

const WALL_THICKNESS_M = 0.15;
const DOOR_SNAP_M = 0.35;

interface WallProps {
  levelId: string;
  height: number;
}

export interface WallSegment {
  unitId: string;
  /** Local meters (x east, y north). */
  a: XY;
  b: XY;
}

/** Solid wall pieces of one level in local meters: room outlines minus the doors on them. */
export function wallSegments(bundle: MapBundle, levelId: string): WallSegment[] {
  const local = (p: LonLat) => toLocal(bundle.venue.anchor, p);
  const doors = (bundle.openings ?? [])
    .filter((o) => o.levelId === levelId)
    .map((o) => o.geometry.coordinates.map((c) => local(c as LonLat)) as [XY, XY]);
  const segments: WallSegment[] = [];
  for (const unit of bundle.units ?? []) {
    if (unit.levelId !== levelId || unit.category === "outdoor") continue;
    const ring = (unit.geometry.coordinates[0] ?? []).map((c) => local(c as LonLat));
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1] as XY;
      const b = ring[i] as XY;
      for (const [s, e] of solidParts(a, b, doors)) {
        const at = (k: number): XY => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
        segments.push({ unitId: unit.id, a: at(s), b: at(e) });
      }
    }
  }
  return segments;
}

/** Wall slabs of one level for fill-extrusion (MapLibre 3D view). */
export function wallFeatures(
  bundle: MapBundle,
  levelId: string,
): FeatureCollection<Polygon, WallProps> {
  const anchor = bundle.venue.anchor;
  const level = bundle.levels?.find((l) => l.id === levelId);
  const height = Math.max(2.2, (level?.heightM ?? 3) - 0.4);
  const features: Feature<Polygon, WallProps>[] = wallSegments(bundle, levelId).map(({ a, b }) => ({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [slab(a, b, 0, 1).map((p) => fromLocal(anchor, p))] },
    properties: { levelId, height },
  }));
  return { type: "FeatureCollection", features };
}

/** Parameter intervals [s, e] of edge a→b not covered by a door lying on it. */
function solidParts(a: XY, b: XY, doors: [XY, XY][]): [number, number][] {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 0.05) return [];
  const ux = (b[0] - a[0]) / length;
  const uy = (b[1] - a[1]) / length;
  const gaps: [number, number][] = [];
  for (const [p, q] of doors) {
    // Distance of both door ends from the edge line, and their position along it.
    const off = (r: XY) => Math.abs((r[0] - a[0]) * uy - (r[1] - a[1]) * ux);
    if (off(p) > DOOR_SNAP_M || off(q) > DOOR_SNAP_M) continue;
    const along = (r: XY) => ((r[0] - a[0]) * ux + (r[1] - a[1]) * uy) / length;
    const lo = Math.max(0, Math.min(along(p), along(q)));
    const hi = Math.min(1, Math.max(along(p), along(q)));
    if (hi > lo) gaps.push([lo, hi]);
  }
  gaps.sort((x, y) => x[0] - y[0]);
  const parts: [number, number][] = [];
  let cursor = 0;
  for (const [lo, hi] of gaps) {
    if (lo > cursor) parts.push([cursor, lo]);
    cursor = Math.max(cursor, hi);
  }
  if (cursor < 1) parts.push([cursor, 1]);
  return parts.filter(([s, e]) => (e - s) * length > 0.05);
}

/** Thin rectangle along a→b between parameters s and e, centred on the edge. */
function slab(a: XY, b: XY, s: number, e: number): XY[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  const nx = (-dy / length) * (WALL_THICKNESS_M / 2);
  const ny = (dx / length) * (WALL_THICKNESS_M / 2);
  const p = (t: number): XY => [a[0] + dx * t, a[1] + dy * t];
  const [p0, p1] = [p(s), p(e)];
  return [
    [p0[0] + nx, p0[1] + ny],
    [p1[0] + nx, p1[1] + ny],
    [p1[0] - nx, p1[1] - ny],
    [p0[0] - nx, p0[1] - ny],
    [p0[0] + nx, p0[1] + ny],
  ];
}

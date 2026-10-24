// 3D view of a floor: walls along room outlines, with gaps where the doors are and windows cut
// between the sill and the lintel, plus furniture blocks, for MapLibre's fill-extrusion. Built
// from the plan itself — no 3D model needed.

import type { FixtureKind, Opening } from "@ttkpr/api-client";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { MapBundle } from "./bundle";
import { fromLocal, type LonLat, toLocal, type XY } from "./geo";

const WALL_THICKNESS_M = 0.15;
const DOOR_SNAP_M = 0.35;
/** Walls stop below the ceiling, so the 3D view looks into the rooms. */
const WALL_CUTAWAY_M = 0.4;
const MIN_WALL_M = 2.2;
/** Effective window defaults (the document leaves them empty), as in the schema. */
export const WINDOW_SILL_HEIGHT_M = 0.9;
export const WINDOW_HEIGHT_M = 1.2;

interface WallProps {
  levelId: string;
  /** Top of the piece above the floor, m (fill-extrusion-height). */
  height: number;
  /** Bottom of the piece above the floor, m (fill-extrusion-base): 0 except above windows. */
  base: number;
  kind: WallPiece["kind"];
}

export interface WallSegment {
  unitId: string;
  /** Local meters (x east, y north). */
  a: XY;
  b: XY;
}

/** A wall piece with its vertical extent: a full wall, the part below a window or above it. */
export interface WallPiece extends WallSegment {
  /** Meters above the floor. */
  base: number;
  top: number;
  kind: "wall" | "sill" | "lintel";
}

/** Height of the walls of a room: its own ceiling if set, else the level's, minus the cutaway. */
export function wallHeight(bundle: MapBundle, unitId: string): number {
  const unit = bundle.units?.find((u) => u.id === unitId);
  const level = bundle.levels?.find((l) => l.id === unit?.levelId);
  return Math.max(MIN_WALL_M, (unit?.heightM ?? level?.heightM ?? 3) - WALL_CUTAWAY_M);
}

interface Cut {
  lo: number;
  hi: number;
  opening: Opening;
}

/** Openings of one level lying on edge a→b, as parameter intervals. */
function cutsOn(a: XY, b: XY, openings: { opening: Opening; ends: [XY, XY] }[]): Cut[] {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 0.05) return [];
  const ux = (b[0] - a[0]) / length;
  const uy = (b[1] - a[1]) / length;
  // Distance of a point from the edge line, and its position along it.
  const off = (r: XY) => Math.abs((r[0] - a[0]) * uy - (r[1] - a[1]) * ux);
  const along = (r: XY) => ((r[0] - a[0]) * ux + (r[1] - a[1]) * uy) / length;
  const cuts: Cut[] = [];
  for (const { opening, ends } of openings) {
    const [p, q] = ends;
    if (off(p) > DOOR_SNAP_M || off(q) > DOOR_SNAP_M) continue;
    const lo = Math.max(0, Math.min(along(p), along(q)));
    const hi = Math.min(1, Math.max(along(p), along(q)));
    if (hi > lo) cuts.push({ lo, hi, opening });
  }
  return cuts;
}

function levelOpenings(bundle: MapBundle, levelId: string) {
  const local = (p: LonLat) => toLocal(bundle.venue.anchor, p);
  return (bundle.openings ?? [])
    .filter((o) => o.levelId === levelId)
    .map((opening) => ({
      opening,
      ends: opening.geometry.coordinates.map((c) => local(c as LonLat)) as [XY, XY],
    }));
}

function outlines(bundle: MapBundle, levelId: string) {
  const local = (p: LonLat) => toLocal(bundle.venue.anchor, p);
  return (bundle.units ?? [])
    .filter((u) => u.levelId === levelId && u.category !== "outdoor")
    .map((unit) => ({
      unit,
      ring: (unit.geometry.coordinates[0] ?? []).map((c) => local(c as LonLat)),
    }));
}

/**
 * Solid wall pieces of one level in local meters: room outlines minus the doors on them.
 * Windows count as wall here (full height); `wallPieces` cuts them out.
 */
export function wallSegments(bundle: MapBundle, levelId: string): WallSegment[] {
  const doors = levelOpenings(bundle, levelId).filter((o) => o.opening.category !== "window");
  const segments: WallSegment[] = [];
  for (const { unit, ring } of outlines(bundle, levelId)) {
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1] as XY;
      const b = ring[i] as XY;
      for (const [s, e] of solidParts(a, b, cutsOn(a, b, doors))) {
        segments.push({ unitId: unit.id, a: lerp(a, b, s), b: lerp(a, b, e) });
      }
    }
  }
  return segments;
}

/**
 * Wall pieces of one level with their heights: full-height walls, doors left open, and under
 * and over each window a piece from the floor to the sill and from the lintel to the top.
 */
export function wallPieces(bundle: MapBundle, levelId: string): WallPiece[] {
  const openings = levelOpenings(bundle, levelId);
  const pieces: WallPiece[] = [];
  for (const { unit, ring } of outlines(bundle, levelId)) {
    const top = wallHeight(bundle, unit.id);
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1] as XY;
      const b = ring[i] as XY;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const cuts = cutsOn(a, b, openings);
      const doors = cuts.filter((c) => c.opening.category !== "window");
      const windows = cuts.filter((c) => c.opening.category === "window");
      const piece = (
        s: number,
        e: number,
        base: number,
        pieceTop: number,
        kind: WallPiece["kind"],
      ) =>
        pieces.push({
          unitId: unit.id,
          a: lerp(a, b, s),
          b: lerp(a, b, e),
          base,
          top: pieceTop,
          kind,
        });
      for (const [s, e] of solidParts(a, b, doors)) {
        // Split the solid part at window ends; each span is a full wall or a window.
        const marks = [s, e, ...windows.flatMap((w) => [w.lo, w.hi]).filter((t) => t > s && t < e)];
        marks.sort((x, y) => x - y);
        let wallFrom: number | null = null;
        for (let k = 1; k < marks.length; k++) {
          const t0 = marks[k - 1] as number;
          const t1 = marks[k] as number;
          if ((t1 - t0) * length < 0.02) continue;
          const mid = (t0 + t1) / 2;
          const window = windows.find((w) => w.lo <= mid && mid <= w.hi);
          if (!window) {
            wallFrom ??= t0;
            continue;
          }
          if (wallFrom !== null) piece(wallFrom, t0, 0, top, "wall");
          wallFrom = null;
          const sill = Math.min(top, window.opening.sillHeightM ?? WINDOW_SILL_HEIGHT_M);
          const lintel = Math.min(top, sill + (window.opening.heightM ?? WINDOW_HEIGHT_M));
          if (sill > 0.01) piece(t0, t1, 0, sill, "sill");
          if (top - lintel > 0.01) piece(t0, t1, lintel, top, "lintel");
        }
        if (wallFrom !== null) piece(wallFrom, e, 0, top, "wall");
      }
    }
  }
  return pieces;
}

/** Wall slabs of one level for fill-extrusion: `height` on top, `base` underneath. */
export function wallFeatures(
  bundle: MapBundle,
  levelId: string,
): FeatureCollection<Polygon, WallProps> {
  const anchor = bundle.venue.anchor;
  const features: Feature<Polygon, WallProps>[] = wallPieces(bundle, levelId).map(
    ({ a, b, base, top, kind }) => ({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [slab(a, b, 0, 1).map((p) => fromLocal(anchor, p))],
      },
      properties: { levelId, height: top, base, kind },
    }),
  );
  return { type: "FeatureCollection", features };
}

/** Heights of furniture without its own `heightM`, m. Columns go up to the ceiling. */
export const FIXTURE_HEIGHTS_M: Record<FixtureKind, number> = {
  table: 0.75,
  booth: 2.5,
  stage: 0.6,
  counter: 1.1,
  seating: 0.45,
  screen: 2,
  plant: 1.2,
  column: Number.POSITIVE_INFINITY,
  shelf: 1.8,
  kiosk: 1.6,
  other: 1,
};

interface FixtureProps {
  id: string;
  levelId: string;
  kind: FixtureKind;
  name: string;
  height: number;
  base: number;
  obstacle: boolean;
  /** Organizer's colour, if any (#RRGGBB). */
  color?: string;
}

/** Furniture of one level as blocks for fill-extrusion (`height`, `base`, `color`). */
export function fixtureFeatures(
  bundle: MapBundle,
  levelId: string,
): FeatureCollection<Polygon, FixtureProps> {
  const level = bundle.levels?.find((l) => l.id === levelId);
  const ceiling = Math.max(MIN_WALL_M, (level?.heightM ?? 3) - WALL_CUTAWAY_M);
  const features: Feature<Polygon, FixtureProps>[] = (bundle.fixtures ?? [])
    .filter((f) => f.levelId === levelId)
    .map((f) => ({
      type: "Feature",
      id: f.id,
      geometry: { type: "Polygon", coordinates: f.geometry.coordinates },
      properties: {
        id: f.id,
        levelId,
        kind: f.kind,
        name: f.name ?? "",
        height: Math.min(ceiling, f.heightM ?? FIXTURE_HEIGHTS_M[f.kind] ?? 1),
        base: 0,
        obstacle: f.obstacle !== false,
        ...(f.color ? { color: f.color } : {}),
      },
    }));
  return { type: "FeatureCollection", features };
}

const lerp = (a: XY, b: XY, k: number): XY => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];

/** Parameter intervals [s, e] of edge a→b not covered by the given cuts (doors). */
function solidParts(a: XY, b: XY, cuts: Cut[]): [number, number][] {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 0.05) return [];
  const gaps = cuts.map((c) => [c.lo, c.hi] as [number, number]).sort((x, y) => x[0] - y[0]);
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

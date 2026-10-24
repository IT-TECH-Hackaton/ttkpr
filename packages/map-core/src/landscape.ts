// Surroundings for the visitor map: a lawn around the buildings and trees on it. Generated from
// the plan itself — deterministic per venue, so every visitor sees the same trees — and kept off
// rooms, doors and walkways. Decoration only: nothing here takes part in routing.

import type { FeatureCollection, Polygon } from "geojson";
import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import type { MapBundle } from "./bundle";
import { fromLocal, type LonLat, toLocal, type XY } from "./geo";
import { closestOnSegment, distanceToRing, insideRing } from "./routing/geometry";

/** Lawn beyond the outermost room or walkway, m. */
const LAWN_MARGIN_M = 14;
const LAWN_CORNER_M = 9;
/** Grid step of tree candidates, m (each is jittered, about half are kept). */
const TREE_SPACING_M = 5;
/** Free space kept around rooms, doors and walkways, m. */
const ROOM_CLEARANCE_M = 3.5;
const DOOR_CLEARANCE_M = 4;
const PATH_CLEARANCE_M = 2.2;
const MAX_TREES = 360;

export type TreeKind = "broadleaf" | "pine" | "bush";

export interface Tree {
  id: string;
  position: LonLat;
  kind: TreeKind;
  /** Crown radius, m. */
  radius: number;
  /** Top of the crown, m. */
  height: number;
  /** 0–3: one of four greens, so the canopy is not one flat colour. */
  tone: number;
}

export interface Landscape {
  lawn: FeatureCollection<Polygon>;
  trees: Tree[];
}

/** Small deterministic PRNG (mulberry32) seeded by the venue id. */
function random(seedText: string): () => number {
  let seed = 2166136261;
  for (const ch of seedText) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundedRect(x0: number, y0: number, x1: number, y1: number, r: number): XY[] {
  const corners: [number, number, number][] = [
    [x1 - r, y0 + r, -90],
    [x1 - r, y1 - r, 0],
    [x0 + r, y1 - r, 90],
    [x0 + r, y0 + r, 180],
  ];
  const ring: XY[] = [];
  for (const [cx, cy, start] of corners) {
    for (let step = 0; step <= 6; step++) {
      const a = ((start + step * 15) * Math.PI) / 180;
      ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  ring.push(ring[0] as XY);
  return ring;
}

function nearSegments(p: XY, lines: XY[][], limit: number): boolean {
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      if (closestOnSegment(p, line[i - 1] as XY, line[i] as XY).d < limit) return true;
    }
  }
  return false;
}

/** The lawn and the trees for a venue; empty for a plan without rooms. */
export function landscape(bundle: MapBundle): Landscape {
  const anchor = bundle.venue.anchor;
  const local = (p: LonLat | number[]) => toLocal(anchor, p as LonLat);
  const rooms = (bundle.units ?? []).map((u) => (u.geometry.coordinates[0] ?? []).map(local));
  const paths = (bundle.paths ?? []).map((p) => p.geometry.coordinates.map(local));
  const doors = (bundle.openings ?? []).map((o) => o.geometry.coordinates.map(local));
  const points = [...rooms, ...paths].flat();
  if (rooms.length === 0 || points.length === 0) {
    return { lawn: { type: "FeatureCollection", features: [] }, trees: [] };
  }

  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, y0] = [Math.min(...xs) - LAWN_MARGIN_M, Math.min(...ys) - LAWN_MARGIN_M];
  const [x1, y1] = [Math.max(...xs) + LAWN_MARGIN_M, Math.max(...ys) + LAWN_MARGIN_M];
  const lawnRing = roundedRect(x0, y0, x1, y1, LAWN_CORNER_M);
  const lawn: FeatureCollection<Polygon> = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [lawnRing.map((p) => fromLocal(anchor, p))] },
        properties: { kind: "lawn" },
      },
    ],
  };

  const rand = random(bundle.venue.id);
  const trees: Tree[] = [];
  for (let gy = y0 + 2; gy < y1 - 2; gy += TREE_SPACING_M) {
    for (let gx = x0 + 2; gx < x1 - 2; gx += TREE_SPACING_M) {
      const p: XY = [
        gx + (rand() - 0.5) * TREE_SPACING_M * 0.8,
        gy + (rand() - 0.5) * TREE_SPACING_M * 0.8,
      ];
      const roll = rand();
      const kindRoll = rand();
      const sizeRoll = rand();
      const tone = Math.floor(rand() * 4);
      if (!insideRing(p, lawnRing) || distanceToRing(p, lawnRing) < 1.5) continue;
      const toRooms = Math.min(
        ...rooms.map((ring) => (insideRing(p, ring) ? 0 : distanceToRing(p, ring))),
      );
      if (toRooms < ROOM_CLEARANCE_M) continue;
      if (nearSegments(p, paths, PATH_CLEARANCE_M) || nearSegments(p, doors, DOOR_CLEARANCE_M)) {
        continue;
      }
      // Sparse next to the buildings, denser towards the edge of the lawn: a park, not a hedge.
      if (roll > Math.min(0.62, 0.12 + toRooms / 24)) continue;
      const kind: TreeKind = kindRoll < 0.5 ? "broadleaf" : kindRoll < 0.78 ? "pine" : "bush";
      const scale = 0.8 + sizeRoll * 0.45;
      const radius = (kind === "bush" ? 0.9 : kind === "pine" ? 1.5 : 2) * scale;
      // Lower next to the walls, so the 3D view still sees into the rooms.
      const near = Math.min(1, 0.55 + toRooms / 16);
      const height = (kind === "bush" ? 1.2 : (kind === "pine" ? 6.5 : 5) * near) * scale;
      trees.push({
        id: `tree-${trees.length}`,
        position: fromLocal(anchor, p),
        kind,
        radius,
        height,
        tone,
      });
      if (trees.length >= MAX_TREES) return { lawn, trees };
    }
  }
  return { lawn, trees };
}

function circle(center: XY, radius: number, sides: number, phase = 0): XY[] {
  const ring: XY[] = [];
  for (let i = 0; i <= sides; i++) {
    const a = phase + (i / sides) * Math.PI * 2;
    ring.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]);
  }
  return ring;
}

interface CrownProps {
  id: string;
  kind: TreeKind;
  tone: number;
}

interface SolidProps {
  part: "trunk" | "crown";
  tone: number;
  /** fill-extrusion-base / -height, m. */
  base: number;
  height: number;
}

/** Tree tops for the flat plan (crown discs) and their soft shadows, offset to the south-east. */
export function treeCrowns(
  bundle: MapBundle,
  trees: Tree[],
): { crowns: FeatureCollection<Polygon, CrownProps>; shadows: FeatureCollection<Polygon> } {
  const anchor = bundle.venue.anchor;
  const crowns: FeatureCollection<Polygon, CrownProps> = {
    type: "FeatureCollection",
    features: [],
  };
  const shadows: FeatureCollection<Polygon> = { type: "FeatureCollection", features: [] };
  for (const tree of trees) {
    const c = toLocal(anchor, tree.position);
    const ring = (center: XY, r: number) => circle(center, r, 14).map((p) => fromLocal(anchor, p));
    const offset = tree.height * 0.08;
    shadows.features.push({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [ring([c[0] + offset, c[1] - offset], tree.radius)],
      },
      properties: {},
    });
    crowns.features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring(c, tree.radius)] },
      properties: { id: tree.id, kind: tree.kind, tone: tree.tone },
    });
  }
  return { crowns, shadows };
}

/**
 * Low-poly trees for fill-extrusion: a trunk and stacked crown tiers (a cone for pines, a rounded
 * crown for broadleaf trees, one low tier for bushes).
 */
export function treeSolids(
  bundle: MapBundle,
  trees: Tree[],
): FeatureCollection<Polygon, SolidProps> {
  const anchor = bundle.venue.anchor;
  const out: FeatureCollection<Polygon, SolidProps> = { type: "FeatureCollection", features: [] };
  const add = (
    c: XY,
    r: number,
    base: number,
    height: number,
    part: SolidProps["part"],
    tone: number,
  ) =>
    out.features.push({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [circle(c, r, 8, Math.PI / 8).map((p) => fromLocal(anchor, p))],
      },
      properties: { part, tone, base, height },
    });
  for (const t of trees) {
    const c = toLocal(anchor, t.position);
    const h = t.height;
    const r = t.radius;
    if (t.kind === "bush") {
      add(c, r * 0.75, 0, h * 0.45, "crown", t.tone);
      add(c, r, h * 0.2, h * 0.8, "crown", t.tone);
      add(c, r * 0.6, h * 0.8, h, "crown", t.tone);
      continue;
    }
    const trunkTop = t.kind === "pine" ? h * 0.2 : h * 0.38;
    add(c, Math.max(0.16, r * 0.11), 0, trunkTop + 0.4, "trunk", t.tone);
    const tiers =
      t.kind === "pine"
        ? [
            [1, 0.2, 0.45],
            [0.75, 0.45, 0.68],
            [0.48, 0.68, 0.86],
            [0.22, 0.86, 1],
          ]
        : [
            [0.7, 0.38, 0.5],
            [1, 0.5, 0.78],
            [0.78, 0.78, 0.92],
            [0.45, 0.92, 1],
          ];
    for (const [k, from, to] of tiers as [number, number, number][]) {
      add(c, r * k, h * from, h * to, "crown", t.tone);
    }
  }
  return out;
}

export const LANDSCAPE_SOURCE = {
  lawn: "landscape-lawn",
  crowns: "landscape-crowns",
  shadows: "landscape-shadows",
  solids: "landscape-3d",
} as const;

/** Layers of the surroundings; the flat ones go under the rooms, the 3D one next to the walls. */
export const LANDSCAPE_LAYERS = {
  flat: ["landscape-lawn", "landscape-lawn-edge", "landscape-shadows", "landscape-crowns"],
  threeD: ["landscape-3d"],
} as const;

const GREENS_LIGHT = ["#7fb069", "#6b9f5a", "#8fbf73", "#5f9150"];
const GREENS_DARK = ["#2f4a2c", "#2a4227", "#365535", "#243a22"];

const tone = (greens: string[]): ExpressionSpecification =>
  [
    "match",
    ["get", "tone"],
    0,
    greens[0],
    1,
    greens[1],
    2,
    greens[2],
    greens[3],
  ] as ExpressionSpecification;

/** Colours of the surroundings for the light or dark plan (also used by `applyPlanTheme`). */
export function landscapePaint(dark: boolean) {
  const greens = dark ? GREENS_DARK : GREENS_LIGHT;
  return {
    lawn: dark ? "#132017" : "#e3efd6",
    lawnEdge: dark ? "#1f3324" : "#c9deb7",
    shadow: dark ? "#000000" : "#4b6340",
    crown: tone(greens),
    crownOutline: dark ? "#1b2b1a" : "#55804a",
    solid: [
      "case",
      ["==", ["get", "part"], "trunk"],
      dark ? "#4a3b2c" : "#8a6a4a",
      tone(greens),
    ] as ExpressionSpecification,
  };
}

export function landscapeLayers(dark = false): LayerSpecification[] {
  const p = landscapePaint(dark);
  return [
    {
      id: "landscape-lawn",
      type: "fill",
      source: LANDSCAPE_SOURCE.lawn,
      paint: { "fill-color": p.lawn },
    },
    {
      id: "landscape-lawn-edge",
      type: "line",
      source: LANDSCAPE_SOURCE.lawn,
      paint: { "line-color": p.lawnEdge, "line-width": 2 },
    },
    {
      id: "landscape-shadows",
      type: "fill",
      source: LANDSCAPE_SOURCE.shadows,
      paint: { "fill-color": p.shadow, "fill-opacity": 0.16 },
    },
    {
      id: "landscape-crowns",
      type: "fill",
      source: LANDSCAPE_SOURCE.crowns,
      paint: { "fill-color": p.crown, "fill-outline-color": p.crownOutline },
    },
    {
      id: "landscape-3d",
      type: "fill-extrusion",
      source: LANDSCAPE_SOURCE.solids,
      layout: { visibility: "none" },
      paint: {
        "fill-extrusion-color": p.solid,
        "fill-extrusion-base": ["get", "base"],
        "fill-extrusion-height": ["get", "height"],
        "fill-extrusion-opacity": 1,
      },
    },
  ] as LayerSpecification[];
}

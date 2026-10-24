// Photoshop-style plan grid: the square stays a similar size on screen,
// so zooming out jumps to a coarser step (0.5 м, 1.5 м, 5 м, …).

import { fromLocal, type LonLat, toLocal, type XY } from "@ttkpr/map-core";
import type { Feature, FeatureCollection } from "geojson";

const STEPS = [0.1, 0.2, 0.25, 0.5, 1, 1.5, 2, 2.5, 5, 10, 15, 20, 25, 50, 100, 200, 500];
const TARGET_PX = 64;
const MIN_PX = 40;
const MAX_LINES = 80;

/** Cell side, in meters, for the current meters-per-pixel. */
export function gridCellMeters(metersPerPixel: number): number {
  if (!(metersPerPixel > 0)) return 1;
  const ideal = metersPerPixel * TARGET_PX;
  let best = STEPS[STEPS.length - 1] ?? 1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const step of STEPS) {
    if (step / metersPerPixel < MIN_PX) continue;
    const score = Math.abs(Math.log(step / ideal));
    if (score < bestScore) {
      best = step;
      bestScore = score;
    }
  }
  return best;
}

export function gridLineColor(dark: boolean): string {
  return dark ? "rgba(226,232,240,0.05)" : "rgba(51,65,85,0.1)";
}

export function formatGridSize(meters: number): string {
  return `${meters} м`;
}

function segment(anchor: LonLat, a: XY, b: XY): Feature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [fromLocal(anchor, a), fromLocal(anchor, b)] },
    properties: {},
  };
}

/** Lines over the visible area, locked to the venue anchor so panning does not slide them. */
export function gridLines(
  anchor: LonLat,
  west: number,
  south: number,
  east: number,
  north: number,
  step: number,
): FeatureCollection {
  const corners = [
    toLocal(anchor, [west, south]),
    toLocal(anchor, [east, south]),
    toLocal(anchor, [west, north]),
    toLocal(anchor, [east, north]),
  ];
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of corners) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  minX -= step;
  maxX += step;
  minY -= step;
  maxY += step;
  const features: Feature[] = [];
  const x0 = Math.floor(minX / step) * step;
  const y0 = Math.floor(minY / step) * step;
  const xCount = Math.min(MAX_LINES, Math.ceil((maxX - x0) / step) + 1);
  const yCount = Math.min(MAX_LINES, Math.ceil((maxY - y0) / step) + 1);
  for (let i = 0; i < xCount; i++) {
    const x = x0 + i * step;
    features.push(segment(anchor, [x, minY], [x, maxY]));
  }
  for (let i = 0; i < yCount; i++) {
    const y = y0 + i * step;
    features.push(segment(anchor, [minX, y], [maxX, y]));
  }
  return { type: "FeatureCollection", features };
}

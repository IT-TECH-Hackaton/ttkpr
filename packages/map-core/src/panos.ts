import type { Pano, Poi } from "@ttkpr/api-client";
import type { MapBundle } from "./bundle";
import { type LonLat, type PanoPose, projectToPano, toLocal, type XY } from "./geo";

export const PANO_VISIBILITY_RADIUS_M = 30;

export function panoPose(bundle: MapBundle, pano: Pano): PanoPose {
  return {
    xy: toLocal(bundle.venue.anchor, pano.position),
    headingDeg: pano.headingDeg ?? 0,
    cameraHeightM: pano.cameraHeightM ?? 1.5,
  };
}

function localXY(bundle: MapBundle, position: LonLat): XY {
  return toLocal(bundle.venue.anchor, position);
}

function distance(a: XY, b: XY) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// TODO(geo-routing): replace radius checks with line-of-sight visibility precomputed in the bundle.

/** Nearest ready panorama on the same level, or null. */
export function nearestPano(bundle: MapBundle, poi: Poi): Pano | null {
  const target = localXY(bundle, poi.position);
  let best: Pano | null = null;
  let bestDist = PANO_VISIBILITY_RADIUS_M;
  for (const pano of bundle.panos ?? []) {
    if (pano.levelId !== poi.levelId || pano.status !== "ready" || !pano.tiles) continue;
    const d = distance(localXY(bundle, pano.position), target);
    if (d < bestDist) {
      best = pano;
      bestDist = d;
    }
  }
  return best;
}

export interface PanoTarget {
  id: string;
  kind: "poi" | "pano";
  label: string;
  yaw: number;
  pitch: number;
  distanceM: number;
}

/** POIs and neighbouring panoramas to show as markers inside a panorama (degrees). */
export function panoTargets(bundle: MapBundle, pano: Pano): PanoTarget[] {
  const pose = panoPose(bundle, pano);
  const targets: PanoTarget[] = [];
  for (const poi of bundle.pois ?? []) {
    if (poi.levelId !== pano.levelId) continue;
    const xy = localXY(bundle, poi.position);
    const d = distance(pose.xy, xy);
    if (d > PANO_VISIBILITY_RADIUS_M) continue;
    const { yaw, pitch } = projectToPano(pose, xy, poi.heightM ?? 1.2);
    targets.push({ id: poi.id, kind: "poi", label: poi.name, yaw, pitch, distanceM: d });
  }
  for (const other of bundle.panos ?? []) {
    if (other.id === pano.id || other.levelId !== pano.levelId || !other.tiles) continue;
    const xy = localXY(bundle, other.position);
    const d = distance(pose.xy, xy);
    if (d > PANO_VISIBILITY_RADIUS_M) continue;
    const { yaw, pitch } = projectToPano(pose, xy, 0);
    targets.push({ id: other.id, kind: "pano", label: "Перейти", yaw, pitch, distanceM: d });
  }
  return targets;
}

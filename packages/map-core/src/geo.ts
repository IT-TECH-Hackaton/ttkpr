// Local ENU frame and plan <-> panorama projections.
// Must stay identical to packages/map-schema/src/map_schema/geo.py; both are checked
// against fixtures/geo-vectors.json. Conventions are documented in docs/CONVENTIONS.md.

export type LonLat = [lon: number, lat: number];
export type XY = [x: number, y: number];

export const EARTH_RADIUS_M = 6378137;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Lon/lat -> meters east/north of the anchor (local tangent plane, fine for < 10 km). */
export function toLocal(anchor: LonLat, point: LonLat): XY {
  const [lon0, lat0] = anchor;
  const [lon, lat] = point;
  return [
    toRad(lon - lon0) * EARTH_RADIUS_M * Math.cos(toRad(lat0)),
    toRad(lat - lat0) * EARTH_RADIUS_M,
  ];
}

export function fromLocal(anchor: LonLat, [x, y]: XY): LonLat {
  const [lon0, lat0] = anchor;
  return [
    lon0 + toDeg(x / (EARTH_RADIUS_M * Math.cos(toRad(lat0)))),
    lat0 + toDeg(y / EARTH_RADIUS_M),
  ];
}

/** Wrap to (-180, 180]. */
export function normalizeDeg(angle: number): number {
  let a = angle % 360;
  if (a <= -180) a += 360;
  else if (a > 180) a -= 360;
  return a;
}

/** Azimuth clockwise from north, [0, 360). */
export function bearingDeg(origin: XY, target: XY): number {
  const deg = toDeg(Math.atan2(target[0] - origin[0], target[1] - origin[1]));
  return ((deg % 360) + 360) % 360;
}

export interface PanoPose {
  xy: XY;
  headingDeg: number;
  cameraHeightM: number;
}

/** Point on the plan -> { yaw, pitch } in degrees inside the panorama. */
export function projectToPano(
  pano: PanoPose,
  target: XY,
  targetHeightM: number,
): { yaw: number; pitch: number } {
  const dist = Math.hypot(target[0] - pano.xy[0], target[1] - pano.xy[1]);
  return {
    yaw: normalizeDeg(bearingDeg(pano.xy, target) - pano.headingDeg),
    pitch: toDeg(Math.atan2(targetHeightM - pano.cameraHeightM, dist)),
  };
}

/** Tap on the floor inside the panorama -> point on the plan. null if not looking down. */
export function floorPointFromPano(pano: PanoPose, yawDeg: number, pitchDeg: number): XY | null {
  if (pitchDeg >= 0) return null;
  const dist = pano.cameraHeightM / Math.tan(toRad(-pitchDeg));
  const azimuth = toRad(pano.headingDeg + yawDeg);
  return [pano.xy[0] + dist * Math.sin(azimuth), pano.xy[1] + dist * Math.cos(azimuth)];
}

export { toDeg, toRad };

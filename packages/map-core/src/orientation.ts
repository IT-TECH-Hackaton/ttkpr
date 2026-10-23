// Phone orientation -> camera rotation, for panorama capture.
// DeviceOrientationEvent (W3C): R_device->earth = Rz(alpha) · Rx(beta) · Ry(gamma); earth x east,
// y north, z up (alpha may be relative to an arbitrary start, which is fine for stitching).
// Device axes: x right, y up the screen, z out of the screen. The back camera looks along -z.
// Camera axes (OpenCV, CLAUDE.md): x right, y down, z forward => R_cam = R_device · diag(1,-1,-1).

export type Vec3 = [number, number, number];
/** Row-major 3x3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type Quat = [w: number, x: number, y: number, z: number];

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

// Indices are always 0..8 here; the helper keeps noUncheckedIndexedAccess quiet.
const at = (m: readonly number[], i: number) => m[i] as number;

function mul(a: Mat3, b: Mat3): Mat3 {
  const r: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += at(a, i * 3 + k) * at(b, k * 3 + j);
      r.push(sum);
    }
  return r as Mat3;
}

const rz = (t: number): Mat3 => [
  Math.cos(t),
  -Math.sin(t),
  0,
  Math.sin(t),
  Math.cos(t),
  0,
  0,
  0,
  1,
];
const rx = (t: number): Mat3 => [
  1,
  0,
  0,
  0,
  Math.cos(t),
  -Math.sin(t),
  0,
  Math.sin(t),
  Math.cos(t),
];
const ry = (t: number): Mat3 => [
  Math.cos(t),
  0,
  Math.sin(t),
  0,
  1,
  0,
  -Math.sin(t),
  0,
  Math.cos(t),
];
const FLIP_YZ: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, -1];

/** Camera -> world rotation of the back camera from deviceorientation angles (degrees). */
export function cameraRotation(alpha: number, beta: number, gamma: number): Mat3 {
  return mul(mul(mul(rz(rad(alpha)), rx(rad(beta))), ry(rad(gamma))), FLIP_YZ);
}

/** Column c of a rotation = camera axis c expressed in world coordinates. */
export function axis(m: Mat3, c: 0 | 1 | 2): Vec3 {
  return [at(m, c), at(m, 3 + c), at(m, 6 + c)];
}

export const forward = (m: Mat3) => axis(m, 2);

/** World -> camera: R^T · v. */
export function toCamera(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

/** Direction for yaw (clockwise from north/start) and pitch (up), degrees. */
export function direction(yawDeg: number, pitchDeg: number): Vec3 {
  const y = rad(yawDeg);
  const p = rad(pitchDeg);
  return [Math.sin(y) * Math.cos(p), Math.cos(y) * Math.cos(p), Math.sin(p)];
}

export function yawPitch(v: Vec3): { yaw: number; pitch: number } {
  const n = Math.hypot(v[0], v[1], v[2]);
  return { yaw: deg(Math.atan2(v[0], v[1])), pitch: deg(Math.asin(v[2] / n)) };
}

export function angleBetween(a: Vec3, b: Vec3): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const n = Math.hypot(...a) * Math.hypot(...b);
  return deg(Math.acos(Math.min(1, Math.max(-1, dot / n))));
}

/** Rotation matrix -> unit quaternion [w, x, y, z] (Shepperd's method). */
export function toQuaternion(m: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
  }
  const n = Math.hypot(...q);
  return q.map((c) => c / n) as Quat;
}

export interface CaptureTarget {
  id: number;
  yaw: number; // relative to the direction at the start of the capture
  pitch: number;
}

/** Shot plan: horizon ring every 30°, rings at ±45° every 60°, zenith and nadir (26 shots). */
export function captureTargets(): CaptureTarget[] {
  const targets: Omit<CaptureTarget, "id">[] = [];
  for (let yaw = 0; yaw < 360; yaw += 30) targets.push({ yaw, pitch: 0 });
  for (let yaw = 0; yaw < 360; yaw += 60) targets.push({ yaw, pitch: 45 });
  for (let yaw = 30; yaw < 390; yaw += 60) targets.push({ yaw: yaw % 360, pitch: -45 });
  targets.push({ yaw: 0, pitch: 88 }, { yaw: 0, pitch: -88 });
  return targets.map((t, id) => ({ ...t, id }));
}

/** Focal length in pixels for a frame, assuming a ~26 mm-equivalent main camera. */
export function assumedFocal(width: number, height: number): number {
  return 0.75 * Math.max(width, height);
}

/** FOV across the short side for that assumed focal length, degrees. */
export function assumedFov(width: number, height: number): number {
  return deg(2 * Math.atan(Math.min(width, height) / 2 / assumedFocal(width, height)));
}

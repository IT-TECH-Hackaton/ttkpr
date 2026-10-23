import { describe, expect, it } from "vitest";
import {
  angleBetween,
  axis,
  cameraRotation,
  captureTargets,
  direction,
  forward,
  toCamera,
  toQuaternion,
  type Vec3,
} from "./orientation";

const close = (a: Vec3, b: Vec3) => {
  for (const [i, v] of a.entries()) expect(v).toBeCloseTo(b[i] ?? 0, 9);
};

describe("cameraRotation", () => {
  it("phone upright in portrait looks north with the image 'down' pointing at the floor", () => {
    const r = cameraRotation(0, 90, 0);
    close(forward(r), [0, 1, 0]);
    close(axis(r, 1), [0, 0, -1]);
    close(axis(r, 0), [1, 0, 0]);
  });

  it("turning left increases alpha and looks west", () => {
    close(forward(cameraRotation(90, 90, 0)), [-1, 0, 0]);
  });

  it("tilting the top away (beta > 90) looks up", () => {
    const f = forward(cameraRotation(0, 135, 0));
    expect(f[2]).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it("toCamera inverts the rotation", () => {
    const r = cameraRotation(33, 70, -12);
    close(toCamera(r, forward(r)), [0, 0, 1]);
  });
});

describe("toQuaternion", () => {
  it("encodes the same rotation as the matrix", () => {
    const r = cameraRotation(120, 80, 25);
    const [w, x, y, z] = toQuaternion(r);
    // Rotate the camera forward axis (0,0,1) with the quaternion and compare.
    const rotated: Vec3 = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
    close(rotated, forward(r));
  });
});

describe("captureTargets", () => {
  it("covers the sphere with neighbours close enough to overlap", () => {
    const targets = captureTargets();
    expect(targets).toHaveLength(26);
    for (const t of targets.filter((t) => Math.abs(t.pitch) < 80)) {
      const d = direction(t.yaw, t.pitch);
      const nearest = Math.min(
        ...targets
          .filter((o) => o.id !== t.id)
          .map((o) => angleBetween(d, direction(o.yaw, o.pitch))),
      );
      expect(nearest).toBeLessThanOrEqual(45);
    }
  });
});

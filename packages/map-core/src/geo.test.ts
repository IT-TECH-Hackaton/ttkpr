import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { floorPointFromPano, fromLocal, type LonLat, projectToPano, toLocal, type XY } from "./geo";

interface Vectors {
  toLocal: { anchor: LonLat; point: LonLat; expected: XY }[];
  projectToPano: {
    name: string;
    pano: XY;
    heading: number;
    cameraHeight: number;
    target: XY;
    targetHeight: number;
    yaw: number;
    pitch: number;
  }[];
  floorFromPano: {
    pano: XY;
    heading: number;
    cameraHeight: number;
    yaw: number;
    pitch: number;
    expected: XY | null;
  }[];
}

const vectors: Vectors = JSON.parse(
  readFileSync(new URL("../../../fixtures/geo-vectors.json", import.meta.url), "utf-8"),
);

describe("toLocal / fromLocal", () => {
  it.each(vectors.toLocal)("$point", ({ anchor, point, expected }) => {
    const [x, y] = toLocal(anchor, point);
    expect(x).toBeCloseTo(expected[0], 3);
    expect(y).toBeCloseTo(expected[1], 3);
    const [lon, lat] = fromLocal(anchor, [x, y]);
    expect(lon).toBeCloseTo(point[0], 9);
    expect(lat).toBeCloseTo(point[1], 9);
  });
});

describe("projectToPano", () => {
  it.each(vectors.projectToPano)("$name", (c) => {
    const { yaw, pitch } = projectToPano(
      { xy: c.pano, headingDeg: c.heading, cameraHeightM: c.cameraHeight },
      c.target,
      c.targetHeight,
    );
    expect(yaw).toBeCloseTo(c.yaw, 9);
    expect(pitch).toBeCloseTo(c.pitch, 9);
  });
});

describe("floorPointFromPano", () => {
  it.each(vectors.floorFromPano)("yaw $yaw pitch $pitch", (c) => {
    const result = floorPointFromPano(
      { xy: c.pano, headingDeg: c.heading, cameraHeightM: c.cameraHeight },
      c.yaw,
      c.pitch,
    );
    if (c.expected === null) {
      expect(result).toBeNull();
      return;
    }
    expect(result?.[0]).toBeCloseTo(c.expected[0], 9);
    expect(result?.[1]).toBeCloseTo(c.expected[1], 9);
  });
});

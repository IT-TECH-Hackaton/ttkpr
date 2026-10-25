import type { MapDocument } from "@ttkpr/api-client";
import { fromLocal, type LonLat, toLocal } from "@ttkpr/map-core";
import { describe, expect, it } from "vitest";
import {
  doorOnWall,
  metersPerPixel,
  rectangleRing,
  resizeDoor,
  snapPoint,
  stretchDoor,
} from "./snap";

const anchor: LonLat = [37.62, 55.754];
const at = (x: number, y: number) => fromLocal(anchor, [x, y]);
const local = (p: LonLat) => toLocal(anchor, p).map((v) => Math.round(v * 100) / 100);

// One 10 x 6 m room with its corner at the origin.
const doc: MapDocument = {
  venue: { id: "v", name: "Тест", anchor },
  levels: [{ id: "l1", name: "1", ordinal: 0 }],
  units: [
    {
      id: "u1",
      levelId: "l1",
      category: "room",
      geometry: {
        type: "Polygon",
        coordinates: [[at(0, 0), at(10, 0), at(10, 6), at(0, 6), at(0, 0)]],
      },
    },
  ],
};

const opts = { levelId: "l1", toleranceM: 0.5, gridM: 0.5 };

describe("snapPoint", () => {
  it("prefers room corners, then walls, then the grid", () => {
    expect(snapPoint(doc, at(10.2, 6.3), opts)).toMatchObject({ kind: "vertex" });
    expect(local(snapPoint(doc, at(10.2, 6.3), opts).position)).toEqual([10, 6]);

    const wall = snapPoint(doc, at(4.1, 6.3), opts);
    expect(wall.kind).toBe("edge");
    expect(local(wall.position)).toEqual([4.1, 6]);

    const grid = snapPoint(doc, at(13.26, 2.1), opts);
    expect(grid.kind).toBe("grid");
    expect(local(grid.position)).toEqual([13.5, 2]);
  });

  it("ignores rooms on other levels", () => {
    expect(snapPoint(doc, at(10.2, 6.3), { ...opts, levelId: "l2" }).kind).toBe("grid");
  });
});

describe("rectangleRing", () => {
  it("builds a closed rectangle from two corners", () => {
    const ring = rectangleRing(doc, at(10, 0), at(14, 6));
    expect(ring).toHaveLength(5);
    expect(ring.map(local)).toEqual([
      [10, 0],
      [14, 0],
      [14, 6],
      [10, 6],
      [10, 0],
    ]);
  });
});

describe("doorOnWall", () => {
  it("centres a door on the clicked wall and keeps it inside the wall", () => {
    const door = doorOnWall(doc, at(5, 0.2), "l1", 0.9, 1);
    expect(door?.map(local)).toEqual([
      [4.55, 0],
      [5.45, 0],
    ]);
    const corner = doorOnWall(doc, at(0.1, 0.1), "l1", 0.9, 1);
    const xs = corner?.flatMap(local) ?? [];
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
  });

  it("refuses to place a door away from walls", () => {
    expect(doorOnWall(doc, at(5, 3), "l1", 0.9, 1)).toBeNull();
  });

  it("changes the length from the properties and keeps the centre on the wall", () => {
    const door = doorOnWall(doc, at(5, 0.2), "l1", 0.9, 1);
    if (!door) throw new Error("door");
    expect(resizeDoor(doc, "l1", door, 2)?.map(local)).toEqual([
      [4, 0],
      [6, 0],
    ]);
    const full = resizeDoor(doc, "l1", door, 100);
    const xs = full?.flatMap(local) ?? [];
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(10);
  });

  it("pulls one end along the wall and leaves the other", () => {
    const door = doorOnWall(doc, at(5, 0.2), "l1", 0.9, 1);
    if (!door) throw new Error("door");
    expect(stretchDoor(doc, "l1", door, 1, at(8, 0.2))?.map(local)).toEqual([
      [4.55, 0],
      [8, 0],
    ]);
  });
});

describe("metersPerPixel", () => {
  it("matches MapLibre's 512 px tiles", () => {
    // At the equator, zoom 0 spans the Earth's circumference over 512 px.
    expect(metersPerPixel(0, 0) * 512).toBeCloseTo(40075016.7, -1);
  });
});

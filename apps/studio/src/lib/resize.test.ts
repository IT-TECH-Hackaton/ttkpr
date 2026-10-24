import type { XY } from "@ttkpr/map-core";
import { describe, expect, it } from "vitest";
import {
  isRectangle,
  moveCorner,
  moveRoom,
  moveWall,
  rectangleCorner,
  shiftOpenings,
  wallHandles,
} from "./resize";

const rect = (x0: number, y0: number, x1: number, y1: number): XY[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

const round = (ring: XY[]) =>
  ring.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);

describe("wallHandles", () => {
  it("puts a point in the middle of each wall", () => {
    const handles = wallHandles(rect(0, 0, 10, 6));
    expect(handles.map((h) => h.edge)).toEqual([0, 1, 2, 3]);
    expect(round(handles.map((h) => h.at))).toEqual([
      [5, 0],
      [10, 3],
      [5, 6],
      [0, 3],
    ]);
    expect(handles[0]?.cursor).toBe("ns-resize");
    expect(handles[3]?.cursor).toBe("ew-resize");
  });
});

describe("moveWall", () => {
  const room = rect(2, 0, 12, 6);
  const neighbor = rect(0, 6, 10, 12);

  it("aligns a wall with the parallel wall of the next room", () => {
    // Left wall is edge 3. Pull it toward the neighbor's left wall at x = 0.
    const moved = moveWall(room, 3, [0.2, 3], {
      toleranceM: 0.5,
      gridM: 0.5,
      others: [neighbor],
    });
    expect(moved?.snapped).toBe("wall");
    expect(round(moved?.ring ?? [])).toEqual(round(rect(0, 0, 12, 6)));
    expect(moved?.guide).not.toBeNull();
  });

  it("stops half a meter short of the opposite wall", () => {
    const moved = moveWall(room, 3, [30, 3], {
      toleranceM: 0,
      gridM: 0,
      others: [],
    });
    const left = moved?.ring[3]?.[0] ?? 0;
    expect(left).toBeGreaterThan(11);
    expect(left).toBeLessThanOrEqual(11.5);
  });
});

describe("moveCorner", () => {
  const room = rect(2, 0, 12, 6);

  it("moves both walls with the corner and leaves the opposite corner", () => {
    const moved = moveCorner(room, 0, [0, -1], [], { toleranceM: 0, gridM: 0, others: [] });
    expect(round(moved?.ring ?? [])).toEqual(round(rect(0, -1, 12, 6)));
  });

  it("aligns a side with the neighbouring room", () => {
    const moved = moveCorner(room, 0, [0.2, -0.1], [], {
      toleranceM: 0.5,
      gridM: 0,
      others: [rect(0, 6, 10, 12)],
    });
    expect(round(moved?.ring ?? [])[0]).toEqual([0, -0.1]);
    expect(moved?.guides.length).toBeGreaterThan(0);
  });

  it("ignores corners of a free-form outline", () => {
    const poly: XY[] = [
      [0, 0],
      [8, 1],
      [9, 6],
      [4, 8],
      [1, 4],
      [0, 0],
    ];
    expect(isRectangle(poly)).toBe(false);
    expect(rectangleCorner(poly, [0, 0], 1)).toBeNull();
  });
});

describe("moveRoom", () => {
  it("slides the room and a door on its wall until the wall meets a neighbour", () => {
    const room = rect(2, 0, 12, 6);
    const moved = moveRoom(
      room,
      [
        {
          id: "door",
          line: [
            [2, 2],
            [2, 3],
          ],
        },
      ],
      [-1.7, 0],
      {
        toleranceM: 0.5,
        gridM: 0,
        others: [rect(0, 6, 10, 12)],
      },
    );
    expect(round(moved.ring)).toEqual(round(rect(0, 0, 10, 6)));
    expect(round(moved.openings[0]?.line ?? [])).toEqual([
      [0, 2],
      [0, 3],
    ]);
  });
});

describe("shiftOpenings", () => {
  const room = rect(2, 0, 12, 6);

  it("moves a door on the wall and keeps a door on another wall", () => {
    const moved = shiftOpenings(
      [
        {
          id: "on",
          line: [
            [2, 2],
            [2, 3],
          ],
        },
        {
          id: "other",
          line: [
            [4, 0],
            [5, 0],
          ],
        },
      ],
      room,
      3,
      -2,
    );
    expect(moved).toEqual([
      {
        id: "on",
        line: [
          [0, 2],
          [0, 3],
        ],
      },
    ]);
  });
});

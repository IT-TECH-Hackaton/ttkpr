import { describe, expect, it } from "vitest";
import { placeRing, roomsFromLuminance } from "./autoPlan";

/** White paper, black 4 px walls: two rooms side by side, a door gap in the partition. */
function plan(w = 400, h = 200) {
  const lum = new Uint8Array(w * h).fill(250);
  const wall = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) lum[y * w + x] = 10;
  };
  wall(20, 20, 380, 24); // top
  wall(20, 176, 380, 180); // bottom
  wall(20, 20, 24, 180); // left
  wall(376, 20, 380, 180); // right
  wall(198, 20, 202, 86); // partition with an 8 px door gap (~2 % of the width, like 0.9 m)
  wall(198, 94, 202, 180);
  return { lum, w, h };
}

describe("rooms from a plan image", () => {
  it("finds both rooms despite the door gap, squared and close to the walls", () => {
    const { lum, w, h } = plan();
    const rooms = roomsFromLuminance(lum, w, h);
    expect(rooms).toHaveLength(2);
    for (const room of rooms) {
      const xs = room.ring.map(([x]) => x * w);
      const ys = room.ring.map(([, y]) => y * h);
      // Rectangles: four corners (+ the closing point), edges along the axes.
      expect(room.ring).toHaveLength(5);
      expect(Math.min(...ys)).toBeGreaterThan(18);
      expect(Math.max(...ys)).toBeLessThan(182);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(160);
    }
  });

  it("places image fractions with the underlay corners", () => {
    const corners: [number, number][] = [
      [0, 1],
      [2, 1],
      [2, 0],
      [0, 0],
    ];
    expect(placeRing([[0.5, 0.5]], corners)).toEqual([[1, 0.5]]);
  });
});

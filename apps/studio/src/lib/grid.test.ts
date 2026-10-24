import { describe, expect, it } from "vitest";
import { formatGridSize, gridCellMeters } from "./grid";

describe("gridCellMeters", () => {
  it("picks a coarser square as the map is zoomed out", () => {
    // About 70 px per 1.5 m — a typical indoor zoom.
    expect(gridCellMeters(1.5 / 70)).toBe(1.5);
    // Same screen size, five meters per cell.
    expect(gridCellMeters(5 / 64)).toBe(5);
    expect(gridCellMeters(5 / 64)).toBeGreaterThan(gridCellMeters(1.5 / 70));
  });
});

describe("formatGridSize", () => {
  it("prints the cell side in meters", () => {
    expect(formatGridSize(1.5)).toBe("1.5 м");
    expect(formatGridSize(10)).toBe("10 м");
  });
});

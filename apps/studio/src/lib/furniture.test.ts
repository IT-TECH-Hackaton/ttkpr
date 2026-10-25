import type { XY } from "@ttkpr/map-core";
import { describe, expect, it } from "vitest";
import {
  fixtureExtent,
  fixtureHandles,
  resizeFixture,
  rotateFixture,
  stretchFixture,
} from "./furniture";

const square: XY[] = [
  [0, 0],
  [2, 0],
  [2, 1],
  [0, 1],
  [0, 0],
];

describe("furniture shapes", () => {
  it("puts stretch grips on the sides and turn grips on the corners", () => {
    const handles = fixtureHandles(square);
    expect(handles.filter((h) => h.role === "resize")).toHaveLength(4);
    expect(handles.filter((h) => h.role === "rotate")).toHaveLength(4);
  });

  it("stretches one side and leaves the opposite side", () => {
    const next = stretchFixture(square, 0, [4, 0.5]);
    expect(next).not.toBeNull();
    const xs = (next ?? []).map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(0);
    expect(Math.max(...xs)).toBeCloseTo(4);
    expect(fixtureExtent(next ?? []).widthM).toBeCloseTo(4);
    expect(fixtureExtent(next ?? []).depthM).toBeCloseTo(1);
  });

  it("turns the piece around its centre", () => {
    const next = rotateFixture(square, [2, 0.5], [1, 1.5]);
    const corner = next?.find((p) => Math.abs(p[0] - 1.5) < 1e-6 && Math.abs(p[1] - 1.5) < 1e-6);
    expect(corner).toBeTruthy();
  });

  it("sets width and depth from the properties", () => {
    const next = resizeFixture(square, 4, 2);
    expect(fixtureExtent(next).widthM).toBeCloseTo(4);
    expect(fixtureExtent(next).depthM).toBeCloseTo(2);
  });

  it("keeps width on the same side after it becomes the shorter one", () => {
    const next = resizeFixture(square, 0.5, 1);
    expect(fixtureExtent(next).widthM).toBeCloseTo(0.5);
    expect(fixtureExtent(next).depthM).toBeCloseTo(1);
  });
});

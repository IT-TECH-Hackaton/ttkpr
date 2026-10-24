import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MapBundle } from "./bundle";
import { type LonLat, toLocal, type XY } from "./geo";
import { landscape, treeCrowns, treeSolids } from "./landscape";
import { closestOnSegment, distanceToRing, insideRing } from "./routing/geometry";

const demo = JSON.parse(
  readFileSync(new URL("../../../fixtures/demo-map.json", import.meta.url), "utf-8"),
) as MapBundle;
const anchor = demo.venue.anchor;
const local = (p: LonLat | number[]) => toLocal(anchor, p as LonLat);

describe("landscape of the demo venue", () => {
  const { lawn, trees } = landscape(demo);

  it("lays a lawn under every room", () => {
    const ring = (lawn.features[0]?.geometry.coordinates[0] ?? []).map(local);
    for (const unit of demo.units ?? []) {
      for (const p of unit.geometry.coordinates[0] ?? [])
        expect(insideRing(local(p), ring)).toBe(true);
    }
  });

  it("plants trees off rooms, doors and walkways", () => {
    expect(trees.length).toBeGreaterThan(20);
    for (const tree of trees) {
      const p = local(tree.position);
      for (const unit of demo.units ?? []) {
        const ring = (unit.geometry.coordinates[0] ?? []).map(local);
        expect(insideRing(p, ring)).toBe(false);
        expect(distanceToRing(p, ring)).toBeGreaterThan(2.5);
      }
      for (const path of demo.paths ?? []) {
        const line = path.geometry.coordinates.map(local);
        for (let i = 1; i < line.length; i++) {
          expect(closestOnSegment(p, line[i - 1] as XY, line[i] as XY).d).toBeGreaterThan(2);
        }
      }
    }
  });

  it("is the same on every device", () => {
    expect(landscape(demo).trees).toEqual(trees);
  });

  it("builds crowns for the plan and solids for 3D", () => {
    expect(treeCrowns(demo, trees).crowns.features).toHaveLength(trees.length);
    const solids = treeSolids(demo, trees).features;
    expect(solids.some((f) => f.properties.part === "trunk")).toBe(true);
    for (const f of solids) expect(f.properties.height).toBeGreaterThan(f.properties.base);
  });

  it("leaves an empty plan bare", () => {
    expect(landscape({ ...demo, units: [], paths: [] }).trees).toEqual([]);
  });
});

// Routing with organizer customisation: furniture as obstacles, windows, doors and rooms closed
// to visitors, doors a wheelchair cannot pass. Synthetic plans in local meters.

import type { Fixture, MapDocument, Opening, Poi, Unit } from "@ttkpr/api-client";
import { describe, expect, it } from "vitest";
import { fromLocal, type LonLat, toLocal, type XY } from "../geo";
import { crossesInterior, outwardCorners, segmentRingDistance } from "./geometry";
import { buildNavGraph, FIXTURE_PASS_M, poiNodeId } from "./graph";
import { findRoute, unreachablePois } from "./route";

const anchor: LonLat = [37.62, 55.754];
const at = (x: number, y: number) => fromLocal(anchor, [x, y]);
const box = (x0: number, y0: number, x1: number, y1: number) => ({
  type: "Polygon" as const,
  coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]],
});
const line = (x0: number, y0: number, x1: number, y1: number) => ({
  type: "LineString" as const,
  coordinates: [at(x0, y0), at(x1, y1)],
});
const local = (p: LonLat): XY => toLocal(anchor, p);
const ringOf = (x0: number, y0: number, x1: number, y1: number): XY[] =>
  (box(x0, y0, x1, y1).coordinates[0] as LonLat[]).map(local);

function plan(parts: {
  units: Unit[];
  openings?: Opening[];
  pois?: Poi[];
  fixtures?: Fixture[];
}): MapDocument {
  return {
    venue: { id: "v", name: "Тест", anchor },
    levels: [{ id: "l1", name: "1 этаж", ordinal: 0 }],
    ...parts,
  };
}

const room = (
  id: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  extra: Partial<Unit> = {},
): Unit => ({
  id,
  levelId: "l1",
  name: id,
  category: "room",
  geometry: box(x0, y0, x1, y1),
  ...extra,
});
const poi = (id: string, x: number, y: number): Poi => ({
  id,
  levelId: "l1",
  name: id,
  category: "other",
  position: at(x, y),
});
const table = (
  id: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  extra: Partial<Fixture> = {},
): Fixture => ({
  id,
  levelId: "l1",
  kind: "table",
  geometry: box(x0, y0, x1, y1),
  ...extra,
});
const door = (
  id: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  extra: Partial<Opening> = {},
): Opening => ({
  id,
  levelId: "l1",
  geometry: line(x0, y0, x1, y1),
  ...extra,
});

/** Every leg of the route keeps clear of the obstacle and never runs through it. */
function expectClear(path: { xy: XY }[], obstacle: XY[], clearance = FIXTURE_PASS_M) {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]?.xy as XY;
    const b = path[i]?.xy as XY;
    expect(crossesInterior(a, b, obstacle)).toBe(false);
    expect(segmentRingDistance(a, b, obstacle)).toBeGreaterThanOrEqual(clearance - 1e-6);
  }
}

describe("furniture as obstacles", () => {
  const hall = () =>
    plan({
      units: [room("hall", 0, 0, 20, 10, { category: "hall" })],
      pois: [poi("a", 2, 5), poi("b", 18, 5)],
      fixtures: [table("t1", 8, 3, 12, 7)],
    });

  it("routes around a table instead of across it", () => {
    const doc = hall();
    const route = findRoute(buildNavGraph(doc), doc, { poiId: "a" }, { poiId: "b" });
    if (!route) throw new Error("no route around the table");
    expectClear(route.path, ringOf(8, 3, 12, 7));
    // Longer than the straight 16 m, but only by the detour around one pair of corners.
    expect(route.distanceM).toBeGreaterThan(16.5);
    expect(route.distanceM).toBeLessThan(18);
  });

  it("walks straight when there is no table or it is not an obstacle", () => {
    for (const doc of [
      { ...hall(), fixtures: [] },
      { ...hall(), fixtures: [table("t1", 8, 3, 12, 7, { obstacle: false })] },
    ]) {
      const route = findRoute(buildNavGraph(doc), doc, { poiId: "a" }, { poiId: "b" });
      expect(route?.distanceM).toBeCloseTo(16, 6);
    }
  });

  it("goes down an aisle between tables, but not through a gap too narrow", () => {
    const aisle = plan({
      units: [room("hall", 0, 0, 20, 10, { category: "hall" })],
      pois: [poi("a", 2, 5), poi("b", 18, 5)],
      fixtures: [table("t1", 5, 0, 15, 4.5), table("t2", 5, 5.5, 15, 10)],
    });
    const route = findRoute(buildNavGraph(aisle), aisle, { poiId: "a" }, { poiId: "b" });
    expect(route?.distanceM).toBeLessThan(16.5);

    // 0.5 m between the tables and the tables against the walls: no way through.
    const blocked = {
      ...aisle,
      fixtures: [table("t1", 5, 0, 15, 4.75), table("t2", 5, 5.25, 15, 10)],
    };
    const g = buildNavGraph(blocked);
    expect(findRoute(g, blocked, { poiId: "a" }, { poiId: "b" })).toBeNull();
    expect(unreachablePois(g, blocked)).toEqual(["b"]);
  });

  it("reaches a stand inside a booth, but never cuts through the booth", () => {
    const doc = plan({
      units: [room("hall", 0, 0, 20, 10, { category: "hall" })],
      pois: [poi("a", 2, 5), poi("stand", 10, 5), poi("b", 18, 5)],
      fixtures: [table("booth", 8, 3, 12, 7, { kind: "booth" })],
    });
    const g = buildNavGraph(doc);
    expect(g.nodes.get(poiNodeId("stand"))?.enclosed).toBe(true);

    const toStand = findRoute(g, doc, { poiId: "a" }, { poiId: "stand" });
    expect(toStand?.path.at(-1)?.xy[0]).toBeCloseTo(10, 6);

    const across = findRoute(g, doc, { poiId: "a" }, { poiId: "b" });
    if (!across) throw new Error("no route past the booth");
    expect(
      across.path.some((p) => Math.abs(p.xy[0] - 10) < 1e-9 && Math.abs(p.xy[1] - 5) < 1e-9),
    ).toBe(false);
    expectClear(across.path, ringOf(8, 3, 12, 7));
    expect(unreachablePois(g, doc)).toEqual([]);

    // Starting at the stand works too: the route leaves the booth.
    const fromStand = findRoute(g, doc, { poiId: "stand" }, { poiId: "b" });
    expect(fromStand).not.toBeNull();
  });

  it("lets a tapped point inside a table start and end routes, and leaves the graph intact", () => {
    const doc = hall();
    const g = buildNavGraph(doc);
    const before = [...g.edges.values()].reduce((n, list) => n + list.length, 0);
    const route = findRoute(g, doc, { levelId: "l1", position: at(10, 5) }, { poiId: "b" });
    expect(route).not.toBeNull();
    const back = findRoute(g, doc, { poiId: "a" }, { levelId: "l1", position: at(10, 5) });
    expect(back).not.toBeNull();
    const after = [...g.edges.values()].reduce((n, list) => n + list.length, 0);
    expect(after).toBe(before);
  });

  it("keeps the door usable when a table stands right behind it", () => {
    // The usual approach point (0.9 m in) falls on the table; a shallower one is used.
    const doc = plan({
      units: [room("a", 0, 0, 10, 10), room("b", 10, 0, 20, 10)],
      openings: [door("d", 10, 4.5, 10, 5.5)],
      pois: [poi("pa", 5, 5), poi("pb", 15, 5)],
      fixtures: [table("t", 10.6, 3, 11.4, 7)],
    });
    const route = findRoute(buildNavGraph(doc), doc, { poiId: "pa" }, { poiId: "pb" });
    if (!route) throw new Error("door blocked by the table");
    expect(route.steps.some((s) => s.kind === "door")).toBe(true);
  });

  it("puts corner nodes outside the obstacle at the clearance", () => {
    const ring = ringOf(0, 0, 2, 1);
    const corners = outwardCorners(ring, 0.45);
    expect(corners).toHaveLength(4);
    for (const c of corners)
      expect(segmentRingDistance(c, c, ring)).toBeCloseTo(0.45 * Math.SQRT2, 6);
    // A needle-like triangle gets bevel points, still at least the clearance away.
    const needle: XY[] = [
      [0, 0],
      [10, 0.3],
      [0, 0.6],
      [0, 0],
    ];
    for (const c of outwardCorners(needle, 0.45)) {
      expect(segmentRingDistance(c, c, needle)).toBeGreaterThanOrEqual(0.45 - 1e-9);
    }
  });
});

describe("openings and rooms closed to visitors", () => {
  const twoRooms = (openings: Opening[]) =>
    plan({
      units: [room("left", 0, 0, 10, 10), room("right", 10, 0, 20, 10)],
      openings,
      pois: [poi("a", 5, 5), poi("b", 15, 5)],
    });
  const usedDoors = (doc: MapDocument, options = {}) => {
    const g = buildNavGraph(doc);
    const route = findRoute(g, doc, { poiId: "a" }, { poiId: "b" }, options);
    return route
      ? route.path
          .map((p) => [...g.nodes.values()].find((n) => n.xy === p.xy))
          .filter((n) => n?.kind === "door")
          .map((n) => n?.ref)
      : null;
  };

  it("never uses a window as a door", () => {
    const window: Opening = door("w", 10, 4, 10, 6, { category: "window" });
    expect(usedDoors(twoRooms([window]))).toBeNull();
    expect(buildNavGraph(twoRooms([window])).nodes.has("door:w")).toBe(false);
    expect(usedDoors(twoRooms([window, door("d", 10, 8.5, 10, 9.5)]))).toEqual(["d"]);
  });

  it("avoids staff, locked and emergency doors", () => {
    for (const access of ["staff", "locked", "emergency"] as const) {
      const closed = door("closed", 10, 4.5, 10, 5.5, { access });
      expect(usedDoors(twoRooms([closed]))).toBeNull();
      expect(usedDoors(twoRooms([closed, door("d", 10, 8.5, 10, 9.5)]))).toEqual(["d"]);
    }
    // The public door in the middle is the short way when it is open.
    expect(
      usedDoors(twoRooms([door("mid", 10, 4.5, 10, 5.5), door("d", 10, 8.5, 10, 9.5)])),
    ).toEqual(["mid"]);
  });

  it("goes around rooms closed to visitors", () => {
    // Three rooms over a corridor; the middle one is the shortcut while it is open.
    const doc = (access?: Unit["access"]) =>
      plan({
        units: [
          { ...room("corridor", 0, 0, 30, 3), category: "corridor" },
          room("A", 0, 3, 10, 10),
          room("B", 10, 3, 20, 10, access ? { access } : {}),
          room("C", 20, 3, 30, 10),
        ],
        openings: [
          door("a", 4, 3, 6, 3),
          door("b", 14, 3, 16, 3),
          door("c", 24, 3, 26, 3),
          door("ab", 10, 6, 10, 8),
          door("bc", 20, 6, 20, 8),
        ],
        pois: [poi("pa", 5, 7), poi("pb", 15, 7), poi("pc", 25, 7)],
      });
    const open = doc();
    const short = findRoute(buildNavGraph(open), open, { poiId: "pa" }, { poiId: "pc" });
    expect(short?.distanceM).toBeLessThan(22);

    for (const access of ["staff", "closed"] as const) {
      const closed = doc(access);
      const g = buildNavGraph(closed);
      expect(g.rooms.get("l1")?.map((r) => r.unit.id)).toEqual(["corridor", "A", "C"]);
      const around = findRoute(g, closed, { poiId: "pa" }, { poiId: "pc" });
      if (!around) throw new Error("no way round");
      expect(around.distanceM).toBeGreaterThan(25);
      expect(around.path.every((p) => p.xy[0] < 10 || p.xy[0] > 20 || p.xy[1] < 3)).toBe(true);
      expect(unreachablePois(g, closed)).toEqual(["pb"]);
    }
  });

  it("keeps revolving and narrow doors off step-free routes", () => {
    for (const barrier of [{ kind: "revolving" }, { widthM: 0.7 }] as Partial<Opening>[]) {
      const doc = twoRooms([
        door("fast", 10, 4.5, 10, 5.5, barrier),
        door("wide", 10, 8.5, 10, 9.5),
      ]);
      expect(usedDoors(doc)).toEqual(["fast"]);
      expect(usedDoors(doc, { avoidStairs: true })).toEqual(["wide"]);
      // Without another door there is simply no step-free way.
      expect(
        usedDoors(twoRooms([door("fast", 10, 4.5, 10, 5.5, barrier)]), { avoidStairs: true }),
      ).toBeNull();
    }
    // A wide automatic door is fine.
    const auto = twoRooms([door("fast", 10, 4.5, 10, 5.5, { kind: "automatic", widthM: 1.2 })]);
    expect(usedDoors(auto, { avoidStairs: true })).toEqual(["fast"]);
  });
});

describe("a large venue", () => {
  it("builds the graph for ~200 rooms and 100 tables quickly", () => {
    const units: Unit[] = [];
    const openings: Opening[] = [];
    const fixtures: Fixture[] = [];
    const pois: Poi[] = [];
    // Each floor: two rows of 50 rooms (4 x 6 m) along a 200 m corridor.
    for (const levelId of ["l1", "l2"]) {
      const on = { levelId };
      units.push(room(`corridor-${levelId}`, 0, 6, 200, 10, { ...on, category: "corridor" }));
      for (let i = 0; i < 50; i++) {
        for (const [y0, y1, dy] of [
          [0, 6, 6],
          [10, 16, 10],
        ] as const) {
          const id = `r${i}-${y0}-${levelId}`;
          units.push(room(id, i * 4, y0, i * 4 + 4, y1, on));
          openings.push(door(`d${id}`, i * 4 + 1.5, dy, i * 4 + 2.5, dy, on));
          pois.push({ ...poi(`p${id}`, i * 4 + 2, (y0 + y1) / 2), ...on });
        }
      }
    }
    // A 60 x 30 m hall at the end of the first-floor corridor with 60 tables in rows...
    units.push(room("hall", 200, 0, 260, 30, { category: "hall" }));
    openings.push(door("dhall", 200, 7, 200, 9));
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 12; col++) {
        const x = 203 + col * 4.6;
        const y = 3 + row * 4.2;
        fixtures.push(table(`ht${row}-${col}`, x, y, x + 2.2, y + 1.6));
      }
    }
    pois.push(poi("far", 258, 28));
    // ...and 40 more tables in small rooms: 100 obstacles in all.
    for (let i = 5; i < 45; i++) fixtures.push(table(`st${i}`, i * 4 + 0.5, 0.8, i * 4 + 1.5, 1.8));
    const doc: MapDocument = {
      venue: { id: "v", name: "Выставка", anchor },
      levels: [
        { id: "l1", name: "1 этаж", ordinal: 0 },
        { id: "l2", name: "2 этаж", ordinal: 1 },
      ],
      units,
      openings,
      pois,
      fixtures,
      connectors: [
        {
          id: "stairs",
          kind: "stairs",
          points: [
            { levelId: "l1", position: at(100, 8) },
            { levelId: "l2", position: at(100, 8) },
          ],
        },
      ],
    };
    expect(units.length).toBeGreaterThan(200);
    const t0 = performance.now();
    const g = buildNavGraph(doc);
    const built = performance.now() - t0;
    const t1 = performance.now();
    const route = findRoute(g, doc, { poiId: "pr0-0-l2" }, { poiId: "far" });
    const routed = performance.now() - t1;
    expect(route?.legs.map((l) => l.levelId)).toEqual(["l2", "l1"]);
    for (const f of fixtures.filter((f) => f.id.startsWith("ht"))) {
      expectClear(route?.path ?? [], (f.geometry.coordinates[0] as LonLat[]).map(local));
    }
    expect(unreachablePois(g, doc)).toEqual([]);
    // Generous bounds for slow CI machines; typically tens of milliseconds.
    expect(built).toBeLessThan(3000);
    expect(routed).toBeLessThan(500);
  });
});

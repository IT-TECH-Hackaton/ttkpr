import { readFileSync } from "node:fs";
import type { MapDocument } from "@ttkpr/api-client";
import { describe, expect, it } from "vitest";
import { fromLocal, type LonLat, toLocal } from "../geo";
import { visibleInside } from "./geometry";
import { buildNavGraph, roomAt } from "./graph";
import { panosAlongRoute, routeOnFloor, yawAlongRoute } from "./panoramas";
import { findRoute, findTourRoute, nextStep, unreachablePois } from "./route";

const demo: MapDocument = JSON.parse(
  readFileSync(new URL("../../../../fixtures/demo-map.json", import.meta.url), "utf-8"),
);
const graph = buildNavGraph(demo);

describe("routes on the demo venue", () => {
  it("goes from a hall to the cafe through the doors and the corridor", () => {
    const route = findRoute(graph, demo, { poiId: "p-stand-a1" }, { poiId: "p-coffee" });
    expect(route).not.toBeNull();
    const doors = route?.steps.filter((s) => s.kind === "door").map((s) => s.text);
    expect(doors).toEqual([
      "Пройдите через дверь в «Коридор» и поверните направо",
      "Пройдите через дверь в «Кафе»",
    ]);
    expect(route?.steps[0]?.text).toBe("Начните у «Стенд A1»");
    expect(route?.steps.at(-1)?.text).toBe("Вы на месте: «Кофе-поинт»");
    // Never shorter than the straight line, never absurdly longer for this simple plan.
    expect(route?.distanceM).toBeGreaterThan(24);
    expect(route?.distanceM).toBeLessThan(40);
    expect(route?.legs).toHaveLength(1);
  });

  it("changes floors by the stairs, or by the lift without steps", () => {
    const stairs = findRoute(graph, demo, { poiId: "p-stand-a1" }, { poiId: "p-mentors" });
    expect(stairs?.legs.map((l) => l.levelId)).toEqual(["l1", "l2"]);
    expect(stairs?.steps.find((s) => s.kind === "floor")?.text).toBe(
      "Поднимитесь по лестнице на 2 этаж",
    );
    expect(stairs?.usesStairs).toBe(true);

    const lift = findRoute(
      graph,
      demo,
      { poiId: "p-stand-a1" },
      { poiId: "p-mentors" },
      { avoidStairs: true },
    );
    expect(lift?.steps.find((s) => s.kind === "floor")?.text).toBe(
      "Поднимитесь на лифте на 2 этаж",
    );
    expect(lift?.usesStairs).toBe(false);
    expect(lift?.durationS).toBeGreaterThan(stairs?.durationS ?? 0);
  });

  it("starts from a point tapped on the map", () => {
    const anchor = demo.venue.anchor;
    const route = findRoute(
      graph,
      demo,
      { levelId: "l1", position: fromLocal(anchor, [5, 10]) },
      { poiId: "p-registration" },
    );
    expect(route?.steps[0]?.text).toBe("Начните у отмеченной точки");
    expect(route?.steps.some((s) => s.text === "Пройдите через дверь в «Вход и регистрация»")).toBe(
      true,
    );
  });

  it("tells which instruction comes next along the way", () => {
    const route = findRoute(graph, demo, { poiId: "p-stand-a1" }, { poiId: "p-coffee" });
    if (!route) throw new Error("no route");
    expect(nextStep(route, 0)?.step).toBe(route.steps[1]);
    expect(nextStep(route, route.distanceM)?.step.kind).toBe("arrive");
    expect(nextStep(route, route.distanceM)?.inM).toBe(0);
  });

  it("joins an organizer's tour through several stops", () => {
    const stops = ["p-registration", "p-coffee", "p-stand-a1", "p-mentors"];
    const tour = findTourRoute(graph, demo, stops);
    if (!tour) throw new Error("no tour");
    const legs = stops
      .slice(1)
      .map((to, i) => findRoute(graph, demo, { poiId: stops[i] as string }, { poiId: to }));
    const total = legs.reduce((sum, r) => sum + (r?.distanceM ?? 0), 0);
    expect(tour.distanceM).toBeCloseTo(total, 6);
    expect(tour.steps.filter((s) => s.kind === "stop").map((s) => s.text)).toEqual([
      "Точка 2 из 4: «Кофе-поинт»",
      "Точка 3 из 4: «Стенд A1»",
    ]);
    expect(tour.steps.filter((s) => s.kind === "start")).toHaveLength(1);
    expect(tour.steps.at(-1)?.text).toBe("Вы на месте: «Менторы»");
    expect(tour.legs.map((l) => l.levelId)).toEqual(["l1", "l2"]);
  });

  it("knows which taps land inside a room", () => {
    const anchor = demo.venue.anchor;
    expect(roomAt(graph, "l1", fromLocal(anchor, [5, 10]))).not.toBeNull();
    expect(roomAt(graph, "l1", fromLocal(anchor, [500, 500]))).toBeNull();
  });

  it("reports nothing unreachable on a connected plan", () => {
    expect(unreachablePois(graph, demo)).toEqual([]);
  });

  it("finds the panoramas along the way and where to look", () => {
    const route = findRoute(graph, demo, { poiId: "p-stand-a1" }, { poiId: "p-registration" });
    if (!route) throw new Error("no route");
    const along = panosAlongRoute(demo, route);
    expect(along.map((p) => p.pano.id)).toEqual(["pano-corridor-west", "pano-corridor-east"]);
    // West pano faces north (heading 0); the route continues east along the corridor.
    const west = along[0]?.pano;
    if (!west) throw new Error("no pano");
    // The pano stands 2 m off the line: still look along the corridor, not across it.
    expect(yawAlongRoute(demo, route, west)).toBeCloseTo(90, 0);
    const floor = routeOnFloor(demo, route, west);
    expect(floor.length).toBeGreaterThan(0);
    expect(floor.flat().every(([, pitch]) => pitch < 0)).toBe(true);
  });
});

// An L-shaped corridor: the route must bend around the inner corner, not cut through the wall.
function lPlan(): MapDocument {
  const anchor: LonLat = [37.62, 55.754];
  const at = (x: number, y: number) => fromLocal(anchor, [x, y]);
  return {
    venue: { id: "v", name: "L", anchor },
    levels: [{ id: "l1", name: "1 этаж", ordinal: 0 }],
    units: [
      {
        id: "corridor",
        levelId: "l1",
        name: "Коридор",
        category: "corridor",
        geometry: {
          type: "Polygon",
          coordinates: [[at(0, 0), at(20, 0), at(20, 3), at(3, 3), at(3, 20), at(0, 20), at(0, 0)]],
        },
      },
      {
        id: "locked",
        levelId: "l1",
        name: "Склад",
        category: "nonpublic",
        walkable: false,
        geometry: {
          type: "Polygon",
          coordinates: [[at(5, 5), at(9, 5), at(9, 9), at(5, 9), at(5, 5)]],
        },
      },
    ],
    pois: [
      { id: "a", levelId: "l1", name: "A", category: "other", position: at(18, 1.5) },
      { id: "b", levelId: "l1", name: "B", category: "other", position: at(1.5, 18) },
      { id: "c", levelId: "l1", name: "В складе", category: "other", position: at(7, 7) },
    ],
  };
}

describe("geometry rules", () => {
  it("bends around a concave corner and says where to turn", () => {
    const plan = lPlan();
    const g = buildNavGraph(plan);
    const route = findRoute(g, plan, { poiId: "a" }, { poiId: "b" });
    if (!route) throw new Error("no route");
    const ring = (plan.units?.[0]?.geometry.coordinates[0] ?? []).map((c) =>
      toLocal(plan.venue.anchor, c as LonLat),
    );
    for (let i = 1; i < route.path.length; i++) {
      expect(
        visibleInside(route.path[i - 1]?.xy ?? [0, 0], route.path[i]?.xy ?? [0, 0], ring),
      ).toBe(true);
    }
    expect(route.distanceM).toBeGreaterThan(Math.hypot(16.5, 16.5));
    expect(route.steps.find((s) => s.kind === "turn")?.text).toBe("Поверните направо");
  });

  it("does not route into rooms closed to visitors", () => {
    const plan = lPlan();
    const g = buildNavGraph(plan);
    expect(findRoute(g, plan, { poiId: "a" }, { poiId: "c" })).toBeNull();
    expect(unreachablePois(g, plan)).toEqual(["c"]);
  });
});

// Two buildings with an entrance each and a walkway across the yard between them.
function campus(): MapDocument {
  const anchor: LonLat = [37.62, 55.754];
  const at = (x: number, y: number) => fromLocal(anchor, [x, y]);
  const box = (x0: number, y0: number, x1: number, y1: number) => ({
    type: "Polygon" as const,
    coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]],
  });
  return {
    venue: { id: "c", name: "Кампус", anchor },
    levels: [{ id: "l1", name: "1 этаж", ordinal: 0 }],
    units: [
      { id: "a", levelId: "l1", name: "Корпус А", category: "hall", geometry: box(0, 0, 10, 10) },
      { id: "b", levelId: "l1", name: "Корпус Б", category: "hall", geometry: box(40, 0, 50, 10) },
    ],
    openings: [
      {
        id: "ea",
        levelId: "l1",
        category: "entrance",
        geometry: { type: "LineString", coordinates: [at(10, 4), at(10, 6)] },
      },
      {
        id: "eb",
        levelId: "l1",
        category: "entrance",
        geometry: { type: "LineString", coordinates: [at(40, 4), at(40, 6)] },
      },
    ],
    paths: [
      {
        id: "walk",
        geometry: { type: "LineString", coordinates: [at(11, 5), at(25, 12), at(39, 5)] },
      },
    ],
    pois: [
      { id: "pa", levelId: "l1", name: "Регистрация", category: "service", position: at(3, 5) },
      { id: "pb", levelId: "l1", name: "Зал Б", category: "stand", position: at(47, 5) },
    ],
  };
}

describe("walkways between buildings", () => {
  it("leaves one building, follows the walkway and enters the other", () => {
    const plan = campus();
    const route = findRoute(buildNavGraph(plan), plan, { poiId: "pa" }, { poiId: "pb" });
    if (!route) throw new Error("no route across the yard");
    // Along the bent walkway, not the straight 30 m gap.
    // The walkway bends north (31.3 m instead of 28 m straight), so the trip is over 44 + 3 m.
    expect(route.distanceM).toBeGreaterThan(47);
    expect(route.steps.some((s) => s.text.startsWith("Пройдите через дверь в «Корпус Б»"))).toBe(
      true,
    );
  });

  it("has no way across without the walkway", () => {
    const plan = { ...campus(), paths: [] };
    expect(findRoute(buildNavGraph(plan), plan, { poiId: "pa" }, { poiId: "pb" })).toBeNull();
  });
});

describe("3D walls", () => {
  it("leaves gaps where the doors are", async () => {
    const { wallFeatures } = await import("../walls");
    const plan = campus();
    const walls = wallFeatures(plan, "l1").features;
    // Two boxes: 4 walls each, the entrance wall of each split in two around its door.
    expect(walls).toHaveLength(10);
    expect(walls.every((w) => w.properties.height > 2)).toBe(true);
  });
});

describe("points placed in a panorama", () => {
  it("a floor click lands where the plan point projects from (round trip)", async () => {
    const { projectToPano, floorPointFromPano } = await import("../geo");
    const pose = { xy: [10, 10] as [number, number], headingDeg: 35, cameraHeightM: 1.5 };
    for (const point of [
      [14, 7],
      [3, 12],
      [10, 18],
    ] as [number, number][]) {
      const { yaw, pitch } = projectToPano(pose, point, 0);
      const back = floorPointFromPano(pose, yaw, pitch);
      expect(back?.[0]).toBeCloseTo(point[0], 6);
      expect(back?.[1]).toBeCloseTo(point[1], 6);
    }
  });
});

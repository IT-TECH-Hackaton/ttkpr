import type { Fixture, MapDocument, Opening } from "@ttkpr/api-client";
import { describe, expect, it } from "vitest";
import { fromLocal, type LonLat } from "./geo";
import {
  FIXTURE_HEIGHTS_M,
  fixtureFeatures,
  type WallPiece,
  wallFeatures,
  wallHeight,
  wallPieces,
  wallSegments,
} from "./walls";

const anchor: LonLat = [37.62, 55.754];
const at = (x: number, y: number) => fromLocal(anchor, [x, y]);
const box = (x0: number, y0: number, x1: number, y1: number) => ({
  type: "Polygon" as const,
  coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]],
});
const opening = (
  id: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  extra: Partial<Opening> = {},
): Opening => ({
  id,
  levelId: "l1",
  geometry: { type: "LineString", coordinates: [at(x0, y0), at(x1, y1)] },
  ...extra,
});

/** A 10 x 5 m room: a window in the south wall (x 2..4), a door in the north wall (x 6..7). */
function room(
  extra: { openings?: Opening[]; heightM?: number; fixtures?: Fixture[] } = {},
): MapDocument {
  return {
    venue: { id: "v", name: "Тест", anchor },
    levels: [{ id: "l1", name: "1 этаж", ordinal: 0, heightM: 3.5 }],
    units: [
      {
        id: "r",
        levelId: "l1",
        name: "Комната",
        category: "room",
        geometry: box(0, 0, 10, 5),
        ...(extra.heightM ? { heightM: extra.heightM } : {}),
      },
    ],
    openings: extra.openings ?? [
      opening("w", 2, 0, 4, 0, { category: "window" }),
      opening("d", 6, 5, 7, 5),
    ],
    fixtures: extra.fixtures ?? [],
  };
}

const south = (pieces: WallPiece[]) =>
  pieces.filter((p) => Math.abs(p.a[1]) < 1e-6 && Math.abs(p.b[1]) < 1e-6);
const span = (p: WallPiece) =>
  [Math.min(p.a[0], p.b[0]), Math.max(p.a[0], p.b[0])].map((v) => Math.round(v * 1000) / 1000);

describe("windows in 3D walls", () => {
  it("cuts a window between the sill and the lintel, doors stay open to the top", () => {
    const pieces = wallPieces(room(), "l1");
    const top = 3.5 - 0.4;
    const wall = south(pieces);
    expect(wall.map((p) => [p.kind, ...span(p), p.base, +p.top.toFixed(3)])).toEqual([
      ["wall", 0, 2, 0, top],
      ["sill", 2, 4, 0, 0.9],
      ["lintel", 2, 4, 2.1, top],
      ["wall", 4, 10, 0, top],
    ]);
    // North wall: the door is a full-height gap.
    const north = pieces.filter((p) => Math.abs(p.a[1] - 5) < 1e-6 && Math.abs(p.b[1] - 5) < 1e-6);
    expect(north.map(span).sort((x, y) => (x[0] as number) - (y[0] as number))).toEqual([
      [0, 6],
      [7, 10],
    ]);
    expect(north.every((p) => p.kind === "wall" && p.base === 0)).toBe(true);
  });

  it("keeps windows solid for the old segment list (textured walls)", () => {
    const segments = wallSegments(room(), "l1");
    // 4 walls, the north one split by the door; the window does not split the south wall.
    expect(segments).toHaveLength(5);
  });

  it("uses the window's own sill and height, and the room's own ceiling", () => {
    const french = room({
      heightM: 5,
      openings: [opening("w", 2, 0, 4, 0, { category: "window", sillHeightM: 0, heightM: 2.5 })],
    });
    expect(wallHeight(french, "r")).toBeCloseTo(4.6, 9);
    const wall = south(wallPieces(french, "l1"));
    // No piece under a floor-level window, a lintel from 2.5 m up to 4.6 m.
    expect(wall.map((p) => [p.kind, p.base, +p.top.toFixed(3)])).toEqual([
      ["wall", 0, 4.6],
      ["lintel", 2.5, 4.6],
      ["wall", 0, 4.6],
    ]);
    // A window up to the ceiling leaves no lintel either.
    const tall = room({
      openings: [opening("w", 2, 0, 4, 0, { category: "window", sillHeightM: 1, heightM: 4 })],
    });
    expect(south(wallPieces(tall, "l1")).map((p) => p.kind)).toEqual(["wall", "sill", "wall"]);
  });

  it("publishes base and height for fill-extrusion", () => {
    const walls = wallFeatures(room(), "l1").features;
    const lintel = walls.find((f) => f.properties.kind === "lintel");
    expect(lintel?.properties.base).toBeCloseTo(2.1, 9);
    expect(lintel?.properties.height).toBeCloseTo(3.1, 9);
    expect(
      walls.filter((f) => f.properties.kind === "wall").every((f) => f.properties.base === 0),
    ).toBe(true);
  });
});

describe("furniture in 3D", () => {
  it("gives every fixture a height: its own, a default by kind, columns to the ceiling", () => {
    const fixture = (id: string, kind: Fixture["kind"], extra: Partial<Fixture> = {}): Fixture => ({
      id,
      levelId: "l1",
      kind,
      geometry: box(1, 1, 2, 2),
      ...extra,
    });
    const doc = room({
      fixtures: [
        fixture("t", "table"),
        fixture("b", "booth", { heightM: 3, color: "#ff8800", name: "Стенд 1" }),
        fixture("c", "column"),
        fixture("s", "screen", { obstacle: false }),
        { ...fixture("x", "table"), levelId: "l2" },
      ],
    });
    const features = fixtureFeatures(doc, "l1").features;
    const props = Object.fromEntries(features.map((f) => [f.properties.id, f.properties]));
    expect(Object.keys(props)).toEqual(["t", "b", "c", "s"]);
    expect(props.t?.height).toBe(FIXTURE_HEIGHTS_M.table);
    expect(props.b).toMatchObject({ height: 3, color: "#ff8800", name: "Стенд 1", obstacle: true });
    expect(props.c?.height).toBeCloseTo(3.1, 9);
    expect(props.s?.obstacle).toBe(false);
    expect(props.t?.color).toBeUndefined();
  });
});

import type { MapDocument } from "@ttkpr/api-client";
import { toLocal } from "@ttkpr/map-core";
import { describe, expect, it } from "vitest";
import {
  applyRecognizedPlan,
  planCounts,
  type RecognizedPlan,
  suggestedWidthM,
} from "./planImport";

const square = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

const page = (floor: number | null) => ({
  width: 1000,
  height: 500,
  floor,
  imageUrl: `/media/maps/m/assets/plan-${floor}.webp`,
  sourcePage: floor ?? 1,
  rooms: [
    {
      ring: square(0, 0, 0.5, 1),
      name: "Зал",
      category: "hall" as const,
      center: [0.25, 0.5] as [number, number],
    },
    {
      ring: square(0.5, 0, 1, 1),
      name: null,
      category: "stairs" as const,
      center: [0.75, 0.5] as [number, number],
    },
  ],
  openings: [
    {
      a: [0.5, 0.4] as [number, number],
      b: [0.5, 0.6] as [number, number],
      category: "door" as const,
      rooms: [0, 1],
    },
    {
      a: [0.1, 0] as [number, number],
      b: [0.3, 0] as [number, number],
      category: "window" as const,
      rooms: [0],
    },
  ],
});

const plan: RecognizedPlan = {
  pages: [page(null), page(null)],
  connectors: [
    {
      kind: "stairs",
      rooms: [
        { page: 0, room: 1 },
        { page: 1, room: 1 },
      ],
    },
  ],
  metersPerPixel: 0.02,
  ocr: false,
  warnings: [],
};

const anchor: [number, number] = [37.62, 55.754];
const empty: MapDocument = {
  venue: { id: "v", name: "Тест", anchor },
  levels: [{ id: "l1", name: "1 этаж", ordinal: 0 }],
};

describe("applyRecognizedPlan", () => {
  const { doc, levelIds } = applyRecognizedPlan(empty, plan, { center: anchor, widthM: 20 });

  it("puts every page on its own floor, reusing the ground floor", () => {
    expect(levelIds[0]).toBe("l1");
    expect(doc.levels).toHaveLength(2);
    expect(doc.levels?.find((l) => l.id === levelIds[1])?.ordinal).toBe(1);
  });

  it("adds rooms, doors, windows and an underlay per floor at one scale", () => {
    expect(doc.units).toHaveLength(4);
    expect(doc.units?.[0]?.name).toBe("Зал");
    expect(doc.units?.[1]?.name).toBe("Лестница");
    expect(doc.openings?.map((o) => o.category)).toEqual(["door", "window", "door", "window"]);
    expect(doc.underlays).toHaveLength(2);
    // 20 m across the page: the hall (half the page) is 10 m wide.
    const ring = doc.units?.[0]?.geometry.coordinates[0] ?? [];
    const xs = ring.map((p) => toLocal(anchor, p as [number, number])[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 1);
  });

  it("joins the stairs of both floors", () => {
    const stairs = doc.connectors?.[0];
    expect(stairs?.kind).toBe("stairs");
    expect(stairs?.points.map((p) => p.levelId)).toEqual(levelIds);
  });

  it("summarises and suggests a width", () => {
    expect(planCounts(plan)).toEqual({ floors: 2, rooms: 4, doors: 2, windows: 2, stairs: 2 });
    expect(suggestedWidthM(plan)).toBe(20);
  });
});

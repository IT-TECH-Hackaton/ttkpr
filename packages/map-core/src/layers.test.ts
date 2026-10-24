import { createRequire } from "node:module";
import type { MapDocument } from "@ttkpr/api-client";
import type { Map as MapLibreMap } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { darkVariant } from "./color";
import { fromLocal, type LonLat } from "./geo";
import {
  DETAIL_LAYERS,
  detailLayers,
  FIXTURE_COLORS,
  fixtureFillExpression,
  openingColorExpression,
  planLayers,
  SOURCE,
  toCollections,
  UNIT_COLORS,
  unitFillExpression,
} from "./layers";
import { applyPlanTheme } from "./theme";

// MapLibre's own style validator and expression engine (a dependency of maplibre-gl).
const fromMaplibre = createRequire(
  createRequire(import.meta.url).resolve("maplibre-gl/package.json"),
);
const spec = fromMaplibre("@maplibre/maplibre-gl-style-spec") as {
  validateStyleMin: (style: unknown) => { message: string }[];
  latest: Record<string, Record<string, unknown>>;
  expression: {
    createPropertyExpression: (
      expression: unknown,
      rootKey: string,
      propertySpec: unknown,
    ) => {
      result: "success" | "error";
      value: { evaluate: (globals: unknown, feature: unknown) => unknown } | { message: string }[];
    };
  };
};

function evaluate(
  expression: unknown,
  layerType: string,
  property: string,
  properties: Record<string, unknown>,
) {
  const compiled = spec.expression.createPropertyExpression(
    expression,
    property,
    spec.latest[`paint_${layerType}`]?.[property],
  );
  if (compiled.result !== "success") throw new Error(JSON.stringify(compiled.value));
  const color = (compiled.value as { evaluate: (g: unknown, f: unknown) => unknown }).evaluate(
    { zoom: 19 },
    { type: "Polygon", properties },
  ) as { r: number; g: number; b: number };
  const hex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
}

const anchor: LonLat = [37.62, 55.754];
const at = (x: number, y: number) => fromLocal(anchor, [x, y]);
const box = (x0: number, y0: number, x1: number, y1: number) => ({
  type: "Polygon" as const,
  coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]],
});

const doc: MapDocument = {
  venue: { id: "v", name: "Тест", anchor },
  levels: [{ id: "l1", name: "1 этаж", ordinal: 0 }],
  units: [
    { id: "plain", levelId: "l1", category: "hall", geometry: box(0, 0, 10, 10) },
    { id: "pink", levelId: "l1", category: "room", color: "#ffc0cb", geometry: box(10, 0, 20, 10) },
    {
      id: "staff",
      levelId: "l1",
      category: "room",
      access: "staff",
      color: "#ffc0cb",
      geometry: box(20, 0, 30, 10),
    },
  ],
  openings: [
    {
      id: "door",
      levelId: "l1",
      geometry: { type: "LineString", coordinates: [at(10, 4), at(10, 5)] },
    },
    {
      id: "staff-door",
      levelId: "l1",
      access: "staff",
      kind: "single",
      geometry: { type: "LineString", coordinates: [at(20, 4), at(20, 5)] },
    },
  ],
  zones: [{ id: "z", levelId: "l1", name: "Фудкорт", color: "#22c55e", geometry: box(1, 1, 5, 5) }],
  fixtures: [
    { id: "t", levelId: "l1", kind: "table", geometry: box(6, 6, 7, 7) },
    {
      id: "b",
      levelId: "l1",
      kind: "booth",
      color: "#3366ff",
      name: "Стенд 1",
      geometry: box(12, 2, 14, 4),
    },
  ],
};

describe("plan layers", () => {
  it("is a valid MapLibre style with the plan and the detail layers", () => {
    const sources = Object.fromEntries(
      Object.values(SOURCE).map((id) => [
        id,
        { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      ]),
    );
    const errors = spec.validateStyleMin({
      version: 8,
      glyphs: "https://example.com/{fontstack}/{range}.pbf",
      sources,
      layers: [...planLayers("l1"), ...detailLayers("l1")],
    });
    expect(errors.map((e) => e.message)).toEqual([]);
    expect(detailLayers("l1").map((l) => l.id)).toEqual([...DETAIL_LAYERS]);
  });

  it("colours rooms by the organizer's colour, closed rooms as non-public", () => {
    const light = unitFillExpression(UNIT_COLORS, "#eeeeee");
    expect(evaluate(light, "fill", "fill-color", { category: "hall" })).toBe(UNIT_COLORS.hall);
    expect(evaluate(light, "fill", "fill-color", { category: "room", color: "#ffc0cb" })).toBe(
      "#ffc0cb",
    );
    expect(
      evaluate(light, "fill", "fill-color", {
        category: "room",
        color: "#ffc0cb",
        access: "closed",
      }),
    ).toBe(UNIT_COLORS.nonpublic);
    const dark = unitFillExpression({ ...UNIT_COLORS, room: "#1f2a3a" }, "#222831", true);
    expect(
      evaluate(dark, "fill", "fill-color", {
        category: "room",
        color: "#ffc0cb",
        colorDark: darkVariant("#ffc0cb"),
      }),
    ).toBe(darkVariant("#ffc0cb"));
  });

  it("marks windows, emergency exits and closed doors", () => {
    const color = openingColorExpression("#ffffff");
    const of = (properties: Record<string, unknown>) =>
      evaluate(color, "line", "line-color", properties);
    expect(of({ category: "door" })).toBe("#ffffff");
    expect(of({ category: "window" })).toBe("#7dd3fc");
    expect(of({ category: "entrance", access: "emergency" })).toBe("#22c55e");
    expect(of({ category: "door", access: "locked" })).toBe("#9ca3af");
  });

  it("fills furniture by kind unless it has a colour", () => {
    expect(evaluate(fixtureFillExpression(), "fill", "fill-color", { category: "table" })).toBe(
      FIXTURE_COLORS.table,
    );
    expect(
      evaluate(fixtureFillExpression(), "fill", "fill-color", {
        category: "booth",
        color: "#3366ff",
      }),
    ).toBe("#3366ff");
    expect(evaluate(fixtureFillExpression(true), "fill", "fill-color", { category: "table" })).toBe(
      darkVariant(FIXTURE_COLORS.table as string),
    );
  });

  it("puts the new properties into the collections only when set", () => {
    const c = toCollections(doc);
    const units = Object.fromEntries(c.units.features.map((f) => [f.properties.id, f.properties]));
    expect(units.plain).toEqual({ id: "plain", levelId: "l1", name: "", category: "hall" });
    expect(units.pink).toMatchObject({ color: "#ffc0cb", colorDark: darkVariant("#ffc0cb") });
    expect(units.staff?.access).toBe("staff");
    const doors = Object.fromEntries(
      c.openings.features.map((f) => [f.properties.id, f.properties]),
    );
    expect(doors.door).toEqual({ id: "door", levelId: "l1", name: "", category: "door" });
    expect(doors["staff-door"]).toMatchObject({ access: "staff", kind: "single" });
    expect(c.zones.features.map((f) => f.properties)).toEqual([
      {
        id: "z",
        levelId: "l1",
        name: "Фудкорт",
        category: "zone",
        color: "#22c55e",
        colorDark: darkVariant("#22c55e"),
      },
    ]);
    expect(
      c.fixtures.features.map((f) => [
        f.properties.id,
        f.properties.category,
        f.properties.obstacle,
      ]),
    ).toEqual([
      ["t", "table", true],
      ["b", "booth", true],
    ]);
    // A plan without the new collections still gives empty ones.
    const bare = toCollections({ venue: doc.venue });
    expect(bare.zones.features).toEqual([]);
    expect(bare.fixtures.features).toEqual([]);
  });
});

describe("theme", () => {
  it("sets only valid paint values, also on the detail layers", () => {
    for (const dark of [false, true]) {
      const layers = new Map(
        [...planLayers("l1"), ...detailLayers("l1")].map((l) => [l.id, l.type as string]),
      );
      layers.set("background", "background");
      const calls: [string, string, unknown][] = [];
      const map = {
        getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
        setPaintProperty: (layer: string, property: string, value: unknown) =>
          calls.push([layer, property, value]),
      } as unknown as MapLibreMap;
      applyPlanTheme(map, dark);
      expect(calls.some(([layer]) => layer === "fixtures-fill")).toBe(true);
      for (const [layer, property, value] of calls) {
        const propertySpec = spec.latest[`paint_${layers.get(layer)}`]?.[property];
        expect(propertySpec, `${layer} ${property}`).toBeDefined();
        const compiled = spec.expression.createPropertyExpression(value, property, propertySpec);
        expect(compiled.result, `${layer} ${property}: ${JSON.stringify(compiled.value)}`).toBe(
          "success",
        );
      }
    }
  });
});

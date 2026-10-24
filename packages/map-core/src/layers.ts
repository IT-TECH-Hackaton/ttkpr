import type { Feature, FeatureCollection, LineString, Point, Polygon } from "geojson";
import type { AddLayerObject, ExpressionSpecification, FilterSpecification } from "maplibre-gl";
import type { MapBundle } from "./bundle";
import { darkVariant } from "./color";

export const SOURCE = {
  units: "plan-units",
  openings: "plan-openings",
  pois: "plan-pois",
  panos: "plan-panos",
  connectors: "plan-connectors",
  paths: "plan-paths",
  /** Labelled areas inside rooms; layers: `detailLayers`. */
  zones: "plan-zones",
  /** Furniture (tables, booths, a stage); layers: `detailLayers`. */
  fixtures: "plan-fixtures",
} as const;

export const CONNECTOR_LABELS: Record<string, string> = {
  stairs: "Лестница",
  elevator: "Лифт",
  escalator: "Эскалатор",
  ramp: "Пандус",
};

export const PLAN_FONT = ["Noto Sans Regular"];

/** Dev default; production serves its own glyphs (Cyrillic ranges) from the CDN. */
export const DEFAULT_GLYPHS =
  "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf";

interface PlanProps {
  id: string;
  levelId: string;
  name: string;
  category: string;
  /** Organizer's fill (#rrggbb) and its dark-theme counterpart; absent = by category. */
  color?: string;
  colorDark?: string;
  /** Rooms and doors closed to visitors (absent = public). */
  access?: string;
  /** Door type (openings). */
  kind?: string;
  /** Fixtures: routes go around it. */
  obstacle?: boolean;
}

export interface PlanCollections {
  units: FeatureCollection<Polygon, PlanProps>;
  openings: FeatureCollection<LineString, PlanProps>;
  pois: FeatureCollection<Point, PlanProps>;
  panos: FeatureCollection<Point, PlanProps>;
  connectors: FeatureCollection<Point, PlanProps>;
  paths: FeatureCollection<LineString, PlanProps>;
  /** `category` is "zone". */
  zones: FeatureCollection<Polygon, PlanProps>;
  /** `category` is the fixture kind. */
  fixtures: FeatureCollection<Polygon, PlanProps>;
}

const colors = (color: string | null | undefined) =>
  color ? { color, colorDark: darkVariant(color) } : {};
const restricted = (access: string | null | undefined) =>
  access && access !== "public" ? { access } : {};

function collection<G extends Polygon | LineString | Point>(
  features: Feature<G, PlanProps>[],
): FeatureCollection<G, PlanProps> {
  return { type: "FeatureCollection", features };
}

export function toCollections(bundle: MapBundle): PlanCollections {
  return {
    units: collection(
      (bundle.units ?? []).map((u) => ({
        type: "Feature",
        id: u.id,
        geometry: { type: "Polygon", coordinates: u.geometry.coordinates },
        properties: {
          id: u.id,
          levelId: u.levelId,
          name: u.name ?? "",
          category: u.category,
          ...colors(u.color),
          ...restricted(u.access),
        },
      })),
    ),
    openings: collection(
      (bundle.openings ?? []).map((o) => ({
        type: "Feature",
        id: o.id,
        geometry: { type: "LineString", coordinates: o.geometry.coordinates },
        properties: {
          id: o.id,
          levelId: o.levelId,
          name: "",
          category: o.category ?? "door",
          ...restricted(o.access),
          ...(o.kind ? { kind: o.kind } : {}),
        },
      })),
    ),
    pois: collection(
      (bundle.pois ?? []).map((p) => ({
        type: "Feature",
        id: p.id,
        geometry: { type: "Point", coordinates: p.position },
        properties: { id: p.id, levelId: p.levelId, name: p.name, category: p.category },
      })),
    ),
    panos: collection(
      (bundle.panos ?? []).map((p) => ({
        type: "Feature",
        id: p.id,
        geometry: { type: "Point", coordinates: p.position },
        properties: { id: p.id, levelId: p.levelId, name: "", category: "pano" },
      })),
    ),
    // One point per level the stairs/lift serves.
    connectors: collection(
      (bundle.connectors ?? []).flatMap((c) =>
        c.points.map((pt) => ({
          type: "Feature" as const,
          id: `${c.id}@${pt.levelId}`,
          geometry: { type: "Point" as const, coordinates: pt.position },
          properties: {
            id: c.id,
            levelId: pt.levelId,
            name: c.name ?? CONNECTOR_LABELS[c.kind] ?? "",
            category: c.kind,
          },
        })),
      ),
    ),
    // Walkways without a level are outdoor: shown with the ground floor.
    paths: collection(
      (bundle.paths ?? []).map((path) => ({
        type: "Feature" as const,
        id: path.id,
        geometry: { type: "LineString" as const, coordinates: path.geometry.coordinates },
        properties: {
          id: path.id,
          levelId: path.levelId ?? groundLevelId(bundle),
          name: "",
          category: "path",
        },
      })),
    ),
    zones: collection(
      (bundle.zones ?? []).map((z) => ({
        type: "Feature" as const,
        id: z.id,
        geometry: { type: "Polygon" as const, coordinates: z.geometry.coordinates },
        properties: {
          id: z.id,
          levelId: z.levelId,
          name: z.name,
          category: "zone",
          ...colors(z.color),
        },
      })),
    ),
    fixtures: collection(
      (bundle.fixtures ?? []).map((f) => ({
        type: "Feature" as const,
        id: f.id,
        geometry: { type: "Polygon" as const, coordinates: f.geometry.coordinates },
        properties: {
          id: f.id,
          levelId: f.levelId,
          name: f.name ?? "",
          category: f.kind,
          obstacle: f.obstacle !== false,
          ...colors(f.color),
        },
      })),
    ),
  };
}

/** The level closest to the ground (ordinal 0), where outdoor walkways are drawn. */
export function groundLevelId(bundle: MapBundle): string {
  const levels = [...(bundle.levels ?? [])].sort(
    (a, b) => Math.abs(a.ordinal) - Math.abs(b.ordinal),
  );
  return levels[0]?.id ?? "";
}

export const UNIT_COLORS: Record<string, string> = {
  room: "#e8eef7",
  hall: "#dfe9fb",
  corridor: "#f7f7f5",
  lobby: "#fdf3dc",
  restroom: "#e6f4ef",
  stairs: "#ece7f6",
  elevator: "#ece7f6",
  outdoor: "#e7f2e1",
  nonpublic: "#e4e4e4",
};

const onLevel = (levelId: string): ExpressionSpecification => ["==", ["get", "levelId"], levelId];

// Label/value pairs are spread dynamically, which the style-spec tuple type cannot express.
const expression = (value: unknown[]) => value as unknown as ExpressionSpecification;

/**
 * Room fill: rooms closed to visitors in the non-public colour, else the organizer's colour,
 * else by category. `dark` reads the precomputed dark counterpart of the organizer's colour.
 */
export function unitFillExpression(
  colors: Record<string, string>,
  fallback: string,
  dark = false,
): ExpressionSpecification {
  const byCategory = ["match", ["get", "category"], ...Object.entries(colors).flat(), fallback];
  return expression([
    "case",
    ["in", ["coalesce", ["get", "access"], "public"], ["literal", ["staff", "closed"]]],
    colors.nonpublic ?? fallback,
    ["to-color", ["get", dark ? "colorDark" : "color"], byCategory],
  ]);
}

const OPENING_COLORS = { window: "#7dd3fc", emergency: "#22c55e", closed: "#9ca3af" };
const OPENING_COLORS_DARK = { window: "#0e7490", emergency: "#15803d", closed: "#4b5563" };

/** Openings: windows light blue, emergency exits green, staff/locked doors grey, others `base`. */
export function openingColorExpression(base: string, dark = false): ExpressionSpecification {
  const c = dark ? OPENING_COLORS_DARK : OPENING_COLORS;
  return expression([
    "match",
    ["get", "category"],
    "window",
    c.window,
    [
      "match",
      ["coalesce", ["get", "access"], "public"],
      "public",
      base,
      "emergency",
      c.emergency,
      c.closed,
    ],
  ]);
}

/** Furniture fill by kind when the organizer gave no colour. */
export const FIXTURE_COLORS: Record<string, string> = {
  table: "#dccbab",
  booth: "#c7d2fe",
  stage: "#e9d5ff",
  counter: "#d1d5db",
  seating: "#fde68a",
  screen: "#64748b",
  plant: "#86efac",
  column: "#9ca3af",
  shelf: "#dccbab",
  kiosk: "#bae6fd",
  other: "#e5e7eb",
};

export function fixtureFillExpression(dark = false): ExpressionSpecification {
  const palette = Object.entries(FIXTURE_COLORS).map(([k, v]) => [k, dark ? darkVariant(v) : v]);
  const byKind = ["match", ["get", "category"], ...palette.flat(), dark ? "#334155" : "#e5e7eb"];
  return expression(["to-color", ["get", dark ? "colorDark" : "color"], byKind]);
}

/** Zones without their own colour. */
export const ZONE_COLOR = "#f59e0b";

/** All plan layers for one level; switch levels with setFilter(layerId, levelFilter(...)). */
export function planLayers(levelId: string): AddLayerObject[] {
  const filter = levelFilter("units-fill", levelId);
  const unitColor = unitFillExpression(UNIT_COLORS, "#eeeeee");

  return [
    {
      id: "units-fill",
      type: "fill",
      source: SOURCE.units,
      filter,
      paint: { "fill-color": unitColor, "fill-opacity": 1 },
    },
    {
      id: "units-outline",
      type: "line",
      source: SOURCE.units,
      filter,
      paint: {
        "line-color": "#5b6577",
        "line-width": ["interpolate", ["linear"], ["zoom"], 17, 1, 21, 3],
      },
    },
    {
      id: "paths",
      type: "line",
      source: SOURCE.paths,
      filter,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#c8b68f",
        "line-width": ["interpolate", ["linear"], ["zoom"], 17, 3, 21, 10],
        "line-dasharray": [2, 1],
      },
    },
    {
      id: "openings",
      type: "line",
      source: SOURCE.openings,
      filter,
      paint: {
        "line-color": openingColorExpression("#ffffff"),
        "line-width": ["interpolate", ["linear"], ["zoom"], 17, 2, 21, 6],
      },
    },
    {
      id: "units-label",
      type: "symbol",
      source: SOURCE.units,
      filter: levelFilter("units-label", levelId),
      layout: {
        "text-field": ["get", "name"],
        "text-font": PLAN_FONT,
        "text-size": 12,
        "text-max-width": 8,
      },
      paint: { "text-color": "#5b6577", "text-halo-color": "#ffffff", "text-halo-width": 1 },
    },
    {
      id: "connectors",
      type: "circle",
      source: SOURCE.connectors,
      filter,
      paint: {
        "circle-radius": 9,
        "circle-color": "#7c3aed",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    },
    {
      id: "connectors-label",
      type: "symbol",
      source: SOURCE.connectors,
      filter,
      layout: {
        "text-field": ["get", "name"],
        "text-font": PLAN_FONT,
        "text-size": 11,
        "text-offset": [0, 1.3],
        "text-anchor": "top",
        "text-optional": true,
      },
      paint: { "text-color": "#5b21b6", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
    },
    {
      id: "panos",
      type: "circle",
      source: SOURCE.panos,
      filter,
      paint: {
        "circle-radius": 6,
        "circle-color": "#0f766e",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    },
    {
      id: "pois",
      type: "circle",
      source: SOURCE.pois,
      filter,
      paint: {
        "circle-radius": 8,
        "circle-color": "#2563eb",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    },
    {
      id: "pois-label",
      type: "symbol",
      source: SOURCE.pois,
      filter,
      layout: {
        "text-field": ["get", "name"],
        "text-font": PLAN_FONT,
        "text-size": 13,
        "text-offset": [0, 1.2],
        "text-anchor": "top",
        "text-optional": true,
      },
      paint: { "text-color": "#1e3a8a", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
    },
  ];
}

export const LEVEL_FILTERED_LAYERS = [
  "units-fill",
  "units-outline",
  "paths",
  "openings",
  "units-label",
  "connectors",
  "connectors-label",
  "panos",
  "pois",
  "pois-label",
] as const;

/**
 * Zones and furniture of one level. Needs the sources `SOURCE.zones` and `SOURCE.fixtures`
 * (`toCollections`); add the layers above the rooms, before "paths". Switch levels like the
 * plan layers, with `levelFilter` over `DETAIL_LAYERS`.
 */
export function detailLayers(levelId: string): AddLayerObject[] {
  const filter = levelFilter("zones-fill", levelId);
  const zoneColor = expression(["to-color", ["get", "color"], ZONE_COLOR]);
  const thin = expression(["interpolate", ["linear"], ["zoom"], 17, 0.5, 21, 2]);
  return [
    {
      id: "zones-fill",
      type: "fill",
      source: SOURCE.zones,
      filter,
      paint: { "fill-color": zoneColor, "fill-opacity": 0.16 },
    },
    {
      id: "zones-outline",
      type: "line",
      source: SOURCE.zones,
      filter,
      paint: { "line-color": zoneColor, "line-width": thin, "line-dasharray": [3, 2] },
    },
    {
      id: "fixtures-fill",
      type: "fill",
      source: SOURCE.fixtures,
      filter,
      paint: { "fill-color": fixtureFillExpression(), "fill-opacity": 0.95 },
    },
    {
      id: "fixtures-outline",
      type: "line",
      source: SOURCE.fixtures,
      filter,
      paint: { "line-color": "#94a3b8", "line-width": thin },
    },
    {
      id: "zones-label",
      type: "symbol",
      source: SOURCE.zones,
      filter,
      layout: {
        "text-field": ["get", "name"],
        "text-font": PLAN_FONT,
        "text-size": 12,
        "text-max-width": 8,
        "text-optional": true,
      },
      paint: { "text-color": "#92400e", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
    },
    {
      id: "fixtures-label",
      type: "symbol",
      source: SOURCE.fixtures,
      filter,
      minzoom: 19.5,
      layout: {
        "text-field": ["get", "name"],
        "text-font": PLAN_FONT,
        "text-size": 10,
        "text-max-width": 6,
        "text-optional": true,
      },
      paint: { "text-color": "#475569", "text-halo-color": "#ffffff", "text-halo-width": 1 },
    },
  ];
}

export const DETAIL_LAYERS = [
  "zones-fill",
  "zones-outline",
  "fixtures-fill",
  "fixtures-outline",
  "zones-label",
  "fixtures-label",
] as const;

export function levelFilter(layerId: string, levelId: string): FilterSpecification {
  const base = onLevel(levelId);
  return layerId === "units-label" ? ["all", base, ["!=", ["get", "category"], "corridor"]] : base;
}

/** [[west, south], [east, north]] of all units, for fitBounds. */
export function bundleBounds(bundle: MapBundle): [[number, number], [number, number]] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const unit of bundle.units ?? []) {
    for (const ring of unit.geometry.coordinates) {
      for (const [lon, lat] of ring) {
        west = Math.min(west, lon);
        south = Math.min(south, lat);
        east = Math.max(east, lon);
        north = Math.max(north, lat);
      }
    }
  }
  return Number.isFinite(west)
    ? [
        [west, south],
        [east, north],
      ]
    : null;
}

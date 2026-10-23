import type { ExpressionSpecification, Map as MapLibreMap } from "maplibre-gl";
import { UNIT_COLORS } from "./layers";

/** Dark counterparts of UNIT_COLORS: same hues, low lightness, so categories stay readable. */
export const UNIT_COLORS_DARK: Record<string, string> = {
  room: "#1f2a3a",
  hall: "#1c2b45",
  corridor: "#232831",
  lobby: "#3a3220",
  restroom: "#1d3330",
  stairs: "#2c2640",
  elevator: "#2c2640",
  outdoor: "#1f3322",
  nonpublic: "#2a2a2a",
};

interface PlanPalette {
  background: string;
  units: Record<string, string>;
  unitFallback: string;
  outline: string;
  opening: string;
  unitLabel: string;
  halo: string;
  poiLabel: string;
  connectorLabel: string;
  markerStroke: string;
}

const LIGHT: PlanPalette = {
  background: "#eef1f5",
  units: UNIT_COLORS,
  unitFallback: "#eeeeee",
  outline: "#5b6577",
  opening: "#ffffff",
  unitLabel: "#5b6577",
  halo: "#ffffff",
  poiLabel: "#1e3a8a",
  connectorLabel: "#5b21b6",
  markerStroke: "#ffffff",
};

const DARK: PlanPalette = {
  background: "#0b0f17",
  units: UNIT_COLORS_DARK,
  unitFallback: "#222831",
  outline: "#8391a7",
  opening: "#0b0f17",
  unitLabel: "#a3afc2",
  halo: "#0b0f17",
  poiLabel: "#bfdbfe",
  connectorLabel: "#ddd6fe",
  markerStroke: "#0b0f17",
};

export const planPalette = (dark: boolean) => (dark ? DARK : LIGHT);

/** Recolours the plan layers in place (no reload); layers that do not exist are skipped. */
export function applyPlanTheme(map: MapLibreMap, dark: boolean) {
  const p = planPalette(dark);
  const unitColor = [
    "match",
    ["get", "category"],
    ...Object.entries(p.units).flat(),
    p.unitFallback,
  ] as unknown as ExpressionSpecification;
  type Paint = Parameters<MapLibreMap["setPaintProperty"]>;
  const set = (layer: string, prop: Paint[1], value: Paint[2]) => {
    if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value);
  };
  set("background", "background-color", p.background);
  set("units-fill", "fill-color", unitColor);
  set("units-outline", "line-color", p.outline);
  set("openings", "line-color", p.opening);
  set("paths", "line-color", dark ? "#6b5d3f" : "#c8b68f");
  set("units-label", "text-color", p.unitLabel);
  for (const layer of ["units-label", "pois-label", "connectors-label", "route-marks-label"]) {
    set(layer, "text-halo-color", p.halo);
  }
  set("pois-label", "text-color", p.poiLabel);
  set("connectors-label", "text-color", p.connectorLabel);
  for (const layer of ["pois", "panos", "connectors", "route-marks"]) {
    set(layer, "circle-stroke-color", p.markerStroke);
  }
  set("route-casing", "line-color", dark ? "#0b0f17" : "#ffffff");
  set("walls-3d", "fill-extrusion-color", dark ? "#475569" : "#cbd5e1");
  set("route-marks-label", "text-color", [
    "match",
    ["get", "kind"],
    "here",
    dark ? "#86efac" : "#166534",
    "floor",
    dark ? "#ddd6fe" : "#5b21b6",
    dark ? "#e5e7eb" : "#111827",
  ]);
}

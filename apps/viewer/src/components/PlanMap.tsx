import {
  applyPlanTheme,
  bundleBounds,
  DEFAULT_GLYPHS,
  LEVEL_FILTERED_LAYERS,
  type LonLat,
  levelFilter,
  type MapBundle,
  PLAN_FONT,
  planLayers,
  type Route,
  SOURCE,
  syncUnderlays,
  toCollections,
  wallFeatures,
} from "@ttkpr/map-core";
import { useTheme } from "@ttkpr/ui";
import type { GeoJSONSource } from "maplibre-gl";
import { type ExpressionSpecification, Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { legBounds, routeFeatures } from "../lib/routing";

interface Props {
  bundle: MapBundle;
  levelId: string;
  selectedPoiId?: string;
  route?: Route | null;
  /** "Вы здесь" POI from a QR sign. */
  hereId?: string;
  /** An organizer's tour: numbered stops. */
  numbered?: boolean;
  /** Tilted view with walls (fill-extrusion), doors left open. */
  threeD?: boolean;
  /** Next tap picks a route end: panoramas are not hit-tested, the cursor is a crosshair. */
  picking?: boolean;
  /** Pan to a point (a route step); `n` changes on every request. */
  focus?: { position: LonLat; n: number };
  /** Pixels covered by overlays, so the selection and the route stay visible. */
  topInset: number;
  bottomInset: number;
  /** The side panel on wide screens. */
  leftInset?: number;
  onSelectPoi: (id: string) => void;
  onSelectPano: (id: string) => void;
  onBackgroundTap: (position: LonLat) => void;
}

// Bigger invisible circles: finger-sized hit targets for small markers.
const HIT_LAYERS = ["pois-hit", "panos-hit"] as const;
const ROUTE_SOURCE = "route-lines";
const WALLS_SOURCE = "walls-3d";
const MARKS_SOURCE = "route-marks";
const ROUTE_LAYERS = [
  "route-casing",
  "route-line",
  "route-here-halo",
  "route-marks",
  "route-marks-label",
  "route-marks-number",
];

// The level switcher sits on the right.
const RIGHT_INSET = 64;
// Breathing room around a fitted route, on top of the map's own padding (the overlays).
const FIT_PADDING = 24;

function selectedFilter(id: string | undefined): ExpressionSpecification {
  return ["==", ["get", "id"], id ?? ""];
}

export function PlanMap({
  bundle,
  levelId,
  selectedPoiId,
  route,
  hereId,
  numbered = false,
  threeD = false,
  picking,
  focus,
  topInset,
  bottomInset,
  leftInset = 16,
  onSelectPoi,
  onSelectPano,
  onBackgroundTap,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const handlers = useRef({ onSelectPoi, onSelectPano, onBackgroundTap, picking });
  handlers.current = { onSelectPoi, onSelectPano, onBackgroundTap, picking };
  const initialLevel = useRef(levelId);
  const { dark } = useTheme();
  const darkRef = useRef(dark);
  darkRef.current = dark;

  useEffect(() => {
    if (!containerRef.current) return;
    const bounds = bundleBounds(bundle);
    const map = new MapLibreMap({
      container: containerRef.current,
      style: {
        version: 8,
        glyphs: DEFAULT_GLYPHS,
        sources: {},
        layers: [
          { id: "background", type: "background", paint: { "background-color": "#eef1f5" } },
        ],
      },
      ...(bounds ? { bounds, fitBoundsOptions: { padding: 32 } } : {}),
      maxZoom: 23,
      maxPitch: 70,
      attributionControl: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) (window as unknown as { planMap?: MapLibreMap }).planMap = map;

    map.on("load", () => {
      const collections = toCollections(bundle);
      map.addSource(SOURCE.units, { type: "geojson", data: collections.units });
      map.addSource(SOURCE.openings, { type: "geojson", data: collections.openings });
      map.addSource(SOURCE.pois, { type: "geojson", data: collections.pois });
      map.addSource(SOURCE.panos, { type: "geojson", data: collections.panos });
      map.addSource(SOURCE.connectors, { type: "geojson", data: collections.connectors });
      map.addSource(SOURCE.paths, { type: "geojson", data: collections.paths });
      for (const layer of planLayers(initialLevel.current)) map.addLayer(layer);
      syncUnderlays(map, bundle.underlays ?? [], initialLevel.current);

      const filter = levelFilter("pois", initialLevel.current);
      map.addLayer({
        id: "pois-selected",
        type: "circle",
        source: SOURCE.pois,
        filter: selectedFilter(undefined),
        paint: {
          "circle-radius": 13,
          "circle-color": "#2563eb",
          "circle-opacity": 0.25,
          "circle-stroke-color": "#2563eb",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "pois-hit",
        type: "circle",
        source: SOURCE.pois,
        filter,
        paint: { "circle-radius": 22, "circle-opacity": 0 },
      });
      map.addLayer({
        id: "panos-hit",
        type: "circle",
        source: SOURCE.panos,
        filter,
        paint: { "circle-radius": 20, "circle-opacity": 0 },
      });

      map.addSource(WALLS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer(
        {
          id: "walls-3d",
          type: "fill-extrusion",
          source: WALLS_SOURCE,
          layout: { visibility: "none" },
          paint: {
            "fill-extrusion-color": "#cbd5e1",
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-opacity": 0.9,
          },
        },
        "connectors",
      );

      // The route runs over rooms but under stairs, panoramas and places; its marks go on top.
      const empty = { type: "FeatureCollection" as const, features: [] };
      map.addSource(ROUTE_SOURCE, { type: "geojson", data: empty });
      map.addSource(MARKS_SOURCE, { type: "geojson", data: empty });
      const width = (min: number, max: number): ExpressionSpecification => [
        "interpolate",
        ["exponential", 1.6],
        ["zoom"],
        17,
        min,
        22,
        max,
      ];
      map.addLayer(
        {
          id: "route-casing",
          type: "line",
          source: ROUTE_SOURCE,
          filter,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#ffffff", "line-width": width(6, 18) },
        },
        "connectors",
      );
      map.addLayer(
        {
          id: "route-line",
          type: "line",
          source: ROUTE_SOURCE,
          filter,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#2563eb", "line-width": width(3.5, 11) },
        },
        "connectors",
      );
      const kind = (values: Record<string, number | string>, fallback: number | string) =>
        [
          "match",
          ["get", "kind"],
          ...Object.entries(values).flat(),
          fallback,
        ] as unknown as ExpressionSpecification;
      map.addLayer({
        id: "route-here-halo",
        type: "circle",
        source: MARKS_SOURCE,
        filter,
        paint: {
          "circle-radius": kind({ here: 22 }, 0),
          "circle-color": "#16a34a",
          "circle-opacity": 0.18,
        },
      });
      map.addLayer({
        id: "route-marks",
        type: "circle",
        source: MARKS_SOURCE,
        filter,
        paint: {
          "circle-radius": kind({ end: 10, here: 9, floor: 9, stop: 10 }, 8),
          "circle-color": kind(
            {
              start: "#16a34a",
              here: "#16a34a",
              end: "#dc2626",
              floor: "#7c3aed",
              stop: "#2563eb",
            },
            "#2563eb",
          ),
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3,
        },
      });
      map.addLayer({
        id: "route-marks-label",
        type: "symbol",
        source: MARKS_SOURCE,
        filter,
        layout: {
          // Captions ("Вы здесь", "↑ 2 этаж") above the mark; tour numbers go inside it.
          "text-field": ["match", ["get", "kind"], ["here", "floor"], ["get", "label"], ""],
          "text-font": PLAN_FONT,
          "text-size": 13,
          "text-offset": [0, -1.3],
          "text-anchor": "bottom",
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": kind({ here: "#166534", floor: "#5b21b6" }, "#111827"),
          "text-halo-color": "#ffffff",
          "text-halo-width": 2,
        },
      });
      map.addLayer({
        id: "route-marks-number",
        type: "symbol",
        source: MARKS_SOURCE,
        filter,
        layout: {
          "text-field": ["match", ["get", "kind"], ["start", "stop", "end"], ["get", "label"], ""],
          "text-font": PLAN_FONT,
          "text-size": 12,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": "#ffffff" },
      });
    });

    map.once("load", () => applyPlanTheme(map, darkRef.current));

    map.on("click", (event) => {
      const { picking } = handlers.current;
      const layers = picking ? ["pois-hit"] : [...HIT_LAYERS];
      const hit = map.queryRenderedFeatures(event.point, { layers })[0];
      const id = hit?.properties?.id as string | undefined;
      if (!hit || !id) handlers.current.onBackgroundTap(event.lngLat.toArray() as LonLat);
      else if (hit.layer.id === "pois-hit") handlers.current.onSelectPoi(id);
      else handlers.current.onSelectPano(id);
    });

    // Restore after iOS drops the WebGL context under memory pressure.
    map.getCanvas().addEventListener("webglcontextlost", (event) => event.preventDefault());

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [bundle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      for (const layer of [...LEVEL_FILTERED_LAYERS, ...HIT_LAYERS, ...ROUTE_LAYERS]) {
        if (map.getLayer(layer)) map.setFilter(layer, levelFilter(layer, levelId));
      }
      syncUnderlays(map, bundle.underlays ?? [], levelId);
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [levelId, bundle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const { lines, marks } = routeFeatures(bundle, route ?? null, hereId, numbered);
      map.getSource<GeoJSONSource>(ROUTE_SOURCE)?.setData(lines);
      map.getSource<GeoJSONSource>(MARKS_SOURCE)?.setData(marks);
    };
    if (map.getSource(ROUTE_SOURCE)) apply();
    else map.once("load", apply);
  }, [bundle, route, hereId, numbered]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.isStyleLoaded()) applyPlanTheme(map, dark);
  }, [dark]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (!map.getLayer("walls-3d")) return;
      if (threeD)
        map.getSource<GeoJSONSource>(WALLS_SOURCE)?.setData(wallFeatures(bundle, levelId));
      map.setLayoutProperty("walls-3d", "visibility", threeD ? "visible" : "none");
      map.easeTo(
        threeD
          ? { pitch: 55, bearing: -20, duration: 600 }
          : { pitch: 0, bearing: 0, duration: 400 },
      );
    };
    if (map.getLayer("walls-3d")) apply();
    else map.once("load", apply);
  }, [threeD, levelId, bundle]);

  // The overlays as the map's own padding: centring, easing and fitting all keep clear of them.
  // (Passing padding to easeTo would store it too, and fitBounds would then count it twice.)
  useEffect(() => {
    mapRef.current?.setPadding({
      top: topInset,
      bottom: bottomInset,
      left: leftInset,
      right: RIGHT_INSET,
    });
  }, [topInset, bottomInset, leftInset]);

  // Show the whole route on the current floor whenever it changes or the floor does.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !route) return;
    const bounds = legBounds(route, levelId);
    if (!bounds) return;
    const apply = () =>
      map.fitBounds(bounds, { padding: FIT_PADDING, maxZoom: 20.5, duration: 500 });
    if (map.getSource(ROUTE_SOURCE)) apply();
    else map.once("load", apply);
  }, [route, levelId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    map.easeTo({ center: focus.position, zoom: Math.max(map.getZoom(), 20), duration: 400 });
  }, [focus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      map.setFilter("pois-selected", selectedFilter(selectedPoiId));
      const poi = bundle.pois?.find((p) => p.id === selectedPoiId);
      if (poi) {
        map.easeTo({ center: poi.position, zoom: Math.max(map.getZoom(), 19.5), duration: 400 });
      }
    };
    if (map.getLayer("pois-selected")) apply();
    else map.once("load", apply);
  }, [selectedPoiId, bundle]);

  // MapLibre's own CSS sets position: relative on the container, so size it via a wrapper.
  return (
    <div className={picking ? "absolute inset-0 [&_canvas]:!cursor-crosshair" : "absolute inset-0"}>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

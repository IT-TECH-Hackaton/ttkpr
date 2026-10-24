import type { PanoramaOut } from "@ttkpr/api-client";
import {
  addConnectorIcons,
  applyPlanTheme,
  buildNavGraph,
  bundleBounds,
  DEFAULT_GLYPHS,
  DETAIL_LAYERS,
  detailLayers,
  findTourRoute,
  fromLocal,
  LEVEL_FILTERED_LAYERS,
  type LonLat,
  levelFilter,
  PLAN_FONT,
  planLayers,
  SOURCE,
  syncRoomIcons,
  syncUnderlays,
  toCollections,
  toLocal,
  type XY,
} from "@ttkpr/map-core";
import { useTheme } from "@ttkpr/ui";
import type { Feature, FeatureCollection } from "geojson";
import type {
  ExpressionSpecification,
  GeoJSONSource,
  MapLayerMouseEvent,
  MapMouseEvent,
} from "maplibre-gl";
import { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef } from "react";
import {
  TerraDraw,
  TerraDrawLineStringMode,
  TerraDrawPolygonMode,
  TerraDrawRenderMode,
} from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { gridCellMeters, gridLineColor, gridLines } from "../lib/grid";
import { cornersPlacement, notifyView, registerMap } from "../lib/mapView";
import {
  moveCorner,
  moveRoom,
  moveWall,
  rectangleCorner,
  shiftOpenings,
  wallHandles,
} from "../lib/resize";
import { DOOR_WIDTHS, doorOnWall, metersPerPixel, rectangleRing, snapPoint } from "../lib/snap";
import { type LayerGroup, useDraft } from "../store";

const STUDIO_PANOS = "studio-panos";
// Route of the selected tour (preview of what visitors get), with numbered stops.
const TOUR = "studio-tour";
const PREVIEW = "draft-preview";
const HANDLES = "draft-handles";
const GRID = "plan-grid";
const SNAP_PX = 12;
const DOOR_PX = 28;
const GRID_M = 0.5;

const LAYER_GROUPS: Record<LayerGroup, string[]> = {
  underlay: [], // underlay-* layers, handled separately
  rooms: [
    "units-fill",
    "units-outline",
    "units-icon",
    "units-icon-glyph",
    "selected-unit",
    "wall-handles",
    "wall-handles-hit",
    ...DETAIL_LAYERS,
    "selected-fixture-fill",
    "selected-fixture",
  ],
  labels: ["units-label", "units-icon-label", "pois-label", "connectors-label"],
  doors: ["openings", "selected-opening", "paths", "paths-hit", "selected-path"],
  connectors: ["connectors", "connectors-label", "selected-connector", "connectors-hit"],
  points: ["pois", "pois-label", "pois-hit", "selected-poi"],
  panos: ["studio-panos", "studio-panos-hit", "studio-panos-selected"],
};

type Position = [number, number];
const byId = (id: string | null): ExpressionSpecification => ["==", ["get", "id"], id ?? ""];
const onLevel = (levelId: string): ExpressionSpecification => ["==", ["get", "levelId"], levelId];

function panoCollection(panos: PanoramaOut[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: panos.map((p) => ({
      type: "Feature",
      id: p.id,
      geometry: { type: "Point", coordinates: p.position },
      properties: { id: p.id, levelId: p.levelId, status: p.status },
    })),
  };
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function point(position: LonLat, kind: string): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: position },
    properties: { kind },
  };
}

interface Props {
  panos: PanoramaOut[];
  canEdit: boolean;
  onMovePano: (id: string, position: Position) => void;
}

/** Plan editing surface: own tools with snapping; Terra Draw only for free-form outlines. */
export function EditorMap({ panos, canEdit, onMovePano }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const rectStart = useRef<LonLat | null>(null);
  const dragging = useRef<
    | { kind: "poi" | "pano"; id: string; origin?: Position }
    | { kind: "fixture"; id: string; origin: Position; rings: Position[][] }
    | {
        kind: "wall";
        id: string;
        edge: number;
        ring: XY[];
        openings: { id: string; line: XY[] }[];
        cursor: string;
        latest: {
          ring: XY[];
          openings: { id: string; line: XY[] }[];
          offset: number;
        } | null;
      }
    | {
        kind: "corner";
        id: string;
        corner: number;
        ring: XY[];
        openings: { id: string; line: XY[] }[];
        cursor: string;
        latest: {
          ring: XY[];
          openings: { id: string; line: XY[] }[];
          offset: number;
        } | null;
      }
    | {
        kind: "room";
        id: string;
        origin: XY;
        ring: XY[];
        openings: { id: string; line: XY[] }[];
        latest: {
          ring: XY[];
          openings: { id: string; line: XY[] }[];
          offset: number;
        } | null;
      }
    | null
  >(null);
  const handlesRef = useRef<() => FeatureCollection>(() => EMPTY);
  const props = useRef({ onMovePano, canEdit });
  props.current = { onMovePano, canEdit };

  const doc = useDraft((s) => s.doc);
  const levelId = useDraft((s) => s.levelId);
  const tool = useDraft((s) => s.tool);
  const selectedId = useDraft((s) => s.selectedId);
  const panoSpot = useDraft((s) => s.panoSpot);
  const hiddenLayers = useDraft((s) => s.hiddenLayers);
  const { dark } = useTheme();
  const darkRef = useRef(dark);
  darkRef.current = dark;

  useEffect(() => {
    if (!containerRef.current) return;
    const initial = useDraft.getState();
    const bounds = bundleBounds(initial.doc);
    const map = new MapLibreMap({
      container: containerRef.current,
      style: {
        version: 8,
        glyphs: DEFAULT_GLYPHS,
        sources: {},
        layers: [
          { id: "background", type: "background", paint: { "background-color": "#e9eef3" } },
        ],
      },
      ...(bounds
        ? { bounds, fitBoundsOptions: { padding: 96 } }
        : { center: initial.doc.venue.anchor, zoom: 19 }),
      maxZoom: 23,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    registerMap(map);
    if (import.meta.env.DEV) (window as unknown as { editorMap?: MapLibreMap }).editorMap = map;
    let ignoreClicksUntil = 0;

    const tolerance = (px: number) => px * metersPerPixel(map.getCenter().lat, map.getZoom());
    const snap = (lngLat: { lng: number; lat: number }) => {
      const s = useDraft.getState();
      return snapPoint(s.doc, [lngLat.lng, lngLat.lat], {
        levelId: s.levelId,
        toleranceM: tolerance(SNAP_PX),
        gridM: s.snapping ? GRID_M : 0,
      });
    };
    // Rectangles follow the plan image when it is rotated.
    const planRotation = () => {
      const s = useDraft.getState();
      const underlay = s.doc.underlays?.find((u) => u.levelId === s.levelId);
      return underlay ? cornersPlacement(s.doc.venue.anchor, underlay.coordinates).rotationDeg : 0;
    };
    const setPreview = (features: Feature[]) =>
      (map.getSource(PREVIEW) as GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features,
      });
    const doorAt = (lngLat: { lng: number; lat: number }) => {
      const s = useDraft.getState();
      return doorOnWall(
        s.doc,
        [lngLat.lng, lngLat.lat],
        s.levelId,
        DOOR_WIDTHS[s.doorType] ?? 0.9,
        tolerance(DOOR_PX),
      );
    };

    const syncGrid = () => {
      notifyView();
      const source = map.getSource(GRID) as GeoJSONSource | undefined;
      if (!source) return;
      const bounds = map.getBounds();
      const step = gridCellMeters(metersPerPixel(map.getCenter().lat, map.getZoom()));
      source.setData(
        gridLines(
          useDraft.getState().doc.venue.anchor,
          bounds.getWest(),
          bounds.getSouth(),
          bounds.getEast(),
          bounds.getNorth(),
          step,
        ),
      );
    };
    let gridFrame = 0;
    const onMove = () => {
      if (gridFrame) return;
      gridFrame = requestAnimationFrame(() => {
        gridFrame = 0;
        syncGrid();
      });
    };
    map.on("move", onMove);

    map.on("load", () => {
      const collections = toCollections(initial.doc);
      map.addSource(SOURCE.units, { type: "geojson", data: collections.units });
      map.addSource(SOURCE.openings, { type: "geojson", data: collections.openings });
      map.addSource(SOURCE.pois, { type: "geojson", data: collections.pois });
      map.addSource(SOURCE.panos, { type: "geojson", data: collections.panos });
      map.addSource(SOURCE.connectors, { type: "geojson", data: collections.connectors });
      map.addSource(SOURCE.paths, { type: "geojson", data: collections.paths });
      map.addSource(SOURCE.zones, { type: "geojson", data: collections.zones });
      map.addSource(SOURCE.fixtures, { type: "geojson", data: collections.fixtures });
      map.addSource(SOURCE.roomIcons, { type: "geojson", data: collections.roomIcons });
      map.addSource(STUDIO_PANOS, { type: "geojson", data: EMPTY });
      map.addSource(PREVIEW, { type: "geojson", data: EMPTY });
      map.addSource(HANDLES, { type: "geojson", data: EMPTY });
      map.addSource(GRID, { type: "geojson", data: EMPTY });
      map.addSource(TOUR, { type: "geojson", data: EMPTY });

      // The bundle's pano layer is replaced by live panoramas from the API.
      addConnectorIcons(map);
      for (const layer of planLayers(initial.levelId)) {
        if (layer.id !== "panos") map.addLayer(layer);
      }
      // Over the room fill and under the outline, so the square stays readable inside a room.
      map.addLayer(
        {
          id: GRID,
          type: "line",
          source: GRID,
          paint: {
            "line-color": gridLineColor(darkRef.current),
            "line-width": 1,
          },
        },
        "units-outline",
      );
      for (const layer of detailLayers(initial.levelId)) map.addLayer(layer, "paths");
      map.addLayer({
        id: "selected-fixture-fill",
        type: "fill",
        source: SOURCE.fixtures,
        filter: byId(null),
        paint: { "fill-color": "#38bdf8", "fill-opacity": 0.55 },
      });
      map.addLayer({
        id: "selected-fixture",
        type: "line",
        source: SOURCE.fixtures,
        filter: byId(null),
        paint: { "line-color": "#38bdf8", "line-width": 4 },
      });
      const level = onLevel(initial.levelId);
      const highlight = (id: string, source: string, type: "line" | "circle", color: string) =>
        map.addLayer(
          type === "line"
            ? {
                id,
                type,
                source,
                filter: byId(null),
                paint: { "line-color": color, "line-width": id === "selected-opening" ? 8 : 3 },
              }
            : {
                id,
                type,
                source,
                filter: byId(null),
                paint: { "circle-radius": 14, "circle-color": color, "circle-opacity": 0.25 },
              },
        );
      highlight("selected-unit", SOURCE.units, "line", "#2563eb");
      highlight("selected-opening", SOURCE.openings, "line", "#2563eb");
      highlight("selected-poi", SOURCE.pois, "circle", "#2563eb");
      highlight("selected-connector", SOURCE.connectors, "circle", "#7c3aed");
      map.addLayer({
        id: "studio-panos",
        type: "circle",
        source: STUDIO_PANOS,
        filter: level,
        paint: {
          "circle-radius": 8,
          "circle-color": [
            "match",
            ["get", "status"],
            "ready",
            "#0f766e",
            "failed",
            "#dc2626",
            "#f59e0b",
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      highlight("studio-panos-selected", STUDIO_PANOS, "circle", "#0f766e");
      // Finger-sized invisible hit targets over small circles.
      for (const [id, source] of [
        ["pois-hit", SOURCE.pois],
        ["studio-panos-hit", STUDIO_PANOS],
        ["connectors-hit", SOURCE.connectors],
      ] as const) {
        map.addLayer({
          id,
          type: "circle",
          source,
          filter: level,
          paint: { "circle-radius": 20, "circle-opacity": 0 },
        });
      }
      map.addLayer({
        id: "paths-hit",
        type: "line",
        source: SOURCE.paths,
        filter: level,
        paint: { "line-width": 18, "line-opacity": 0 },
      });
      highlight("selected-path", SOURCE.paths, "line", "#2563eb");
      map.addLayer({
        id: "tour-line",
        type: "line",
        source: TOUR,
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#2563eb", "line-width": 5, "line-opacity": 0.8 },
      });
      map.addLayer({
        id: "tour-stops",
        type: "circle",
        source: TOUR,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 11,
          "circle-color": "#2563eb",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "tour-stops-label",
        type: "symbol",
        source: TOUR,
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "text-field": ["get", "n"],
          "text-font": PLAN_FONT,
          "text-size": 12,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#ffffff" },
      });
      map.addLayer({
        id: "preview-fill",
        type: "fill",
        source: PREVIEW,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#2563eb", "fill-opacity": 0.15 },
      });
      map.addLayer({
        id: "preview-line",
        type: "line",
        source: PREVIEW,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "line-color": "#2563eb", "line-width": 2, "line-dasharray": [2, 1] },
      });
      map.addLayer({
        id: "preview-door",
        type: "line",
        source: PREVIEW,
        filter: ["==", ["get", "kind"], "door"],
        paint: { "line-color": "#f59e0b", "line-width": 8 },
      });
      map.addLayer({
        id: "snap-point",
        type: "circle",
        source: PREVIEW,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": ["match", ["get", "kind"], "vertex", 7, "edge", 6, 4],
          "circle-color": [
            "match",
            ["get", "kind"],
            "vertex",
            "#2563eb",
            "edge",
            "#0ea5e9",
            "#64748b",
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "preview-guide",
        type: "line",
        source: PREVIEW,
        filter: ["==", ["get", "kind"], "guide"],
        paint: { "line-color": "#38bdf8", "line-width": 1.5, "line-dasharray": [1, 1.5] },
      });
      // Figma-style edge handles: a small dot on the line, a wider invisible grab target on top.
      map.addLayer({
        id: "wall-handles",
        type: "circle",
        source: HANDLES,
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#2563eb",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "wall-handles-hit",
        type: "circle",
        source: HANDLES,
        paint: { "circle-radius": 16, "circle-opacity": 0 },
      });

      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [
          new TerraDrawRenderMode({ modeName: "static", styles: {} }),
          new TerraDrawPolygonMode({ snapping: { toCustom: (event) => snap(event).position } }),
          new TerraDrawLineStringMode({ snapping: { toCustom: (event) => snap(event).position } }),
        ],
      });
      draw.start();
      draw.setMode("static");
      draw.on("finish", (id) => {
        const feature = draw.getSnapshotFeature(id);
        if (feature?.geometry.type === "Polygon") {
          useDraft.getState().addUnit(feature.geometry.coordinates[0] as Position[]);
        } else if (feature?.geometry.type === "LineString") {
          useDraft.getState().addPath(feature.geometry.coordinates as Position[]);
        }
        draw.removeFeatures([id]);
        ignoreClicksUntil = performance.now() + 300;
      });
      drawRef.current = draw;
      syncUnderlays(map, initial.doc.underlays ?? [], initial.levelId);
      syncGrid();
    });

    const paintUnit = (id: string, ring: Position[]) => {
      const unit = useDraft.getState().doc.units?.find((u) => u.id === id);
      const holes = unit?.geometry.coordinates.slice(1) ?? [];
      const collections = toCollections(useDraft.getState().doc);
      (map.getSource(SOURCE.units) as GeoJSONSource).setData({
        type: "FeatureCollection",
        features: collections.units.features.map((feature) =>
          feature.properties?.id === id
            ? {
                ...feature,
                geometry: { type: "Polygon" as const, coordinates: [ring, ...holes] },
              }
            : feature,
        ),
      });
      const doc = useDraft.getState().doc;
      (map.getSource(SOURCE.roomIcons) as GeoJSONSource | undefined)?.setData(
        toCollections({
          ...doc,
          units: doc.units?.map((u) =>
            u.id === id
              ? { ...u, geometry: { type: "Polygon" as const, coordinates: [ring, ...holes] } }
              : u,
          ),
        }).roomIcons,
      );
    };
    const paintOpenings = (moved: { id: string; line: Position[] }[]) => {
      const byId = new Map(moved.map((o) => [o.id, o.line]));
      const collections = toCollections(useDraft.getState().doc);
      (map.getSource(SOURCE.openings) as GeoJSONSource).setData({
        type: "FeatureCollection",
        features: collections.openings.features.map((feature) => {
          const line = byId.get(String(feature.properties?.id ?? ""));
          return line
            ? { ...feature, geometry: { type: "LineString" as const, coordinates: line } }
            : feature;
        }),
      });
    };
    const paintHandles = (id: string, ring: XY[]) => {
      const anchor = useDraft.getState().doc.venue.anchor;
      const minM = metersPerPixel(map.getCenter().lat, map.getZoom()) * 28;
      (map.getSource(HANDLES) as GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: wallHandles(ring, minM).map((h) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: fromLocal(anchor, h.at) },
          properties: { edge: h.edge, cursor: h.cursor, id },
        })),
      });
    };

    const moveDrag = (lngLat: { lng: number; lat: number }) => {
      const drag = dragging.current;
      if (!drag) return;
      if (drag.kind === "wall") {
        const s = useDraft.getState();
        const anchor = s.doc.venue.anchor;
        const others = (s.doc.units ?? [])
          .filter((u) => u.levelId === s.levelId && u.id !== drag.id)
          .map((u) => (u.geometry.coordinates[0] ?? []).map((c) => toLocal(anchor, c as LonLat)));
        const moved = moveWall(drag.ring, drag.edge, toLocal(anchor, [lngLat.lng, lngLat.lat]), {
          toleranceM: tolerance(SNAP_PX),
          gridM: s.snapping ? GRID_M : 0,
          others,
        });
        if (!moved) return;
        const ring = moved.ring.map((p) => fromLocal(anchor, p));
        const openings = shiftOpenings(drag.openings, drag.ring, drag.edge, moved.offset).map(
          (o) => ({ id: o.id, line: o.line.map((p) => fromLocal(anchor, p)) }),
        );
        drag.latest = { ring, openings, offset: moved.offset };
        paintUnit(drag.id, ring);
        paintOpenings(openings);
        paintHandles(drag.id, moved.ring);
        setPreview(
          moved.guide
            ? [
                {
                  type: "Feature",
                  geometry: {
                    type: "LineString",
                    coordinates: moved.guide.map((p) => fromLocal(anchor, p)),
                  },
                  properties: { kind: "guide" },
                },
              ]
            : [],
        );
        map.getCanvas().style.cursor = drag.cursor;
        return;
      }
      if (drag.kind === "corner" || drag.kind === "room") {
        const s = useDraft.getState();
        const anchor = s.doc.venue.anchor;
        const pointer = toLocal(anchor, [lngLat.lng, lngLat.lat]);
        const opts = {
          toleranceM: tolerance(SNAP_PX),
          gridM: s.snapping ? GRID_M : 0,
          others: (s.doc.units ?? [])
            .filter((u) => u.levelId === s.levelId && u.id !== drag.id)
            .map((u) => (u.geometry.coordinates[0] ?? []).map((c) => toLocal(anchor, c as LonLat))),
        };
        const moved =
          drag.kind === "corner"
            ? moveCorner(drag.ring, drag.corner, pointer, drag.openings, opts)
            : moveRoom(
                drag.ring,
                drag.openings,
                [pointer[0] - drag.origin[0], pointer[1] - drag.origin[1]],
                opts,
              );
        if (!moved) return;
        const ring = moved.ring.map((p) => fromLocal(anchor, p));
        const openings = moved.openings.map((o) => ({
          id: o.id,
          line: o.line.map((p) => fromLocal(anchor, p)),
        }));
        drag.latest = { ring, openings, offset: moved.distance };
        paintUnit(drag.id, ring);
        paintOpenings(openings);
        paintHandles(drag.id, moved.ring);
        const guides = "guides" in moved ? moved.guides : moved.guide ? [moved.guide] : [];
        setPreview(
          guides.map((guide) => ({
            type: "Feature" as const,
            geometry: {
              type: "LineString" as const,
              coordinates: guide.map((p) => fromLocal(anchor, p)),
            },
            properties: { kind: "guide" },
          })),
        );
        map.getCanvas().style.cursor = drag.kind === "corner" ? drag.cursor : "grabbing";
        return;
      }
      if (drag.kind !== "fixture") {
        setPreview([point([lngLat.lng, lngLat.lat], "drag")]);
        return;
      }
      const dx = lngLat.lng - drag.origin[0];
      const dy = lngLat.lat - drag.origin[1];
      const coordinates = drag.rings.map((ring) =>
        ring.map(([lon, lat]) => [lon + dx, lat + dy] as Position),
      );
      const collections = toCollections(useDraft.getState().doc);
      (map.getSource(SOURCE.fixtures) as GeoJSONSource).setData({
        type: "FeatureCollection",
        features: collections.fixtures.features.map((feature) =>
          feature.properties?.id === drag.id
            ? { ...feature, geometry: { type: "Polygon" as const, coordinates } }
            : feature,
        ),
      });
    };
    const finishDrag = (lngLat: { lng: number; lat: number }) => {
      const drag = dragging.current;
      if (!drag) return;
      dragging.current = null;
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
      setPreview([]);
      const at: Position = [lngLat.lng, lngLat.lat];
      if (drag.kind === "poi") {
        const origin = drag.origin;
        const start = origin ? map.project(origin) : null;
        const end = map.project(at);
        const nudged = start ? Math.hypot(end.x - start.x, end.y - start.y) < 6 : false;
        if (!nudged) useDraft.getState().updatePoi(drag.id, { position: at });
      } else if (drag.kind === "pano") props.current.onMovePano(drag.id, at);
      else if (drag.kind === "fixture") {
        const dx = lngLat.lng - drag.origin[0];
        const dy = lngLat.lat - drag.origin[1];
        useDraft.getState().updateFixture(drag.id, {
          geometry: {
            type: "Polygon",
            coordinates: drag.rings.map((ring) =>
              ring.map(([lon, lat]) => [lon + dx, lat + dy] as Position),
            ),
          },
        });
      } else if (drag.kind === "wall" || drag.kind === "corner" || drag.kind === "room") {
        const latest = drag.latest;
        if (latest && Math.abs(latest.offset) >= 0.02) {
          useDraft.getState().resizeUnit(drag.id, latest.ring, latest.openings);
        } else {
          const collections = toCollections(useDraft.getState().doc);
          (map.getSource(SOURCE.units) as GeoJSONSource).setData(collections.units);
          (map.getSource(SOURCE.openings) as GeoJSONSource).setData(collections.openings);
          (map.getSource(SOURCE.roomIcons) as GeoJSONSource | undefined)?.setData(
            collections.roomIcons,
          );
          (map.getSource(HANDLES) as GeoJSONSource | undefined)?.setData(handlesRef.current());
        }
      }
      ignoreClicksUntil = performance.now() + 250;
    };
    const startWallDrag = (edge: number, cursor: string, preventDefault: () => void) => {
      const s = useDraft.getState();
      if (s.tool !== "select" || !props.current.canEdit) return;
      const unit = s.doc.units?.find((u) => u.id === s.selectedId && u.levelId === s.levelId);
      const ringLon = unit?.geometry.coordinates[0];
      if (!unit || !ringLon) return;
      preventDefault();
      const anchor = s.doc.venue.anchor;
      dragging.current = {
        kind: "wall",
        id: unit.id,
        edge,
        ring: ringLon.map((c) => toLocal(anchor, c as LonLat)),
        openings: (s.doc.openings ?? [])
          .filter((o) => o.levelId === s.levelId)
          .map((o) => ({
            id: o.id,
            line: o.geometry.coordinates.map((c) => toLocal(anchor, c as LonLat)),
          })),
        cursor,
        latest: null,
      };
      map.dragPan.disable();
      map.getCanvas().style.cursor = cursor;
    };
    const roomGeometry = (id: string) => {
      const s = useDraft.getState();
      const unit = s.doc.units?.find((u) => u.id === id && u.levelId === s.levelId);
      const ringLon = unit?.geometry.coordinates[0];
      if (!unit || !ringLon) return null;
      const anchor = s.doc.venue.anchor;
      return {
        anchor,
        ring: ringLon.map((c) => toLocal(anchor, c as LonLat)),
        openings: (s.doc.openings ?? [])
          .filter((o) => o.levelId === s.levelId)
          .map((o) => ({
            id: o.id,
            line: o.geometry.coordinates.map((c) => toLocal(anchor, c as LonLat)),
          })),
      };
    };
    const cornerUnder = (lngLat: { lng: number; lat: number }) => {
      const s = useDraft.getState();
      if (s.tool !== "select" || !s.selectedId) return null;
      const geom = roomGeometry(s.selectedId);
      if (!geom) return null;
      return rectangleCorner(
        geom.ring,
        toLocal(geom.anchor, [lngLat.lng, lngLat.lat]),
        tolerance(14),
      );
    };
    let cornerHover = false;
    const startCornerDrag = (corner: number, cursor: string, preventDefault: () => void) => {
      const s = useDraft.getState();
      if (!s.selectedId || !props.current.canEdit) return;
      const geom = roomGeometry(s.selectedId);
      if (!geom) return;
      preventDefault();
      dragging.current = {
        kind: "corner",
        id: s.selectedId,
        corner,
        ring: geom.ring,
        openings: geom.openings,
        cursor,
        latest: null,
      };
      map.dragPan.disable();
      map.getCanvas().style.cursor = cursor;
    };
    const startRoomDrag = (
      id: string,
      lngLat: { lng: number; lat: number },
      preventDefault: () => void,
    ) => {
      if (!props.current.canEdit) return;
      const geom = roomGeometry(id);
      if (!geom) return;
      preventDefault();
      const s = useDraft.getState();
      dragging.current = {
        kind: "room",
        id,
        origin: toLocal(geom.anchor, [lngLat.lng, lngLat.lat]),
        ring: geom.ring,
        openings: geom.openings,
        latest: null,
      };
      s.select(id);
      map.dragPan.disable();
      map.getCanvas().style.cursor = "grabbing";
    };

    map.on("mousemove", (event: MapMouseEvent) => {
      const s = useDraft.getState();
      if (dragging.current) {
        moveDrag(event.lngLat);
        return;
      }
      if (s.tool === "select" && props.current.canEdit) {
        const corner = cornerUnder(event.lngLat);
        if (corner) {
          cornerHover = true;
          map.getCanvas().style.cursor = corner.cursor;
        } else if (cornerHover) {
          cornerHover = false;
          map.getCanvas().style.cursor = "";
        }
      }
      if (s.tool === "rect" || s.tool === "stairs" || s.tool === "room") {
        const snapped = snap(event.lngLat);
        const features = [point(snapped.position, snapped.kind)];
        if (s.tool === "rect" && rectStart.current) {
          const ring = rectangleRing(s.doc, rectStart.current, snapped.position, planRotation());
          features.push({
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [ring] },
            properties: {},
          });
        }
        setPreview(features);
      } else if (s.tool === "door") {
        const door = doorAt(event.lngLat);
        setPreview(
          door
            ? [
                {
                  type: "Feature",
                  geometry: { type: "LineString", coordinates: door },
                  properties: { kind: "door" },
                },
              ]
            : [],
        );
        const hint = door ? null : "Наведите курсор на стену помещения";
        if (s.hint !== hint) s.setHint(hint);
      }
    });

    map.on("click", (event: MapMouseEvent) => {
      if (performance.now() < ignoreClicksUntil) return;
      const s = useDraft.getState();
      const at: Position = [event.lngLat.lng, event.lngLat.lat];

      if (s.movingPanoId) {
        props.current.onMovePano(s.movingPanoId, at);
        s.setMovingPano(null);
        return;
      }
      if (s.editingTourId) {
        const hit = map.queryRenderedFeatures(event.point, { layers: ["pois-hit"] })[0];
        const poiId = hit?.properties?.id as string | undefined;
        if (poiId) s.addTourStop(poiId);
        else s.setHint("Кликните по точке на плане — она станет следующей остановкой");
        return;
      }
      switch (s.tool) {
        case "pano":
          s.setPanoSpot(at);
          return;
        case "poi": {
          // A tap on an existing point selects it for editing instead of stacking a new one.
          const hit = map.queryRenderedFeatures(event.point, { layers: ["pois-hit"] })[0];
          const poiId = hit?.properties?.id as string | undefined;
          if (poiId) {
            s.setTool("select");
            s.select(poiId);
          } else s.addPoi(at);
          return;
        }
        case "furniture": {
          // A tap on a piece already there selects it; a double tap switches to moving it.
          const hit = map.queryRenderedFeatures(event.point, { layers: ["fixtures-fill"] })[0];
          const fixtureId = hit?.properties?.id as string | undefined;
          if (fixtureId) s.select(fixtureId);
          else s.addFurniture(at, planRotation());
          return;
        }
        case "move": {
          const layers = ["studio-panos-hit", "pois-hit", "fixtures-fill", "units-fill"].filter(
            (l) => map.getLayer(l),
          );
          const hit = map.queryRenderedFeatures(event.point, { layers })[0];
          s.select((hit?.properties?.id as string | undefined) ?? null);
          return;
        }
        case "stairs":
          s.addConnector(snap(event.lngLat).position);
          return;
        case "door": {
          const door = doorAt(event.lngLat);
          if (door) {
            s.addOpening(door[0], door[1]);
            s.setHint(null);
          } else s.setHint("Дверь ставится на стену: кликните ближе к границе помещения");
          return;
        }
        case "rect": {
          const snapped = snap(event.lngLat).position;
          if (!rectStart.current) {
            rectStart.current = snapped;
            s.setHint("Второй клик — противоположный угол. Esc — отмена");
          } else {
            const ring = rectangleRing(s.doc, rectStart.current, snapped, planRotation());
            rectStart.current = null;
            setPreview([]);
            s.setHint(null);
            s.addUnit(ring as Position[]);
          }
          return;
        }
        case "room":
        case "path":
          return; // Terra Draw handles clicks
        case "select": {
          const layers = [
            "studio-panos-hit",
            "connectors-hit",
            "pois-hit",
            "paths-hit",
            "openings",
            "fixtures-fill",
            "units-fill",
          ].filter((l) => map.getLayer(l));
          const hit = map.queryRenderedFeatures(event.point, { layers })[0];
          s.select((hit?.properties?.id as string | undefined) ?? null);
        }
      }
    });

    // A click on a point only selects it. Dragging a point or furniture needs the move tool.
    const startDrag =
      (kind: "poi" | "pano" | "fixture") =>
      (event: {
        lngLat: { lng: number; lat: number };
        features?: MapLayerMouseEvent["features"];
        preventDefault: () => void;
      }) => {
        const s = useDraft.getState();
        const id = event.features?.[0]?.properties?.id as string | undefined;
        const allowed =
          kind === "pano" ? s.tool === "select" || s.tool === "move" : s.tool === "move";
        if (!allowed || !id || !props.current.canEdit) return;
        event.preventDefault();
        if (kind === "fixture") {
          const fixture = s.doc.fixtures?.find((f) => f.id === id);
          if (!fixture) return;
          dragging.current = {
            kind,
            id,
            origin: [event.lngLat.lng, event.lngLat.lat],
            rings: fixture.geometry.coordinates as Position[][],
          };
        } else {
          dragging.current = {
            kind,
            id,
            origin: [event.lngLat.lng, event.lngLat.lat],
          };
        }
        s.select(id);
        map.dragPan.disable();
        map.getCanvas().style.cursor = "grabbing";
      };
    map.on("mousedown", "pois-hit", startDrag("poi"));
    map.on("mousedown", "studio-panos-hit", startDrag("pano"));
    map.on("mousedown", "fixtures-fill", startDrag("fixture"));
    map.on("mousedown", "wall-handles-hit", (event) => {
      const corner = cornerUnder(event.lngLat);
      if (corner) {
        startCornerDrag(corner.corner, corner.cursor, () => event.preventDefault());
        return;
      }
      const edge = Number(event.features?.[0]?.properties?.edge);
      const cursor = String(event.features?.[0]?.properties?.cursor ?? "ew-resize");
      if (!Number.isInteger(edge)) return;
      startWallDrag(edge, cursor, () => event.preventDefault());
    });
    map.on("mousedown", (event) => {
      if (dragging.current || !props.current.canEdit) return;
      const s = useDraft.getState();
      if (s.tool === "select") {
        const corner = cornerUnder(event.lngLat);
        if (corner) startCornerDrag(corner.corner, corner.cursor, () => event.preventDefault());
        return;
      }
      if (s.tool !== "move") return;
      const layers = ["fixtures-fill", "pois-hit", "studio-panos-hit", "units-fill"].filter((l) =>
        map.getLayer(l),
      );
      const hit = map.queryRenderedFeatures(event.point, { layers })[0];
      if (hit?.layer.id === "units-fill" && hit.properties?.id) {
        startRoomDrag(String(hit.properties.id), event.lngLat, () => event.preventDefault());
      }
    });
    map.on("touchstart", (event) => {
      const s = useDraft.getState();
      if (s.tool === "select") {
        const corner = cornerUnder(event.lngLat);
        if (corner) {
          startCornerDrag(corner.corner, corner.cursor, () => event.preventDefault());
          return;
        }
        if (map.getLayer("wall-handles-hit")) {
          const hit = map.queryRenderedFeatures(event.point, { layers: ["wall-handles-hit"] })[0];
          const edge = Number(hit?.properties?.edge);
          if (hit && Number.isInteger(edge)) {
            startWallDrag(edge, String(hit.properties?.cursor ?? "ew-resize"), () =>
              event.preventDefault(),
            );
            return;
          }
        }
      }
      if (s.tool === "move" && map.getLayer("units-fill")) {
        const layers = ["fixtures-fill", "units-fill"].filter((l) => map.getLayer(l));
        const hit = map.queryRenderedFeatures(event.point, { layers })[0];
        if (hit?.layer.id === "units-fill" && hit.properties?.id) {
          startRoomDrag(String(hit.properties.id), event.lngLat, () => event.preventDefault());
          return;
        }
      }
      if (s.tool !== "move" || !map.getLayer("fixtures-fill")) return;
      const hit = map.queryRenderedFeatures(event.point, { layers: ["fixtures-fill"] })[0];
      if (!hit?.properties?.id) return;
      startDrag("fixture")({
        lngLat: event.lngLat,
        features: [hit],
        preventDefault: () => event.preventDefault(),
      });
    });
    map.on("mouseup", (event: MapMouseEvent) => finishDrag(event.lngLat));
    map.on("touchend", (event) => {
      if (event.lngLat) finishDrag(event.lngLat);
    });
    map.on("touchmove", (event) => {
      const kind = dragging.current?.kind;
      if (kind !== "fixture" && kind !== "wall" && kind !== "corner" && kind !== "room") return;
      event.preventDefault();
      moveDrag(event.lngLat);
    });
    map.on("dblclick", (event) => {
      if (!props.current.canEdit) return;
      const layers = ["fixtures-fill", "units-fill"].filter((l) => map.getLayer(l));
      const hit = layers.length ? map.queryRenderedFeatures(event.point, { layers })[0] : undefined;
      const id = hit?.properties?.id as string | undefined;
      if (!id) return;
      event.preventDefault();
      const s = useDraft.getState();
      s.setTool("move");
      s.select(id);
      ignoreClicksUntil = performance.now() + 300;
    });
    map.on("mouseenter", "wall-handles-hit", (event) => {
      if (useDraft.getState().tool !== "select" || dragging.current) return;
      map.getCanvas().style.cursor = String(event.features?.[0]?.properties?.cursor ?? "ew-resize");
    });
    map.on("mouseleave", "wall-handles-hit", () => {
      if (dragging.current) return;
      if (useDraft.getState().tool === "select") map.getCanvas().style.cursor = "";
    });
    map.on("dblclick", "wall-handles-hit", (event) => event.preventDefault());
    map.on("mouseenter", "units-fill", () => {
      if (useDraft.getState().tool === "move" && !dragging.current) {
        map.getCanvas().style.cursor = "grab";
      }
    });
    map.on("mouseleave", "units-fill", () => {
      if (dragging.current) return;
      if (useDraft.getState().tool === "move") map.getCanvas().style.cursor = "move";
    });
    map.on("zoomend", () => {
      const kind = dragging.current?.kind;
      if (kind === "wall" || kind === "corner" || kind === "room") return;
      (map.getSource(HANDLES) as GeoJSONSource | undefined)?.setData(handlesRef.current());
    });
    for (const layer of ["pois-hit", "studio-panos-hit", "fixtures-fill"]) {
      map.on("mouseenter", layer, () => {
        const toolNow = useDraft.getState().tool;
        const draggable =
          toolNow === "move" || (layer === "studio-panos-hit" && toolNow === "select");
        if (draggable) map.getCanvas().style.cursor = "grab";
        else if (toolNow === "select") map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layer, () => {
        const toolNow = useDraft.getState().tool;
        if (toolNow === "move") map.getCanvas().style.cursor = "move";
        else if (toolNow === "select") map.getCanvas().style.cursor = "";
      });
    }

    return () => {
      map.off("move", onMove);
      if (gridFrame) cancelAnimationFrame(gridFrame);
      drawRef.current?.stop();
      drawRef.current = null;
      registerMap(null);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const paintGrid = (isDark: boolean) => {
      if (map.getLayer(GRID)) map.setPaintProperty(GRID, "line-color", gridLineColor(isDark));
    };
    if (map.isStyleLoaded()) {
      applyPlanTheme(map, dark);
      paintGrid(dark);
    } else {
      map.once("load", () => {
        applyPlanTheme(map, darkRef.current);
        paintGrid(darkRef.current);
      });
    }
  }, [dark]);

  // Document -> map sources and underlays.
  // A click often writes a preview just before the new room, so isStyleLoaded() is briefly
  // false. Skipping the update then leaves the shape only in the side panel until the next edit.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const sync = () => {
      if (!map.getSource(SOURCE.units)) return false;
      const collections = toCollections(doc);
      (map.getSource(SOURCE.units) as GeoJSONSource).setData(collections.units);
      (map.getSource(SOURCE.pois) as GeoJSONSource).setData(collections.pois);
      (map.getSource(SOURCE.openings) as GeoJSONSource).setData(collections.openings);
      (map.getSource(SOURCE.connectors) as GeoJSONSource).setData(collections.connectors);
      (map.getSource(SOURCE.paths) as GeoJSONSource).setData(collections.paths);
      (map.getSource(SOURCE.zones) as GeoJSONSource).setData(collections.zones);
      (map.getSource(SOURCE.fixtures) as GeoJSONSource).setData(collections.fixtures);
      (map.getSource(SOURCE.roomIcons) as GeoJSONSource | undefined)?.setData(
        collections.roomIcons,
      );
      syncUnderlays(map, doc.underlays ?? [], useDraft.getState().levelId);
      applyVisibility(map, useDraft.getState().hiddenLayers);
      syncRoomIcons(map, doc.units ?? []);
      return true;
    };
    return runWhenMapReady(map, sync);
  }, [doc]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    return runWhenMapReady(map, () => {
      const source = map.getSource(STUDIO_PANOS) as GeoJSONSource | undefined;
      if (!source) return false;
      source.setData(panoCollection(panos));
      return true;
    });
  }, [panos]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    return runWhenMapReady(map, () => {
      if (!map.getLayer("units-fill")) return false;
      for (const layer of [...LEVEL_FILTERED_LAYERS, ...DETAIL_LAYERS]) {
        if (map.getLayer(layer)) map.setFilter(layer, levelFilter(layer, levelId));
      }
      for (const layer of [
        "studio-panos",
        "studio-panos-hit",
        "pois-hit",
        "connectors-hit",
        "paths-hit",
      ]) {
        if (map.getLayer(layer)) map.setFilter(layer, onLevel(levelId));
      }
      syncUnderlays(map, useDraft.getState().doc.underlays ?? [], levelId);
      applyVisibility(map, useDraft.getState().hiddenLayers);
      return true;
    });
  }, [levelId]);

  useEffect(() => {
    const map = mapRef.current;
    rectStart.current = null;
    (map?.getSource(PREVIEW) as GeoJSONSource | undefined)?.setData(EMPTY);
    drawRef.current?.setMode(
      tool === "room" ? "polygon" : tool === "path" ? "linestring" : "static",
    );
    const canvas = map?.getCanvas();
    if (canvas) {
      canvas.style.cursor = tool === "select" ? "" : tool === "move" ? "move" : "crosshair";
    }
  }, [tool]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("selected-unit")) return;
    for (const layer of [
      "selected-unit",
      "selected-opening",
      "selected-poi",
      "selected-fixture-fill",
      "selected-fixture",
      "selected-connector",
      "selected-path",
      "studio-panos-selected",
    ]) {
      if (map.getLayer(layer)) map.setFilter(layer, byId(selectedId));
    }
  }, [selectedId]);

  handlesRef.current = () => {
    const map = mapRef.current;
    const s = useDraft.getState();
    if (!map || s.tool !== "select" || !props.current.canEdit) return EMPTY;
    const unit = s.doc.units?.find((u) => u.id === s.selectedId && u.levelId === s.levelId);
    const ringLon = unit?.geometry.coordinates[0];
    if (!unit || !ringLon) return EMPTY;
    const anchor = s.doc.venue.anchor;
    const ring = ringLon.map((c) => toLocal(anchor, c as LonLat));
    const minM = metersPerPixel(map.getCenter().lat, map.getZoom()) * 28;
    return {
      type: "FeatureCollection",
      features: wallHandles(ring, minM).map((h) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: fromLocal(anchor, h.at) },
        properties: { edge: h.edge, cursor: h.cursor, id: unit.id },
      })),
    };
  };

  // Midpoint handles on the selected room. Hidden while a wall drag paints its own.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const show =
      tool === "select" &&
      doc.units?.some((u) => u.id === selectedId && u.levelId === levelId) === true;
    return runWhenMapReady(map, () => {
      const source = map.getSource(HANDLES) as GeoJSONSource | undefined;
      if (!source) return false;
      const kind = dragging.current?.kind;
      if (kind === "wall" || kind === "corner" || kind === "room") return true;
      source.setData(show ? handlesRef.current() : EMPTY);
      return true;
    });
  }, [doc, selectedId, tool, levelId]);

  // The selected tour as visitors will walk it (current floor), stops numbered.
  useEffect(() => {
    const source = mapRef.current?.getSource(TOUR) as GeoJSONSource | undefined;
    if (!source) return;
    const tour = doc.tours?.find((t) => t.id === selectedId);
    const stops = tour?.stops ?? [];
    const route =
      tour && stops.length >= 2
        ? findTourRoute(buildNavGraph(doc), doc, stops, { avoidStairs: tour.avoidStairs })
        : null;
    const features: Feature[] = [];
    for (const leg of route?.legs ?? []) {
      if (leg.levelId !== levelId || leg.coordinates.length < 2) continue;
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: leg.coordinates },
        properties: {},
      });
    }
    stops.forEach((poiId, i) => {
      const poi = doc.pois?.find((p) => p.id === poiId);
      if (poi?.levelId !== levelId) return;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: poi.position },
        properties: { n: String(i + 1) },
      });
    });
    source.setData({ type: "FeatureCollection", features });
  }, [doc, selectedId, levelId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    return runWhenMapReady(map, () => {
      if (!map.getLayer("units-fill")) return false;
      const s = useDraft.getState();
      syncUnderlays(map, s.doc.underlays ?? [], s.levelId);
      applyVisibility(map, hiddenLayers);
      return true;
    });
  }, [hiddenLayers]);

  useEffect(() => {
    const source = mapRef.current?.getSource(PREVIEW) as GeoJSONSource | undefined;
    if (!source || tool !== "pano") return;
    source.setData({
      type: "FeatureCollection",
      features: panoSpot ? [point(panoSpot, "vertex")] : [],
    });
  }, [panoSpot, tool]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

/** Run once sources exist. `isStyleLoaded()` flickers false after a preview update, so it is not the signal. */
function runWhenMapReady(map: MapLibreMap, run: () => boolean) {
  if (run()) return;
  const retry = () => {
    if (run()) map.off("idle", retry);
  };
  map.on("idle", retry);
  return () => {
    map.off("idle", retry);
  };
}

function applyVisibility(map: MapLibreMap, hidden: LayerGroup[]) {
  const hiddenIds = new Set(hidden.flatMap((g) => LAYER_GROUPS[g]));
  for (const ids of Object.values(LAYER_GROUPS)) {
    for (const id of ids) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", hiddenIds.has(id) ? "none" : "visible");
      }
    }
  }
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.id.startsWith("underlay-") && hidden.includes("underlay")) {
      map.setLayoutProperty(layer.id, "visibility", "none");
    }
  }
}

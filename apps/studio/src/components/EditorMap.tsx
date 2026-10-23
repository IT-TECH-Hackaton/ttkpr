import type { PanoramaOut } from "@ttkpr/api-client";
import {
  bundleBounds,
  DEFAULT_GLYPHS,
  LEVEL_FILTERED_LAYERS,
  type LonLat,
  levelFilter,
  planLayers,
  SOURCE,
  syncUnderlays,
  toCollections,
} from "@ttkpr/map-core";
import type { Feature, FeatureCollection } from "geojson";
import type {
  ExpressionSpecification,
  GeoJSONSource,
  MapLayerMouseEvent,
  MapMouseEvent,
} from "maplibre-gl";
import { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { TerraDraw, TerraDrawPolygonMode, TerraDrawRenderMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { cornersPlacement, registerMap } from "../lib/mapView";
import { DOOR_WIDTHS, doorOnWall, metersPerPixel, rectangleRing, snapPoint } from "../lib/snap";
import { type LayerGroup, useDraft } from "../store";

const STUDIO_PANOS = "studio-panos";
const PREVIEW = "draft-preview";
const SNAP_PX = 12;
const DOOR_PX = 28;
const GRID_M = 0.5;

const LAYER_GROUPS: Record<LayerGroup, string[]> = {
  underlay: [], // underlay-* layers, handled separately
  rooms: ["units-fill", "units-outline", "selected-unit"],
  labels: ["units-label", "pois-label", "connectors-label"],
  doors: ["openings", "selected-opening"],
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
  const dragging = useRef<{ kind: "poi" | "pano"; id: string } | null>(null);
  const props = useRef({ onMovePano, canEdit });
  props.current = { onMovePano, canEdit };

  const doc = useDraft((s) => s.doc);
  const levelId = useDraft((s) => s.levelId);
  const tool = useDraft((s) => s.tool);
  const selectedId = useDraft((s) => s.selectedId);
  const panoSpot = useDraft((s) => s.panoSpot);
  const hiddenLayers = useDraft((s) => s.hiddenLayers);

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

    map.on("load", () => {
      const collections = toCollections(initial.doc);
      map.addSource(SOURCE.units, { type: "geojson", data: collections.units });
      map.addSource(SOURCE.openings, { type: "geojson", data: collections.openings });
      map.addSource(SOURCE.pois, { type: "geojson", data: collections.pois });
      map.addSource(SOURCE.panos, { type: "geojson", data: collections.panos });
      map.addSource(SOURCE.connectors, { type: "geojson", data: collections.connectors });
      map.addSource(STUDIO_PANOS, { type: "geojson", data: EMPTY });
      map.addSource(PREVIEW, { type: "geojson", data: EMPTY });

      // The bundle's pano layer is replaced by live panoramas from the API.
      for (const layer of planLayers(initial.levelId)) {
        if (layer.id !== "panos") map.addLayer(layer);
      }
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

      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [
          new TerraDrawRenderMode({ modeName: "static", styles: {} }),
          new TerraDrawPolygonMode({ snapping: { toCustom: (event) => snap(event).position } }),
        ],
      });
      draw.start();
      draw.setMode("static");
      draw.on("finish", (id) => {
        const feature = draw.getSnapshotFeature(id);
        if (feature?.geometry.type === "Polygon") {
          useDraft.getState().addUnit(feature.geometry.coordinates[0] as Position[]);
        }
        draw.removeFeatures([id]);
        ignoreClicksUntil = performance.now() + 300;
      });
      drawRef.current = draw;
      syncUnderlays(map, initial.doc.underlays ?? [], initial.levelId);
    });

    map.on("mousemove", (event: MapMouseEvent) => {
      const s = useDraft.getState();
      if (dragging.current) {
        setPreview([point([event.lngLat.lng, event.lngLat.lat], "drag")]);
        return;
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
      switch (s.tool) {
        case "pano":
          s.setPanoSpot(at);
          return;
        case "poi":
          s.addPoi(at);
          return;
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
          return; // Terra Draw handles clicks
        case "select": {
          const layers = [
            "studio-panos-hit",
            "connectors-hit",
            "pois-hit",
            "openings",
            "units-fill",
          ].filter((l) => map.getLayer(l));
          const hit = map.queryRenderedFeatures(event.point, { layers })[0];
          s.select((hit?.properties?.id as string | undefined) ?? null);
        }
      }
    });

    // Drag points and panoramas with the select tool.
    const startDrag = (kind: "poi" | "pano") => (event: MapLayerMouseEvent) => {
      const s = useDraft.getState();
      const id = event.features?.[0]?.properties?.id as string | undefined;
      if (s.tool !== "select" || !id || !props.current.canEdit) return;
      event.preventDefault();
      dragging.current = { kind, id };
      s.select(id);
      map.dragPan.disable();
      map.getCanvas().style.cursor = "grabbing";
    };
    map.on("mousedown", "pois-hit", startDrag("poi"));
    map.on("mousedown", "studio-panos-hit", startDrag("pano"));
    map.on("mouseup", (event: MapMouseEvent) => {
      const drag = dragging.current;
      if (!drag) return;
      dragging.current = null;
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
      setPreview([]);
      const at: Position = [event.lngLat.lng, event.lngLat.lat];
      if (drag.kind === "poi") useDraft.getState().updatePoi(drag.id, { position: at });
      else props.current.onMovePano(drag.id, at);
      ignoreClicksUntil = performance.now() + 250;
    });
    for (const layer of ["pois-hit", "studio-panos-hit"]) {
      map.on("mouseenter", layer, () => {
        if (useDraft.getState().tool === "select") map.getCanvas().style.cursor = "grab";
      });
      map.on("mouseleave", layer, () => {
        if (useDraft.getState().tool === "select") map.getCanvas().style.cursor = "";
      });
    }

    return () => {
      drawRef.current?.stop();
      drawRef.current = null;
      registerMap(null);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Document -> map sources and underlays.
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const collections = toCollections(doc);
    (map.getSource(SOURCE.units) as GeoJSONSource | undefined)?.setData(collections.units);
    (map.getSource(SOURCE.pois) as GeoJSONSource | undefined)?.setData(collections.pois);
    (map.getSource(SOURCE.openings) as GeoJSONSource | undefined)?.setData(collections.openings);
    (map.getSource(SOURCE.connectors) as GeoJSONSource | undefined)?.setData(
      collections.connectors,
    );
    syncUnderlays(map, doc.underlays ?? [], useDraft.getState().levelId);
    applyVisibility(map, useDraft.getState().hiddenLayers);
  }, [doc]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    (map.getSource(STUDIO_PANOS) as GeoJSONSource | undefined)?.setData(panoCollection(panos));
  }, [panos]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    for (const layer of LEVEL_FILTERED_LAYERS) {
      if (map.getLayer(layer)) map.setFilter(layer, levelFilter(layer, levelId));
    }
    for (const layer of ["studio-panos", "studio-panos-hit", "pois-hit", "connectors-hit"]) {
      if (map.getLayer(layer)) map.setFilter(layer, onLevel(levelId));
    }
    syncUnderlays(map, useDraft.getState().doc.underlays ?? [], levelId);
    applyVisibility(map, useDraft.getState().hiddenLayers);
  }, [levelId]);

  useEffect(() => {
    const map = mapRef.current;
    rectStart.current = null;
    (map?.getSource(PREVIEW) as GeoJSONSource | undefined)?.setData(EMPTY);
    drawRef.current?.setMode(tool === "room" ? "polygon" : "static");
    const canvas = map?.getCanvas();
    if (canvas) canvas.style.cursor = tool === "select" ? "" : "crosshair";
  }, [tool]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("selected-unit")) return;
    for (const layer of [
      "selected-unit",
      "selected-opening",
      "selected-poi",
      "selected-connector",
      "studio-panos-selected",
    ]) {
      map.setFilter(layer, byId(selectedId));
    }
  }, [selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    // Re-show underlays of the current level before hiding what the user switched off.
    const s = useDraft.getState();
    syncUnderlays(map, s.doc.underlays ?? [], s.levelId);
    applyVisibility(map, hiddenLayers);
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

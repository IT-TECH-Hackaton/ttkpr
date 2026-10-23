import {
  bundleBounds,
  DEFAULT_GLYPHS,
  LEVEL_FILTERED_LAYERS,
  levelFilter,
  planLayers,
  SOURCE,
  toCollections,
} from "@ttkpr/map-core";
import type { GeoJSONSource } from "maplibre-gl";
import { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef } from "react";
import {
  type GeoJSONStoreFeatures,
  TerraDraw,
  TerraDrawPointMode,
  TerraDrawPolygonMode,
  TerraDrawRectangleMode,
  TerraDrawRenderMode,
} from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { type Tool, useDraft } from "../store";

const DRAW_MODE: Record<Tool, string> = {
  select: "static",
  room: "polygon",
  rect: "rectangle",
  poi: "point",
};

type Position = [number, number];

/** Terra Draw is only the drawing surface; finished shapes move into the draft document. */
export function EditorMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const doc = useDraft((s) => s.doc);
  const levelId = useDraft((s) => s.levelId);
  const tool = useDraft((s) => s.tool);
  const selectedId = useDraft((s) => s.selectedId);

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
          { id: "background", type: "background", paint: { "background-color": "#eef1f5" } },
        ],
      },
      ...(bounds
        ? { bounds, fitBoundsOptions: { padding: 48 } }
        : { center: initial.doc.venue.anchor, zoom: 18 }),
      maxZoom: 23,
      attributionControl: false,
    });
    mapRef.current = map;
    let ignoreClicksUntil = 0;

    map.on("load", () => {
      const collections = toCollections(initial.doc);
      map.addSource(SOURCE.units, { type: "geojson", data: collections.units });
      map.addSource(SOURCE.openings, { type: "geojson", data: collections.openings });
      map.addSource(SOURCE.pois, { type: "geojson", data: collections.pois });
      map.addSource(SOURCE.panos, { type: "geojson", data: collections.panos });
      for (const layer of planLayers(initial.levelId)) map.addLayer(layer);
      map.addLayer({
        id: "selected-outline",
        type: "line",
        source: SOURCE.units,
        filter: ["==", ["get", "id"], ""],
        paint: { "line-color": "#2563eb", "line-width": 3 },
      });

      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [
          new TerraDrawRenderMode({ modeName: "static", styles: {} }),
          new TerraDrawPolygonMode(),
          new TerraDrawRectangleMode(),
          new TerraDrawPointMode(),
        ],
      });
      draw.start();
      draw.setMode(DRAW_MODE[useDraft.getState().tool]);
      draw.on("finish", (id) => {
        const feature = draw.getSnapshotFeature(id);
        if (feature) commit(feature);
        draw.removeFeatures([id]);
        // The click that finished the shape must not also select whatever lies underneath.
        ignoreClicksUntil = performance.now() + 300;
      });
      drawRef.current = draw;
    });

    map.on("click", (event) => {
      if (useDraft.getState().tool !== "select" || performance.now() < ignoreClicksUntil) return;
      const hit = map.queryRenderedFeatures(event.point, { layers: ["pois", "units-fill"] })[0];
      useDraft.getState().select((hit?.properties?.id as string | undefined) ?? null);
    });

    return () => {
      drawRef.current?.stop();
      drawRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Document -> map sources.
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const collections = toCollections(doc);
    (map.getSource(SOURCE.units) as GeoJSONSource | undefined)?.setData(collections.units);
    (map.getSource(SOURCE.pois) as GeoJSONSource | undefined)?.setData(collections.pois);
    (map.getSource(SOURCE.openings) as GeoJSONSource | undefined)?.setData(collections.openings);
    (map.getSource(SOURCE.panos) as GeoJSONSource | undefined)?.setData(collections.panos);
  }, [doc]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    for (const layer of LEVEL_FILTERED_LAYERS) map.setFilter(layer, levelFilter(layer, levelId));
  }, [levelId]);

  useEffect(() => {
    drawRef.current?.setMode(DRAW_MODE[tool]);
  }, [tool]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer("selected-outline")) {
      map.setFilter("selected-outline", ["==", ["get", "id"], selectedId ?? ""]);
    }
  }, [selectedId]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

function commit(feature: GeoJSONStoreFeatures) {
  const { addUnit, addPoi } = useDraft.getState();
  const geometry = feature.geometry;
  if (geometry.type === "Polygon") {
    addUnit(geometry.coordinates[0] as Position[]);
  } else if (geometry.type === "Point") {
    addPoi(geometry.coordinates as Position);
  }
}

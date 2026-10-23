import {
  bundleBounds,
  DEFAULT_GLYPHS,
  LEVEL_FILTERED_LAYERS,
  levelFilter,
  type MapBundle,
  planLayers,
  SOURCE,
  toCollections,
} from "@ttkpr/map-core";
import type { ExpressionSpecification } from "maplibre-gl";
import { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef } from "react";

interface Props {
  bundle: MapBundle;
  levelId: string;
  selectedPoiId?: string;
  /** Pixels of the screen covered by the bottom sheet, so the selection stays visible. */
  bottomInset: number;
  onSelectPoi: (id: string) => void;
  onSelectPano: (id: string) => void;
  onBackgroundTap: () => void;
}

// Bigger invisible circles: finger-sized hit targets for small markers.
const HIT_LAYERS = ["pois-hit", "panos-hit"] as const;

function selectedFilter(id: string | undefined): ExpressionSpecification {
  return ["==", ["get", "id"], id ?? ""];
}

export function PlanMap({
  bundle,
  levelId,
  selectedPoiId,
  bottomInset,
  onSelectPoi,
  onSelectPano,
  onBackgroundTap,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const handlers = useRef({ onSelectPoi, onSelectPano, onBackgroundTap });
  handlers.current = { onSelectPoi, onSelectPano, onBackgroundTap };
  const initialLevel = useRef(levelId);

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
      attributionControl: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;

    map.on("load", () => {
      const collections = toCollections(bundle);
      map.addSource(SOURCE.units, { type: "geojson", data: collections.units });
      map.addSource(SOURCE.openings, { type: "geojson", data: collections.openings });
      map.addSource(SOURCE.pois, { type: "geojson", data: collections.pois });
      map.addSource(SOURCE.panos, { type: "geojson", data: collections.panos });
      for (const layer of planLayers(initialLevel.current)) map.addLayer(layer);

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
    });

    map.on("click", (event) => {
      const hits = map.queryRenderedFeatures(event.point, { layers: [...HIT_LAYERS] });
      const hit = hits[0];
      const id = hit?.properties?.id as string | undefined;
      if (!hit || !id) handlers.current.onBackgroundTap();
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
      for (const layer of [...LEVEL_FILTERED_LAYERS, ...HIT_LAYERS]) {
        if (map.getLayer(layer)) map.setFilter(layer, levelFilter(layer, levelId));
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [levelId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      map.setFilter("pois-selected", selectedFilter(selectedPoiId));
      const poi = bundle.pois?.find((p) => p.id === selectedPoiId);
      if (poi) {
        map.easeTo({
          center: poi.position,
          zoom: Math.max(map.getZoom(), 19.5),
          padding: { top: 80, bottom: bottomInset, left: 24, right: 24 },
          duration: 400,
        });
      }
    };
    if (map.getLayer("pois-selected")) apply();
    else map.once("load", apply);
  }, [selectedPoiId, bundle, bottomInset]);

  // MapLibre's own CSS sets position: relative on the container, so size it via a wrapper.
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

import type { Underlay } from "@ttkpr/api-client";
import type { ImageSource, Map as MapLibreMap } from "maplibre-gl";

const sourceId = (u: Underlay) => `underlay-${u.id}`;

/** Raster plan images under the drawing; only the current level's are visible. */
export function syncUnderlays(
  map: MapLibreMap,
  underlays: Underlay[],
  levelId: string,
  beforeLayer = "units-fill",
): void {
  const wanted = new Set(underlays.map(sourceId));
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.id.startsWith("underlay-") && !wanted.has(layer.id)) {
      map.removeLayer(layer.id);
      map.removeSource(layer.id);
    }
  }
  for (const u of underlays) {
    const id = sourceId(u);
    const coordinates = u.coordinates as [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ];
    const source = map.getSource(id) as ImageSource | undefined;
    if (!source) {
      map.addSource(id, { type: "image", url: u.url, coordinates });
      map.addLayer(
        {
          id,
          type: "raster",
          source: id,
          paint: { "raster-opacity": u.opacity ?? 0.6, "raster-fade-duration": 0 },
        },
        map.getLayer(beforeLayer) ? beforeLayer : undefined,
      );
    } else {
      source.setCoordinates(coordinates);
      map.setPaintProperty(id, "raster-opacity", u.opacity ?? 0.6);
    }
    map.setLayoutProperty(id, "visibility", u.levelId === levelId ? "visible" : "none");
  }
}

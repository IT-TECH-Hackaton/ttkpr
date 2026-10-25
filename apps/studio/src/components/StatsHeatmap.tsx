import { useQuery } from "@tanstack/react-query";
import { getDraft, type StatCount } from "@ttkpr/api-client";
import {
  bundleBounds,
  DEFAULT_GLYPHS,
  PLAN_FONT,
  sortedLevels,
  toCollections,
} from "@ttkpr/map-core";
import { cn } from "@ttkpr/ui";
import type { FeatureCollection } from "geojson";
import { type GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { unwrap } from "../lib/api";

const HEAT = "stats-heat";
const PLAN = "stats-units";

/**
 * Where visitors look: places weighted by how often their card was opened, as a heat glow over
 * the plan, with the count on each place. One floor at a time.
 */
export function StatsHeatmap({ mapId, counts }: { mapId: string; counts: StatCount[] }) {
  const draft = useQuery({
    queryKey: ["draft", mapId],
    queryFn: () => unwrap(getDraft({ path: { map_id: mapId } })),
  });
  const doc = draft.data?.document;
  const levels = doc ? sortedLevels(doc) : [];
  const [levelId, setLevelId] = useState<string | null>(null);
  const level = levelId ?? levels[0]?.id ?? "";
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  useEffect(() => {
    if (!doc || !container.current) return;
    const bounds = bundleBounds(doc);
    const map = new MapLibreMap({
      container: container.current,
      style: {
        version: 8,
        glyphs: DEFAULT_GLYPHS,
        sources: {},
        layers: [{ id: "bg", type: "background", paint: { "background-color": "#e9eef3" } }],
      },
      ...(bounds
        ? { bounds, fitBoundsOptions: { padding: 32 } }
        : { center: doc.venue.anchor, zoom: 18 }),
      attributionControl: false,
      dragRotate: false,
    });
    mapRef.current = map;
    map.on("load", () => {
      map.addSource(PLAN, { type: "geojson", data: toCollections(doc).units });
      map.addSource(HEAT, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "units", type: "fill", source: PLAN, paint: { "fill-color": "#f8fafc" } });
      map.addLayer({
        id: "units-line",
        type: "line",
        source: PLAN,
        paint: { "line-color": "#94a3b8", "line-width": 1 },
      });
      map.addLayer({
        id: "heat",
        type: "heatmap",
        source: HEAT,
        paint: {
          "heatmap-weight": ["get", "weight"],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 16, 25, 20, 90],
          "heatmap-intensity": 1.2,
          "heatmap-opacity": 0.85,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(37,99,235,0)",
            0.2,
            "#60a5fa",
            0.45,
            "#facc15",
            0.7,
            "#f97316",
            1,
            "#dc2626",
          ],
        },
      });
      map.addLayer({
        id: "heat-count",
        type: "symbol",
        source: HEAT,
        layout: {
          "text-field": ["concat", ["get", "name"], "\n", ["to-string", ["get", "count"]]],
          "text-font": PLAN_FONT,
          "text-size": 12,
        },
        paint: { "text-color": "#0f172a", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
      });
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [doc]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !doc) return;
    const byId = new Map(counts.map((c) => [c.key, c.count]));
    const max = Math.max(1, ...counts.map((c) => c.count));
    const heat: FeatureCollection = {
      type: "FeatureCollection",
      features: (doc.pois ?? [])
        .filter((p) => p.levelId === level && byId.has(p.id))
        .map((p) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: p.position },
          properties: {
            name: p.name,
            count: byId.get(p.id) ?? 0,
            weight: (byId.get(p.id) ?? 0) / max,
          },
        })),
    };
    const apply = () => {
      (map.getSource(HEAT) as GeoJSONSource | undefined)?.setData(heat);
      if (map.getLayer("units")) {
        const onLevel = ["==", ["get", "levelId"], level] as ["==", ["get", string], string];
        map.setFilter("units", onLevel);
        map.setFilter("units-line", onLevel);
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [counts, doc, level]);

  if (!doc) return null;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Куда смотрят гости</h2>
        {levels.length > 1 && (
          <div className="flex gap-1 rounded-xl bg-surface p-1">
            {levels.map((l) => (
              <button
                key={l.id}
                type="button"
                aria-pressed={l.id === level}
                onClick={() => setLevelId(l.id)}
                className={cn(
                  "min-h-9 rounded-lg px-3 text-sm font-medium",
                  l.id === level ? "bg-bg shadow" : "text-muted",
                )}
              >
                {l.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        ref={container}
        className="h-80 w-full overflow-hidden rounded-2xl border border-border"
        aria-label="Тепловая карта открытий мест"
        role="img"
      />
      {counts.length === 0 && (
        <p className="text-sm text-muted">Тепло появится, когда гости начнут открывать места.</p>
      )}
    </section>
  );
}

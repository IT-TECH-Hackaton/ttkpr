import {
  buildNavGraph,
  type Endpoint,
  findRoute,
  type LonLat,
  type MapBundle,
  type NavGraph,
  poiNodeId,
  type Route,
  roomAt,
} from "@ttkpr/map-core";
import type { FeatureCollection, LineString, Point } from "geojson";
import { useMemo } from "react";

export type End = "from" | "to";

/** URL form of an endpoint: a POI id, or "@lon,lat,levelId" for a point picked on the map. */
export function parseEndpoint(value: string | undefined): Endpoint | null {
  if (!value) return null;
  if (!value.startsWith("@")) return { poiId: value };
  const [lon, lat, ...level] = value.slice(1).split(",");
  const position: LonLat = [Number(lon), Number(lat)];
  const levelId = level.join(",");
  return levelId && position.every(Number.isFinite) ? { levelId, position } : null;
}

export function formatEndpoint(endpoint: Endpoint): string {
  if ("poiId" in endpoint) return endpoint.poiId;
  const [lon, lat] = endpoint.position;
  return `@${lon.toFixed(6)},${lat.toFixed(6)},${endpoint.levelId}`;
}

export function endpointLabel(bundle: MapBundle, endpoint: Endpoint | null, hereId?: string) {
  if (!endpoint) return null;
  if (!("poiId" in endpoint)) return "Точка на карте";
  const name = bundle.pois?.find((p) => p.id === endpoint.poiId)?.name ?? "Место";
  return endpoint.poiId === hereId ? `Вы здесь · ${name}` : name;
}

export interface RouteState {
  from: Endpoint | null;
  to: Endpoint | null;
  route: Route | null;
  /** Why there is no route although both ends are set. */
  problem: string | null;
}

export function useNavGraph(bundle: MapBundle | undefined) {
  return useMemo(() => (bundle ? buildNavGraph(bundle) : null), [bundle]);
}

export function useRoute(
  bundle: MapBundle | undefined,
  graph: NavGraph | null,
  fromParam: string | undefined,
  toParam: string | undefined,
  avoidStairs: boolean,
): RouteState {
  return useMemo(() => {
    const from = parseEndpoint(fromParam);
    const to = parseEndpoint(toParam);
    const none = { from, to, route: null };
    if (!bundle || !graph || !from || !to) return { ...none, problem: null };
    if (fromParam === toParam) return { ...none, problem: "Начало и конец маршрута совпадают" };

    for (const end of [from, to]) {
      if ("poiId" in end) {
        if (graph.nodes.has(poiNodeId(end.poiId))) continue;
        const name = bundle.pois?.find((p) => p.id === end.poiId)?.name;
        return { ...none, problem: name ? `К «${name}» на плане нет прохода` : "Место не найдено" };
      }
      if (!roomAt(graph, end.levelId, end.position)) {
        return { ...none, problem: "Точка вне помещений плана — выберите место внутри" };
      }
    }

    const route = findRoute(graph, bundle, from, to, { avoidStairs });
    if (route) return { from, to, route, problem: null };
    const withStairs = avoidStairs ? findRoute(graph, bundle, from, to) : null;
    return {
      ...none,
      problem: withStairs
        ? "Без ступенек не пройти: на этом пути только лестницы"
        : "Между этими точками нет прохода по плану",
    };
  }, [bundle, graph, fromParam, toParam, avoidStairs]);
}

interface MarkProps {
  levelId: string;
  kind: "start" | "end" | "floor" | "here";
  label: string;
}

/** GeoJSON for the plan: the route legs, and start / finish / floor-change / "Вы здесь" marks. */
export function routeFeatures(
  bundle: MapBundle,
  route: Route | null,
  hereId: string | undefined,
): {
  lines: FeatureCollection<LineString, { levelId: string }>;
  marks: FeatureCollection<Point, MarkProps>;
} {
  const levelName = (id: string) => bundle.levels?.find((l) => l.id === id)?.name ?? "";
  const ordinal = (id: string) => bundle.levels?.find((l) => l.id === id)?.ordinal ?? 0;
  const mark = (position: LonLat, props: MarkProps) => ({
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: position },
    properties: props,
  });
  const marks = [];
  const here = bundle.pois?.find((p) => p.id === hereId);
  if (here)
    marks.push(mark(here.position, { levelId: here.levelId, kind: "here", label: "Вы здесь" }));
  if (route) {
    const first = route.steps[0];
    const last = route.steps.at(-1);
    if (first && first.position.join() !== here?.position.join()) {
      marks.push(mark(first.position, { levelId: first.levelId, kind: "start", label: "" }));
    }
    for (const step of route.steps) {
      if (step.kind !== "floor" || !step.toLevelId) continue;
      const up = ordinal(step.toLevelId) > ordinal(step.levelId);
      marks.push(
        mark(step.position, {
          levelId: step.levelId,
          kind: "floor",
          label: `${up ? "↑" : "↓"} ${levelName(step.toLevelId)}`,
        }),
      );
      // Where the next leg starts on the floor reached.
      const arrival = route.legs.find((l) => l.levelId === step.toLevelId)?.coordinates[0];
      if (arrival) {
        marks.push(
          mark(arrival, {
            levelId: step.toLevelId,
            kind: "floor",
            label: `с ${levelName(step.levelId)}`,
          }),
        );
      }
    }
    if (last) marks.push(mark(last.position, { levelId: last.levelId, kind: "end", label: "" }));
  }
  return {
    lines: {
      type: "FeatureCollection",
      features: (route?.legs ?? [])
        .filter((leg) => leg.coordinates.length > 1)
        .map((leg) => ({
          type: "Feature",
          geometry: { type: "LineString", coordinates: leg.coordinates },
          properties: { levelId: leg.levelId },
        })),
    },
    marks: { type: "FeatureCollection", features: marks },
  };
}

/** Bounds of the route on one level, for fitBounds. */
export function legBounds(route: Route, levelId: string): [LonLat, LonLat] | null {
  const points = route.legs.filter((l) => l.levelId === levelId).flatMap((l) => l.coordinates);
  if (points.length === 0) return null;
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}

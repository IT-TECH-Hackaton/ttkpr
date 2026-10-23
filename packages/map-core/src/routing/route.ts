import type { MapBundle } from "../bundle";
import type { LonLat, XY } from "../geo";
import { turnAngle } from "./geometry";
import { type NavEdge, type NavGraph, type NavNode, poiNodeId, toLonLat, withPoint } from "./graph";

/** A POI or an arbitrary point on a level ("Вы здесь", tapped on the map). */
export type Endpoint = { poiId: string } | { levelId: string; position: LonLat };

export interface RouteOptions {
  /** Wheelchairs, strollers, luggage: no stairs, no escalators. */
  avoidStairs?: boolean;
}

export interface RouteLeg {
  levelId: string;
  coordinates: LonLat[];
}

export type StepKind = "start" | "walk" | "door" | "turn" | "floor" | "arrive";

export interface RouteStep {
  kind: StepKind;
  text: string;
  levelId: string;
  position: LonLat;
  /** Meters walked since the previous step. */
  distanceM: number;
  /** For floor changes: the level reached. */
  toLevelId?: string;
}

export interface Route {
  legs: RouteLeg[];
  steps: RouteStep[];
  distanceM: number;
  durationS: number;
  /** Ordered path through the graph, for panoramas along the way. */
  path: { levelId: string; xy: XY }[];
  usesStairs: boolean;
}

const WALK_SPEED_MPS = 1.2;
const FLOOR_SECONDS: Record<NavEdge["kind"], number> = {
  walk: 0,
  stairs: 15,
  escalator: 12,
  ramp: 10,
  elevator: 40,
};

/** Binary min-heap of [cost, nodeId] for Dijkstra. */
class MinHeap {
  private items: [number, string][] = [];

  get size() {
    return this.items.length;
  }

  private at(i: number) {
    return this.items[i] as [number, string];
  }

  private swap(i: number, j: number) {
    const tmp = this.at(i);
    this.items[i] = this.at(j);
    this.items[j] = tmp;
  }

  push(item: [number, string]) {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.at(parent)[0] <= this.at(i)[0]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): [number, string] | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.at(0);
    const last = this.items.pop() as [number, string];
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.at(l)[0] < this.at(m)[0]) m = l;
        if (r < this.items.length && this.at(r)[0] < this.at(m)[0]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

function shortestPath(graph: NavGraph, from: string, to: string, options: RouteOptions) {
  const best = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { node: string; edge: NavEdge }>();
  const heap = new MinHeap();
  heap.push([0, from]);
  while (heap.size) {
    const [cost, id] = heap.pop() as [number, string];
    if (id === to) break;
    if (cost > (best.get(id) ?? Number.POSITIVE_INFINITY)) continue;
    for (const edge of graph.edges.get(id) ?? []) {
      if (options.avoidStairs && (edge.kind === "stairs" || edge.kind === "escalator")) continue;
      const next = cost + edge.cost;
      if (next < (best.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        best.set(edge.to, next);
        prev.set(edge.to, { node: id, edge });
        heap.push([next, edge.to]);
      }
    }
  }
  if (!best.has(to)) return null;
  const nodes: string[] = [to];
  const used: NavEdge[] = [];
  for (let cur = to; cur !== from; ) {
    const step = prev.get(cur);
    if (!step) return null;
    used.unshift(step.edge);
    nodes.unshift(step.node);
    cur = step.node;
  }
  return { nodes, edges: used };
}

function endpointNode(
  graph: NavGraph,
  endpoint: Endpoint,
  id: string,
): { graph: NavGraph; node: string } | null {
  if ("poiId" in endpoint) {
    const node = poiNodeId(endpoint.poiId);
    return graph.nodes.has(node) ? { graph, node } : null;
  }
  const extended = withPoint(graph, id, endpoint.levelId, endpoint.position);
  return extended ? { graph: extended, node: id } : null;
}

const quote = (name: string | undefined | null) => (name ? `«${name}»` : "");
const roundDistance = (m: number) => (m < 10 ? Math.max(1, Math.round(m)) : Math.round(m / 5) * 5);

export function findRoute(
  base: NavGraph,
  bundle: MapBundle,
  from: Endpoint,
  to: Endpoint,
  options: RouteOptions = {},
): Route | null {
  const start = endpointNode(base, from, "point:from");
  if (!start) return null;
  const end = endpointNode(start.graph, to, "point:to");
  if (!end) return null;
  const graph = end.graph;
  const found = shortestPath(graph, start.node, end.node, options);
  if (!found) return null;

  const nodes = found.nodes.map((id) => graph.nodes.get(id) as NavNode);
  const levelName = (id: string) => bundle.levels?.find((l) => l.id === id)?.name ?? id;
  const unitName = (id: string) => bundle.units?.find((u) => u.id === id)?.name ?? null;
  const nameOf = (endpoint: Endpoint, fallback: string) => {
    const name =
      "poiId" in endpoint ? bundle.pois?.find((p) => p.id === endpoint.poiId)?.name : null;
    return name ? quote(name) : fallback;
  };

  // Legs: consecutive nodes on the same level.
  const legs: RouteLeg[] = [];
  for (const node of nodes) {
    const last = legs.at(-1);
    const position = toLonLat(graph, node.xy);
    if (last && last.levelId === node.levelId) last.coordinates.push(position);
    else legs.push({ levelId: node.levelId, coordinates: [position] });
  }

  const steps: RouteStep[] = [];
  let sinceLast = 0;
  let distanceM = 0;
  let durationS = 0;
  let usesStairs = false;
  const first = nodes[0] as NavNode;
  steps.push({
    kind: "start",
    text: `Начните у ${nameOf(from, "отмеченной точки")}`,
    levelId: first.levelId,
    position: toLonLat(graph, first.xy),
    distanceM: 0,
  });

  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i] as NavNode;
    const prev = nodes[i - 1] as NavNode;
    const edge = found.edges[i - 1] as NavEdge;
    if (edge.kind !== "walk") {
      const up =
        (bundle.levels?.find((l) => l.id === node.levelId)?.ordinal ?? 0) >
        (bundle.levels?.find((l) => l.id === prev.levelId)?.ordinal ?? 0);
      const how =
        edge.kind === "elevator"
          ? "на лифте"
          : edge.kind === "escalator"
            ? "на эскалаторе"
            : edge.kind === "ramp"
              ? "по пандусу"
              : "по лестнице";
      usesStairs ||= edge.kind === "stairs" || edge.kind === "escalator";
      durationS += FLOOR_SECONDS[edge.kind];
      steps.push({
        kind: "floor",
        text: `${up ? "Поднимитесь" : "Спуститесь"} ${how} на ${levelName(node.levelId)}`,
        levelId: prev.levelId,
        position: toLonLat(graph, prev.xy),
        distanceM: sinceLast,
        toLevelId: node.levelId,
      });
      sinceLast = 0;
      continue;
    }
    sinceLast += edge.length;
    distanceM += edge.length;
    durationS += edge.length / WALK_SPEED_MPS;
    const next = nodes[i + 1];
    if (i === nodes.length - 1 || !next) continue;
    if (node.kind === "door") {
      // Name the room we enter: the door's room that the next node is in too.
      const entered = node.unitIds.find(
        (u) => next.unitIds.includes(u) && !prev.unitIds.includes(u),
      );
      const name = entered ? unitName(entered) : null;
      steps.push({
        kind: "door",
        text: name ? `Пройдите через дверь в ${quote(name)}` : "Пройдите через дверь",
        levelId: node.levelId,
        position: toLonLat(graph, node.xy),
        distanceM: sinceLast,
      });
      sinceLast = 0;
    } else if (next.levelId === node.levelId) {
      const angle = turnAngle(prev.xy, node.xy, next.xy);
      if (Math.abs(angle) <= 35 || next.kind === "door") continue; // turning towards a door is implied
      const turn =
        Math.abs(angle) > 135
          ? "Развернитесь"
          : angle > 0
            ? "Поверните налево"
            : "Поверните направо";
      const door = steps.at(-1);
      if (node.kind === "approach" && prev.kind === "door" && door?.kind === "door") {
        // Right behind the door: "Пройдите через дверь в «Коридор» и поверните направо".
        door.text = `${door.text} и ${turn.toLowerCase()}`;
        continue;
      }
      steps.push({
        kind: "turn",
        text: turn,
        levelId: node.levelId,
        position: toLonLat(graph, node.xy),
        distanceM: sinceLast,
      });
      sinceLast = 0;
    }
  }
  const last = nodes.at(-1) as NavNode;
  steps.push({
    kind: "arrive",
    text: `Вы на месте: ${nameOf(to, "точка назначения")}`,
    levelId: last.levelId,
    position: toLonLat(graph, last.xy),
    distanceM: sinceLast,
  });

  return {
    legs,
    steps,
    distanceM,
    durationS,
    path: nodes.map((n) => ({ levelId: n.levelId, xy: n.xy })),
    usesStairs,
  };
}

/** The next instruction once `along` meters of the route are behind, and how far ahead it is. */
export function nextStep(route: Route, along: number): { step: RouteStep; inM: number } | null {
  let at = 0;
  for (const step of route.steps) {
    at += step.distanceM;
    if (step.kind !== "start" && at > along + 0.5) return { step, inM: at - along };
  }
  const last = route.steps.at(-1);
  return last ? { step: last, inM: 0 } : null;
}

/** "через 15 м" style prefix for a step. */
export function stepDistance(step: RouteStep): string {
  return step.distanceM >= 1 ? `через ${roundDistance(step.distanceM)} м` : "";
}

export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} мин`;
}

export function formatDistance(meters: number): string {
  return meters < 1000 ? `${roundDistance(meters)} м` : `${(meters / 1000).toFixed(1)} км`;
}

/** Which points cannot be reached from the entrance or from each other (for the studio). */
export function unreachablePois(graph: NavGraph, bundle: MapBundle): string[] {
  const pois = bundle.pois ?? [];
  const inGraph = pois.filter((p) => graph.nodes.has(poiNodeId(p.id)));
  const missing = pois.filter((p) => !graph.nodes.has(poiNodeId(p.id))).map((p) => p.id);
  if (inGraph.length < 2) return missing;
  // Largest connected component wins; everything else is cut off.
  const component = new Map<string, number>();
  let index = 0;
  const sizes: number[] = [];
  for (const start of graph.nodes.keys()) {
    if (component.has(start)) continue;
    const stack = [start];
    component.set(start, index);
    let size = 0;
    while (stack.length) {
      const id = stack.pop() as string;
      size++;
      for (const e of graph.edges.get(id) ?? []) {
        if (!component.has(e.to)) {
          component.set(e.to, index);
          stack.push(e.to);
        }
      }
    }
    sizes.push(size);
    index++;
  }
  const poiComponents = inGraph.map((p) => component.get(poiNodeId(p.id)) ?? -1);
  const counts = new Map<number, number>();
  for (const c of poiComponents) counts.set(c, (counts.get(c) ?? 0) + 1);
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return [...missing, ...inGraph.filter((_, i) => poiComponents[i] !== main).map((p) => p.id)];
}

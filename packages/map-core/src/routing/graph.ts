// Navigation graph built from the map itself: doors join rooms, stairs and lifts join floors,
// inside a room you walk in straight lines (bending around concave corners).

import type { Unit } from "@ttkpr/api-client";
import type { MapBundle } from "../bundle";
import { fromLocal, type LonLat, toLocal, type XY } from "../geo";
import { dist, distanceToRing, insideRing, reflexCorners, visibleInside } from "./geometry";

export type NodeKind = "door" | "approach" | "poi" | "connector" | "corner" | "point";

export interface NavNode {
  id: string;
  kind: NodeKind;
  levelId: string;
  xy: XY;
  /** Rooms this node belongs to (a door belongs to the two rooms it joins). */
  unitIds: string[];
  /** Door / POI / connector id in the document. */
  ref?: string;
}

export interface NavEdge {
  to: string;
  cost: number;
  /** Physical length on the plan (0 for lifts). */
  length: number;
  kind: "walk" | "stairs" | "elevator" | "escalator" | "ramp";
  connectorId?: string;
}

export interface NavGraph {
  anchor: LonLat;
  nodes: Map<string, NavNode>;
  edges: Map<string, NavEdge[]>;
  /** Walkable rooms per level, with rings in local meters. */
  rooms: Map<string, { unit: Unit; ring: XY[] }[]>;
}

const DOOR_SNAP_M = 0.35;
const POI_ATTACH_M = 1.5;
/** Paths keep this far from walls: doors are approached from inside the room, corners rounded. */
const CLEARANCE_M = 0.9;

/** Meters-equivalent cost of changing one floor, on top of the horizontal walk. */
export const CONNECTOR_COST: Record<NavEdge["kind"], number> = {
  walk: 0,
  stairs: 8,
  escalator: 6,
  ramp: 4,
  elevator: 25, // waiting for the lift
};

export const poiNodeId = (poiId: string) => `poi:${poiId}`;
const connectorNodeId = (connectorId: string, levelId: string) => `con:${connectorId}@${levelId}`;

export function buildNavGraph(bundle: MapBundle): NavGraph {
  const anchor = bundle.venue.anchor;
  const local = (p: LonLat) => toLocal(anchor, p);
  const nodes = new Map<string, NavNode>();
  const edges = new Map<string, NavEdge[]>();
  const rooms = new Map<string, { unit: Unit; ring: XY[] }[]>();

  for (const unit of bundle.units ?? []) {
    if (unit.walkable === false || unit.category === "nonpublic") continue;
    const ring = (unit.geometry.coordinates[0] ?? []).map((c) => local(c as LonLat));
    if (ring.length < 4) continue;
    const list = rooms.get(unit.levelId) ?? [];
    list.push({ unit, ring });
    rooms.set(unit.levelId, list);
  }

  const roomsAt = (levelId: string, xy: XY, tolerance: number) =>
    (rooms.get(levelId) ?? [])
      .filter((r) => insideRing(xy, r.ring, tolerance))
      .map((r) => r.unit.id);

  const add = (node: NavNode) => {
    nodes.set(node.id, node);
    edges.set(node.id, []);
  };

  // Doors: on the wall between two rooms (or one room and the outside for entrances). Each
  // room gets an approach point a little inside, so routes do not hug the wall.
  const doorLinks: [string, string, number][] = [];
  for (const opening of bundle.openings ?? []) {
    const [a, b] = opening.geometry.coordinates.map((c) => local(c as LonLat)) as [XY, XY];
    const mid: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const sides = (rooms.get(opening.levelId) ?? []).filter(
      (r) => distanceToRing(mid, r.ring) <= DOOR_SNAP_M,
    );
    if (sides.length === 0) continue;
    const doorId = `door:${opening.id}`;
    add({
      id: doorId,
      kind: "door",
      levelId: opening.levelId,
      xy: mid,
      unitIds: sides.map((r) => r.unit.id),
      ref: opening.id,
    });
    const len = dist(a, b) || 1;
    const normal: XY = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    for (const side of sides) {
      const approach = approachPoint(mid, normal, side.ring);
      const id = `approach:${opening.id}:${side.unit.id}`;
      add({
        id,
        kind: "approach",
        levelId: opening.levelId,
        xy: approach,
        unitIds: [side.unit.id],
      });
      doorLinks.push([doorId, id, dist(mid, approach)]);
    }
  }

  for (const poi of bundle.pois ?? []) {
    const xy = local(poi.position);
    const unitIds = roomsAt(poi.levelId, xy, POI_ATTACH_M);
    if (unitIds.length === 0) continue;
    add({ id: poiNodeId(poi.id), kind: "poi", levelId: poi.levelId, xy, unitIds, ref: poi.id });
  }

  for (const connector of bundle.connectors ?? []) {
    for (const point of connector.points) {
      const xy = local(point.position);
      const unitIds = roomsAt(point.levelId, xy, POI_ATTACH_M);
      if (unitIds.length === 0) continue;
      add({
        id: connectorNodeId(connector.id, point.levelId),
        kind: "connector",
        levelId: point.levelId,
        xy,
        unitIds,
        ref: connector.id,
      });
    }
  }

  for (const [levelId, list] of rooms) {
    for (const { unit, ring } of list) {
      reflexCorners(ring, CLEARANCE_M).forEach((xy, i) => {
        add({ id: `corner:${unit.id}:${i}`, kind: "corner", levelId, xy, unitIds: [unit.id] });
      });
    }
  }

  // Inside each room: straight lines between every pair of its nodes that see each other.
  const byUnit = new Map<string, NavNode[]>();
  for (const node of nodes.values()) {
    if (node.kind === "door") continue; // reached only through its approach points
    for (const unitId of node.unitIds) byUnit.set(unitId, [...(byUnit.get(unitId) ?? []), node]);
  }
  for (const list of rooms.values()) {
    for (const { unit, ring } of list) connectRoom(byUnit.get(unit.id) ?? [], ring, edges);
  }
  for (const [door, approach, length] of doorLinks) {
    edges.get(door)?.push({ to: approach, cost: length, length, kind: "walk" });
    edges.get(approach)?.push({ to: door, cost: length, length, kind: "walk" });
  }

  // Between floors: every pair of points of the same stairs/lift.
  const levelOrdinal = new Map((bundle.levels ?? []).map((l) => [l.id, l.ordinal]));
  for (const connector of bundle.connectors ?? []) {
    const points = connector.points
      .map((p) => nodes.get(connectorNodeId(connector.id, p.levelId)))
      .filter((n): n is NavNode => Boolean(n));
    for (const a of points) {
      for (const b of points) {
        if (a === b) continue;
        const floors =
          Math.abs((levelOrdinal.get(a.levelId) ?? 0) - (levelOrdinal.get(b.levelId) ?? 0)) || 1;
        const kind = connector.kind;
        const cost =
          kind === "elevator"
            ? CONNECTOR_COST.elevator + 3 * floors
            : CONNECTOR_COST[kind] * floors;
        edges.get(a.id)?.push({ to: b.id, cost, length: 0, kind, connectorId: connector.id });
      }
    }
  }

  return { anchor, nodes, edges, rooms };
}

function connectRoom(nodes: NavNode[], ring: XY[], edges: Map<string, NavEdge[]>) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i] as NavNode;
      const b = nodes[j] as NavNode;
      if (!visibleInside(a.xy, b.xy, ring)) continue;
      const length = dist(a.xy, b.xy);
      edges.get(a.id)?.push({ to: b.id, cost: length, length, kind: "walk" });
      edges.get(b.id)?.push({ to: a.id, cost: length, length, kind: "walk" });
    }
  }
}

/** Adds a free point (e.g. "здесь" tapped on the map) to a copy of the graph. */
export function withPoint(
  graph: NavGraph,
  id: string,
  levelId: string,
  position: LonLat,
): NavGraph | null {
  const xy = toLocal(graph.anchor, position);
  const room = (graph.rooms.get(levelId) ?? []).find((r) => insideRing(xy, r.ring, POI_ATTACH_M));
  if (!room) return null;
  const nodes = new Map(graph.nodes);
  const edges = new Map([...graph.edges].map(([k, v]) => [k, [...v]]));
  const node: NavNode = { id, kind: "point", levelId, xy, unitIds: [room.unit.id] };
  nodes.set(id, node);
  edges.set(id, []);
  const peers = [...graph.nodes.values()].filter(
    (n) => n.kind !== "door" && n.unitIds.includes(room.unit.id),
  );
  connectRoom([node, ...peers], room.ring, edges);
  // connectRoom also re-adds peer-peer edges; keep only the ones touching the new node.
  for (const peer of peers) {
    const original = graph.edges.get(peer.id) ?? [];
    edges.set(peer.id, [...original, ...(edges.get(peer.id) ?? []).filter((e) => e.to === id)]);
  }
  return { ...graph, nodes, edges };
}

export const toLonLat = (graph: NavGraph, xy: XY) => fromLocal(graph.anchor, xy);

/** The walkable room under a point (with the same tolerance routes use), or null. */
export function roomAt(graph: NavGraph, levelId: string, position: LonLat): Unit | null {
  const xy = toLocal(graph.anchor, position);
  return (
    (graph.rooms.get(levelId) ?? []).find((r) => insideRing(xy, r.ring, POI_ATTACH_M))?.unit ?? null
  );
}

/** A point `CLEARANCE_M` into the room from the door (less in narrow rooms). */
function approachPoint(mid: XY, normal: XY, ring: XY[]): XY {
  for (const depth of [CLEARANCE_M, 0.5, 0.25]) {
    for (const sign of [1, -1]) {
      const p: XY = [mid[0] + normal[0] * depth * sign, mid[1] + normal[1] * depth * sign];
      if (insideRing(p, ring) && distanceToRing(p, ring) >= depth * 0.9) return p;
    }
  }
  return mid;
}

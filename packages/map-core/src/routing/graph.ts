// Navigation graph built from the map itself: doors join rooms, stairs and lifts join floors,
// inside a room you walk in straight lines, bending around concave corners and furniture.

import type { Opening, Unit } from "@ttkpr/api-client";
import type { MapBundle } from "../bundle";
import { fromLocal, type LonLat, toLocal, type XY } from "../geo";
import { groundLevelId } from "../layers";
import {
  type BBox,
  closeRing,
  crossesInterior,
  dist,
  distanceToRing,
  insideRing,
  isConvexRing,
  outwardCorners,
  reflexCorners,
  ringBounds,
  ringsOverlap,
  segmentRingDistance,
  signedArea,
  visibleInside,
} from "./geometry";

export type NodeKind = "door" | "approach" | "poi" | "connector" | "corner" | "path" | "point";

export interface NavNode {
  id: string;
  kind: NodeKind;
  levelId: string;
  xy: XY;
  /** Rooms this node belongs to (a door belongs to the two rooms it joins). */
  unitIds: string[];
  /** Door / POI / connector id in the document. */
  ref?: string;
  /** Obstacles (fixture ids) this node stands inside: a place on a stand or a stage. */
  within?: string[];
  /** A place inside an obstacle: routes start or end there but never pass through it. */
  enclosed?: boolean;
}

export interface NavEdge {
  to: string;
  cost: number;
  /** Physical length on the plan (0 for lifts). */
  length: number;
  kind: "walk" | "stairs" | "elevator" | "escalator" | "ramp";
  connectorId?: string;
  /** Not for wheelchairs and strollers (a revolving or narrow door): skipped without steps. */
  barrier?: "revolving" | "narrow";
}

/** A fixture routes go around, in local meters. */
export interface Obstacle {
  /** Fixture id. */
  id: string;
  /** Closed outline. */
  ring: XY[];
  bbox: BBox;
}

/** A walkable room in local meters. */
export interface RoomArea {
  unit: Unit;
  ring: XY[];
  /** Obstacles overlapping the room: holes in its floor. */
  obstacles?: Obstacle[];
  /** No concave corners: a line between two points inside needs no further checks. */
  convex?: boolean;
}

export interface NavGraph {
  anchor: LonLat;
  nodes: Map<string, NavNode>;
  edges: Map<string, NavEdge[]>;
  /** Walkable rooms per level, with rings in local meters. */
  rooms: Map<string, RoomArea[]>;
}

const DOOR_SNAP_M = 0.35;
const POI_ATTACH_M = 1.5;
/** Paths keep this far from walls: doors are approached from inside the room, corners rounded. */
const CLEARANCE_M = 0.9;
/** A walkway end this close to an entrance leads into the building. */
const PATH_DOOR_M = 3;
/** Walkways are slightly preferred over cutting across a yard. */
const PATH_PREFERENCE = 0.95;
/** Routes bend around furniture this far from it (corner nodes)... */
export const FIXTURE_CLEARANCE_M = 0.45;
/** ...and straight lines keep at least this far, so aisles from about 0.8 m stay passable. */
export const FIXTURE_PASS_M = 0.35;
/** Doors narrower than this are not step-free (a wheelchair needs 0.8 m). */
export const STEP_FREE_DOOR_WIDTH_M = 0.8;

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

/** Rooms visitors may walk through: public and not marked non-walkable or non-public. */
export function isWalkableUnit(unit: Unit): boolean {
  return (
    unit.walkable !== false &&
    unit.category !== "nonpublic" &&
    (unit.access ?? "public") === "public"
  );
}

/** Openings routes use: public doors, passages and entrances. Windows never. */
export function isPassableOpening(opening: Opening): boolean {
  return opening.category !== "window" && (opening.access ?? "public") === "public";
}

/** Why a wheelchair cannot pass this door, if it cannot. */
export function doorBarrier(opening: Opening): NavEdge["barrier"] | null {
  if (opening.kind === "revolving") return "revolving";
  if (opening.widthM != null && opening.widthM < STEP_FREE_DOOR_WIDTH_M) return "narrow";
  return null;
}

/** Obstacle fixtures by level, in local meters (degenerate outlines dropped). */
export function obstaclesByLevel(bundle: MapBundle): Map<string, Obstacle[]> {
  const anchor = bundle.venue.anchor;
  const byLevel = new Map<string, Obstacle[]>();
  for (const fixture of bundle.fixtures ?? []) {
    if (fixture.obstacle === false) continue;
    const ring = closeRing(
      (fixture.geometry.coordinates[0] ?? []).map((c) => toLocal(anchor, c as LonLat)),
    );
    if (ring.length < 4 || Math.abs(signedArea(ring)) < 1e-4) continue;
    const list = byLevel.get(fixture.levelId) ?? [];
    list.push({ id: fixture.id, ring, bbox: ringBounds(ring) });
    byLevel.set(fixture.levelId, list);
  }
  return byLevel;
}

const obstaclesAt = (xy: XY, obstacles: Obstacle[] | undefined): string[] =>
  (obstacles ?? []).filter((o) => insideRing(xy, o.ring)).map((o) => o.id);

export function buildNavGraph(bundle: MapBundle): NavGraph {
  const anchor = bundle.venue.anchor;
  const local = (p: LonLat) => toLocal(anchor, p);
  const nodes = new Map<string, NavNode>();
  const edges = new Map<string, NavEdge[]>();
  const rooms = new Map<string, RoomArea[]>();
  const fixtures = obstaclesByLevel(bundle);

  for (const unit of bundle.units ?? []) {
    if (!isWalkableUnit(unit)) continue;
    const ring = (unit.geometry.coordinates[0] ?? []).map((c) => local(c as LonLat));
    if (ring.length < 4) continue;
    const obstacles = (fixtures.get(unit.levelId) ?? []).filter((o) => ringsOverlap(o.ring, ring));
    const list = rooms.get(unit.levelId) ?? [];
    list.push({
      unit,
      ring,
      convex: isConvexRing(ring),
      ...(obstacles.length ? { obstacles } : {}),
    });
    rooms.set(unit.levelId, list);
  }

  const roomsAt = (levelId: string, xy: XY, tolerance: number) =>
    (rooms.get(levelId) ?? []).filter((r) => insideRing(xy, r.ring, tolerance));
  /** Obstacles of these rooms that contain the point. */
  const withinOf = (list: RoomArea[], xy: XY) => [
    ...new Set(list.flatMap((r) => obstaclesAt(xy, r.obstacles))),
  ];

  const add = (node: NavNode) => {
    nodes.set(node.id, node);
    edges.set(node.id, []);
  };
  /** A node of some rooms; inside an obstacle it may leave the obstacle (and, if `sink`, only end there). */
  const addIn = (node: Omit<NavNode, "unitIds">, list: RoomArea[], sink = false) => {
    const within = withinOf(list, node.xy);
    add({
      ...node,
      unitIds: list.map((r) => r.unit.id),
      ...(within.length ? { within, ...(sink ? { enclosed: true } : {}) } : {}),
    });
  };

  // Doors: on the wall between two rooms (or one room and the outside for entrances). Each
  // room gets an approach point a little inside, so routes do not hug the wall.
  const doorLinks: {
    door: string;
    approach: string;
    length: number;
    barrier: NavEdge["barrier"] | null;
  }[] = [];
  for (const opening of bundle.openings ?? []) {
    if (!isPassableOpening(opening)) continue;
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
    const barrier = doorBarrier(opening);
    for (const side of sides) {
      const approach = approachPoint(mid, normal, side);
      const id = `approach:${opening.id}:${side.unit.id}`;
      addIn({ id, kind: "approach", levelId: opening.levelId, xy: approach }, [side]);
      doorLinks.push({ door: doorId, approach: id, length: dist(mid, approach), barrier });
    }
  }

  for (const poi of bundle.pois ?? []) {
    const xy = local(poi.position);
    const list = roomsAt(poi.levelId, xy, POI_ATTACH_M);
    if (list.length === 0) continue;
    addIn(
      { id: poiNodeId(poi.id), kind: "poi", levelId: poi.levelId, xy, ref: poi.id },
      list,
      true,
    );
  }

  for (const connector of bundle.connectors ?? []) {
    for (const point of connector.points) {
      const xy = local(point.position);
      const list = roomsAt(point.levelId, xy, POI_ATTACH_M);
      if (list.length === 0) continue;
      addIn(
        {
          id: connectorNodeId(connector.id, point.levelId),
          kind: "connector",
          levelId: point.levelId,
          xy,
          ref: connector.id,
        },
        list,
      );
    }
  }

  // Walkways drawn by the organizer (between buildings, across a yard): vertices join the rooms
  // they lie in, follow each other in order, and the ends lead into entrances nearby.
  const ground = groundLevelId(bundle);
  const pathLinks: [string, string, number][] = [];
  for (const line of bundle.paths ?? []) {
    const levelId = line.levelId ?? ground;
    if (!levelId) continue;
    const ids = line.geometry.coordinates.map((c, i) => {
      const xy = local(c as LonLat);
      const id = `path:${line.id}:${i}`;
      addIn({ id, kind: "path", levelId, xy, ref: line.id }, roomsAt(levelId, xy, 0.3));
      return id;
    });
    for (let i = 1; i < ids.length; i++) {
      const a = nodes.get(ids[i - 1] as string) as NavNode;
      const b = nodes.get(ids[i] as string) as NavNode;
      pathLinks.push([a.id, b.id, dist(a.xy, b.xy)]);
    }
    for (const end of [ids[0], ids.at(-1)]) {
      const node = nodes.get(end as string) as NavNode;
      for (const door of nodes.values()) {
        if (door.kind !== "door" || door.levelId !== levelId) continue;
        const d = dist(door.xy, node.xy);
        if (d <= PATH_DOOR_M) pathLinks.push([node.id, door.id, d]);
      }
    }
  }

  for (const [levelId, list] of rooms) {
    for (const room of list) {
      const { unit, ring, obstacles } = room;
      reflexCorners(ring, CLEARANCE_M).forEach((xy, i) => {
        if (obstaclesAt(xy, obstacles).length) return; // a table stands in the corner
        add({ id: `corner:${unit.id}:${i}`, kind: "corner", levelId, xy, unitIds: [unit.id] });
      });
      // Around furniture: its corners pushed out by the clearance, where there is floor.
      for (const obstacle of obstacles ?? []) {
        outwardCorners(obstacle.ring, FIXTURE_CLEARANCE_M).forEach((xy, i) => {
          if (!insideRing(xy, ring) || obstaclesAt(xy, obstacles).length) return;
          const id = `corner:${unit.id}:${obstacle.id}:${i}`;
          add({ id, kind: "corner", levelId, xy, unitIds: [unit.id] });
        });
      }
    }
  }

  // Inside each room: straight lines between every pair of its nodes that see each other.
  const byUnit = new Map<string, NavNode[]>();
  for (const node of nodes.values()) {
    if (node.kind === "door") continue; // reached only through its approach points
    for (const unitId of node.unitIds) byUnit.set(unitId, [...(byUnit.get(unitId) ?? []), node]);
  }
  for (const list of rooms.values()) {
    for (const room of list) connectRoom(byUnit.get(room.unit.id) ?? [], room, edges);
  }
  for (const { door, approach, length, barrier } of doorLinks) {
    const flag = barrier ? { barrier } : {};
    edges.get(door)?.push({ to: approach, cost: length, length, kind: "walk", ...flag });
    edges.get(approach)?.push({ to: door, cost: length, length, kind: "walk", ...flag });
  }
  for (const [a, b, length] of pathLinks) {
    const cost = length * PATH_PREFERENCE;
    edges.get(a)?.push({ to: b, cost, length, kind: "walk" });
    edges.get(b)?.push({ to: a, cost, length, kind: "walk" });
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

/** A straight walk inside the room: within its outline and clear of its furniture. */
function sees(a: NavNode, b: NavNode, room: RoomArea): boolean {
  if (room.obstacles && !clearOfObstacles(a, b, room.obstacles)) return false;
  // Convex outline: both ends inside (with the sampling tolerance) means the whole line is.
  if (room.convex && insideRing(a.xy, room.ring, 0.05) && insideRing(b.xy, room.ring, 0.05)) {
    return true;
  }
  return visibleInside(a.xy, b.xy, room.ring);
}

/**
 * The line keeps `FIXTURE_PASS_M` from every obstacle. An end standing closer than that (a place
 * right at a table) relaxes it to its own distance, and an end inside an obstacle may leave it.
 */
function clearOfObstacles(a: NavNode, b: NavNode, obstacles: Obstacle[]): boolean {
  const minX = Math.min(a.xy[0], b.xy[0]) - FIXTURE_PASS_M;
  const maxX = Math.max(a.xy[0], b.xy[0]) + FIXTURE_PASS_M;
  const minY = Math.min(a.xy[1], b.xy[1]) - FIXTURE_PASS_M;
  const maxY = Math.max(a.xy[1], b.xy[1]) + FIXTURE_PASS_M;
  for (const o of obstacles) {
    const [x0, y0, x1, y1] = o.bbox;
    if (x0 > maxX || x1 < minX || y0 > maxY || y1 < minY) continue;
    if (a.within?.includes(o.id) || b.within?.includes(o.id)) continue;
    const d = segmentRingDistance(a.xy, b.xy, o.ring);
    if (d >= FIXTURE_PASS_M) continue;
    const limit = Math.min(distanceToRing(a.xy, o.ring), distanceToRing(b.xy, o.ring));
    if (limit >= FIXTURE_PASS_M) return false;
    if (limit > 1e-6 ? d < limit - 1e-6 : crossesInterior(a.xy, b.xy, o.ring)) return false;
  }
  return true;
}

function connectRoom(nodes: NavNode[], room: RoomArea, edges: Map<string, NavEdge[]>) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i] as NavNode;
      const b = nodes[j] as NavNode;
      if (!sees(a, b, room)) continue;
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
  const within = obstaclesAt(xy, room.obstacles);
  const node: NavNode = {
    id,
    kind: "point",
    levelId,
    xy,
    unitIds: [room.unit.id],
    ...(within.length ? { within, enclosed: true } : {}),
  };
  const nodes = new Map(graph.nodes);
  nodes.set(id, node);
  // Copy on write: only the peers that gain an edge get new edge lists.
  const edges = new Map(graph.edges);
  const own: NavEdge[] = [];
  for (const peer of graph.nodes.values()) {
    if (peer.kind === "door" || !peer.unitIds.includes(room.unit.id)) continue;
    if (!sees(node, peer, room)) continue;
    const length = dist(xy, peer.xy);
    own.push({ to: peer.id, cost: length, length, kind: "walk" });
    edges.set(peer.id, [
      ...(edges.get(peer.id) ?? []),
      { to: id, cost: length, length, kind: "walk" },
    ]);
  }
  edges.set(id, own);
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

/** A point `CLEARANCE_M` into the room from the door (less in narrow rooms), not on furniture. */
function approachPoint(mid: XY, normal: XY, room: RoomArea): XY {
  for (const depth of [CLEARANCE_M, 0.5, 0.25]) {
    for (const sign of [1, -1]) {
      const p: XY = [mid[0] + normal[0] * depth * sign, mid[1] + normal[1] * depth * sign];
      if (
        insideRing(p, room.ring) &&
        distanceToRing(p, room.ring) >= depth * 0.9 &&
        obstaclesAt(p, room.obstacles).length === 0
      )
        return p;
    }
  }
  return mid;
}

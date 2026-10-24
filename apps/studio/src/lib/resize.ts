// Drag a room wall by its midpoint, the way a frame edge moves in Figma.
// The wall stays straight and slides along its normal; parallel walls of other
// rooms, then their corners, then the grid, catch it. Maths in local meters.

import type { XY } from "@ttkpr/map-core";

const MIN_WIDTH_M = 0.5;
const WALL_PARALLEL = 0.985;

export interface WallHandle {
  edge: number;
  at: XY;
  cursor: string;
}

export interface WallSnap {
  toleranceM: number;
  /** 0 turns the grid off. Wall-to-wall alignment stays on. */
  gridM: number;
  /** Outer rings of the other rooms on this floor. */
  others: XY[][];
}

export interface MovedWall {
  ring: XY[];
  offset: number;
  snapped: "wall" | "corner" | "grid" | null;
  /** Alignment line in local meters, when the wall caught another wall or a corner. */
  guide: [XY, XY] | null;
}

interface Frame {
  a: XY;
  b: XY;
  n: XY;
  len: number;
}

function edgeFrame(ring: XY[], edge: number): Frame | null {
  const a = ring[edge];
  const b = ring[edge + 1];
  if (!a || !b) return null;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  return { a, b, n: [-dy / len, dx / len], len };
}

function area(ring: XY[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i] as XY;
    const b = ring[i + 1] as XY;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** Cursor for motion along the wall's normal (horizontal wall → north-south). */
export function resizeCursor(nx: number, ny: number): string {
  const a = ((((Math.atan2(ny, nx) * 180) / Math.PI) % 180) + 180) % 180;
  if (a < 22.5 || a >= 157.5) return "ew-resize";
  if (a < 67.5) return "nesw-resize";
  if (a < 112.5) return "ns-resize";
  return "nwse-resize";
}

/** One handle per wall long enough to grab. `minLengthM` hides slivers at the current zoom. */
export function wallHandles(ring: XY[], minLengthM = 0.4): WallHandle[] {
  const handles: WallHandle[] = [];
  const edges = ring.length > 1 ? ring.length - 1 : 0;
  for (let edge = 0; edge < edges; edge++) {
    const frame = edgeFrame(ring, edge);
    if (!frame || frame.len < minLengthM) continue;
    handles.push({
      edge,
      at: [(frame.a[0] + frame.b[0]) / 2, (frame.a[1] + frame.b[1]) / 2],
      cursor: resizeCursor(frame.n[0], frame.n[1]),
    });
  }
  return handles;
}

function applyOffset(ring: XY[], edge: number, offset: number): XY[] {
  const frame = edgeFrame(ring, edge);
  if (!frame || offset === 0) return ring.map((p) => [p[0], p[1]] as XY);
  const next = ring.map((p) => [p[0], p[1]] as XY);
  const shift = (p: XY): XY => [p[0] + frame.n[0] * offset, p[1] + frame.n[1] * offset];
  next[edge] = shift(frame.a);
  next[edge + 1] = shift(frame.b);
  if (edge === 0) next[next.length - 1] = next[0] as XY;
  if (edge + 1 === next.length - 1) next[0] = next[next.length - 1] as XY;
  return next;
}

/** Keep the room from turning inside out, and leave at least half a meter of width. */
function limitOffset(ring: XY[], edge: number, offset: number): number {
  const sign0 = Math.sign(area(ring));
  const ok = (d: number) => {
    const next = area(applyOffset(ring, edge, d));
    return Math.abs(next) >= 1e-4 && (sign0 === 0 || Math.sign(next) === sign0);
  };
  if (ok(offset)) return offset;
  let lo = 0;
  let hi = offset;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  const backed = lo - Math.sign(lo || offset) * MIN_WIDTH_M;
  if (ok(backed) && Math.abs(backed) < Math.abs(lo)) return backed;
  return lo;
}

function closestOnSegment(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function along(n: XY): XY {
  return [-n[1], n[0]];
}

function span(points: XY[], origin: XY, dir: XY, pad: number): [XY, XY] {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    const t = (p[0] - origin[0]) * dir[0] + (p[1] - origin[1]) * dir[1];
    min = Math.min(min, t);
    max = Math.max(max, t);
  }
  return [
    [origin[0] + dir[0] * (min - pad), origin[1] + dir[1] * (min - pad)],
    [origin[0] + dir[0] * (max + pad), origin[1] + dir[1] * (max + pad)],
  ];
}

function snapOffset(
  frame: Frame,
  proposed: number,
  opts: WallSnap,
): { offset: number; snapped: MovedWall["snapped"]; guide: [XY, XY] | null } {
  const dir = along(frame.n);
  let wall: { offset: number; dist: number; seg: [XY, XY] } | null = null;
  let corner: { offset: number; dist: number; at: XY } | null = null;
  for (const other of opts.others) {
    for (let i = 0; i + 1 < other.length; i++) {
      const p = other[i] as XY;
      const q = other[i + 1] as XY;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 0.2) continue;
      const parallel = Math.abs(((q[0] - p[0]) / len) * dir[0] + ((q[1] - p[1]) / len) * dir[1]);
      if (parallel < WALL_PARALLEL) continue;
      const line = (p[0] - frame.a[0]) * frame.n[0] + (p[1] - frame.a[1]) * frame.n[1];
      const dist = Math.abs(line - proposed);
      if (dist <= opts.toleranceM && (!wall || dist < wall.dist)) {
        wall = { offset: line, dist, seg: [p, q] };
      }
    }
    for (const v of other) {
      const line = (v[0] - frame.a[0]) * frame.n[0] + (v[1] - frame.a[1]) * frame.n[1];
      const dist = Math.abs(line - proposed);
      if (dist <= opts.toleranceM && (!corner || dist < corner.dist)) {
        corner = { offset: line, dist, at: v };
      }
    }
  }
  if (wall) {
    const a: XY = [frame.a[0] + frame.n[0] * wall.offset, frame.a[1] + frame.n[1] * wall.offset];
    const b: XY = [frame.b[0] + frame.n[0] * wall.offset, frame.b[1] + frame.n[1] * wall.offset];
    return {
      offset: wall.offset,
      snapped: "wall",
      guide: span([a, b, wall.seg[0], wall.seg[1]], a, dir, 0.6),
    };
  }
  if (corner) {
    const half = frame.len / 2 + 0.6;
    return {
      offset: corner.offset,
      snapped: "corner",
      guide: [
        [corner.at[0] - dir[0] * half, corner.at[1] - dir[1] * half],
        [corner.at[0] + dir[0] * half, corner.at[1] + dir[1] * half],
      ],
    };
  }
  const axis = Math.abs(frame.n[0]) > WALL_PARALLEL || Math.abs(frame.n[1]) > WALL_PARALLEL;
  if (opts.gridM > 0 && axis) {
    const pos = frame.a[0] * frame.n[0] + frame.a[1] * frame.n[1];
    const snapped = Math.round((pos + proposed) / opts.gridM) * opts.gridM;
    const offset = snapped - pos;
    if (Math.abs(offset - proposed) <= opts.toleranceM) {
      return { offset, snapped: "grid", guide: null };
    }
  }
  return { offset: proposed, snapped: null, guide: null };
}

/** Slide one wall. `edge` is the index of its first vertex in a closed ring. */
export function moveWall(ring: XY[], edge: number, pointer: XY, opts: WallSnap): MovedWall | null {
  const frame = edgeFrame(ring, edge);
  if (!frame) return null;
  const proposed = (pointer[0] - frame.a[0]) * frame.n[0] + (pointer[1] - frame.a[1]) * frame.n[1];
  const snapped = snapOffset(frame, proposed, opts);
  const offset = limitOffset(ring, edge, snapped.offset);
  const kept = Math.abs(offset - snapped.offset) < 1e-6;
  return {
    ring: applyOffset(ring, edge, offset),
    offset,
    snapped: kept ? snapped.snapped : null,
    guide: kept ? snapped.guide : null,
  };
}

function verts(ring: XY[]): XY[] {
  return ring.length > 1 ? ring.slice(0, -1) : ring;
}

/** Four right angles. Free-form outlines are left out of corner resizing. */
export function isRectangle(ring: XY[]): boolean {
  const v = verts(ring);
  if (v.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = v[i] as XY;
    const b = v[(i + 1) % 4] as XY;
    const c = v[(i + 2) % 4] as XY;
    const d1x = b[0] - a[0];
    const d1y = b[1] - a[1];
    const d2x = c[0] - b[0];
    const d2y = c[1] - b[1];
    const l1 = Math.hypot(d1x, d1y);
    const l2 = Math.hypot(d2x, d2y);
    if (l1 < 0.2 || l2 < 0.2) return false;
    if (Math.abs(d1x * d2x + d1y * d2y) / (l1 * l2) > 0.08) return false;
  }
  return true;
}

/** Corner of a rectangle under the pointer, or nothing for any other outline. */
export function rectangleCorner(
  ring: XY[],
  pointer: XY,
  toleranceM: number,
): { corner: number; cursor: string } | null {
  if (!isRectangle(ring)) return null;
  let best = -1;
  let bestDist = toleranceM;
  for (let i = 0; i < 4; i++) {
    const v = ring[i] as XY;
    const dist = Math.hypot(pointer[0] - v[0], pointer[1] - v[1]);
    if (dist <= bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  if (best < 0) return null;
  const opp = ring[(best + 2) % 4] as XY;
  const v = ring[best] as XY;
  return { corner: best, cursor: resizeCursor(v[0] - opp[0], v[1] - opp[1]) };
}

function unit(dx: number, dy: number): XY {
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

function snapAxis(
  origin: XY,
  axis: XY,
  wallDir: XY,
  proposed: number,
  opts: WallSnap,
): { offset: number; guide: [XY, XY] | null } {
  let wall: { offset: number; dist: number; seg: [XY, XY] } | null = null;
  for (const other of opts.others) {
    for (let i = 0; i + 1 < other.length; i++) {
      const p = other[i] as XY;
      const q = other[i + 1] as XY;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 0.2) continue;
      const parallel = Math.abs(
        ((q[0] - p[0]) / len) * wallDir[0] + ((q[1] - p[1]) / len) * wallDir[1],
      );
      if (parallel < WALL_PARALLEL) continue;
      const line = (p[0] - origin[0]) * axis[0] + (p[1] - origin[1]) * axis[1];
      const dist = Math.abs(line - proposed);
      if (dist <= opts.toleranceM && (!wall || dist < wall.dist)) {
        wall = { offset: line, dist, seg: [p, q] };
      }
    }
  }
  if (wall) {
    const at: XY = [origin[0] + axis[0] * wall.offset, origin[1] + axis[1] * wall.offset];
    return { offset: wall.offset, guide: span([at, wall.seg[0], wall.seg[1]], at, wallDir, 0.6) };
  }
  const aligned = Math.abs(axis[0]) > WALL_PARALLEL || Math.abs(axis[1]) > WALL_PARALLEL;
  if (opts.gridM > 0 && aligned) {
    const pos = origin[0] * axis[0] + origin[1] * axis[1];
    const snapped = Math.round((pos + proposed) / opts.gridM) * opts.gridM;
    const offset = snapped - pos;
    if (Math.abs(offset - proposed) <= opts.toleranceM) return { offset, guide: null };
  }
  return { offset: proposed, guide: null };
}

function clampExtent(original: number, proposed: number): number {
  const sign = Math.sign(original) || 1;
  if (proposed * sign < MIN_WIDTH_M) return sign * MIN_WIDTH_M;
  return proposed;
}

export interface MovedCorner {
  ring: XY[];
  openings: { id: string; line: XY[] }[];
  guides: [XY, XY][];
  /** How far the corner itself travelled. */
  distance: number;
}

/**
 * Pull a rectangle's corner. The opposite corner stays, and both adjoining
 * walls follow, keeping the right angles. Not for free-form outlines.
 */
export function moveCorner(
  ring: XY[],
  corner: number,
  pointer: XY,
  openings: { id: string; line: XY[] }[],
  opts: WallSnap,
): MovedCorner | null {
  if (!isRectangle(ring) || corner < 0 || corner > 3) return null;
  const oppI = (corner + 2) % 4;
  const n1 = (corner + 1) % 4;
  const n2 = (corner + 3) % 4;
  const opp = ring[oppI] as XY;
  const ux = unit((ring[n1] as XY)[0] - opp[0], (ring[n1] as XY)[1] - opp[1]);
  const uy = unit((ring[n2] as XY)[0] - opp[0], (ring[n2] as XY)[1] - opp[1]);
  const along = (p: XY, axis: XY) => (p[0] - opp[0]) * axis[0] + (p[1] - opp[1]) * axis[1];
  const du0 = along(ring[corner] as XY, ux);
  const dv0 = along(ring[corner] as XY, uy);
  const snapU = snapAxis(opp, ux, uy, along(pointer, ux), opts);
  const snapV = snapAxis(opp, uy, ux, along(pointer, uy), opts);
  const du = clampExtent(du0, snapU.offset);
  const dv = clampExtent(dv0, snapV.offset);
  const at = (u: number, v: number): XY => [
    opp[0] + ux[0] * u + uy[0] * v,
    opp[1] + ux[1] * u + uy[1] * v,
  ];
  const next = ring.map((p) => [p[0], p[1]] as XY);
  next[corner] = at(du, dv);
  next[n1] = at(du, 0);
  next[n2] = at(0, dv);
  next[next.length - 1] = next[0] as XY;
  const guides = [snapU, snapV]
    .filter((s, i) => s.guide && Math.abs((i === 0 ? du : dv) - s.offset) < 1e-6)
    .map((s) => s.guide as [XY, XY]);
  const moved = next[corner] as XY;
  const from = ring[corner] as XY;
  return {
    ring: next,
    openings: retargetOpenings(openings, ring, next, [corner, (corner + 3) % 4]),
    guides,
    distance: Math.hypot(moved[0] - from[0], moved[1] - from[1]),
  };
}

function retargetOpenings(
  openings: { id: string; line: XY[] }[],
  from: XY[],
  to: XY[],
  edges: number[],
): { id: string; line: XY[] }[] {
  const changed: { id: string; line: XY[] }[] = [];
  for (const opening of openings) {
    if (opening.line.length < 2) continue;
    for (const edge of edges) {
      const a = from[edge] as XY;
      const b = from[edge + 1] as XY;
      if (!opening.line.every((p) => closestOnSegment(p, a, b) <= 0.3)) continue;
      const c = to[edge] as XY;
      const d = to[edge + 1] as XY;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy || 1e-12;
      changed.push({
        id: opening.id,
        line: opening.line.map((p) => {
          const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
          return [c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t] as XY;
        }),
      });
      break;
    }
  }
  return changed;
}

function onAnyEdge(line: XY[], ring: XY[]): boolean {
  const count = ring.length > 1 ? ring.length - 1 : ring.length;
  return line.every((p) => {
    for (let i = 0; i < count; i++) {
      if (closestOnSegment(p, ring[i] as XY, ring[i + 1] as XY) <= 0.3) return true;
    }
    return false;
  });
}

export interface MovedRoom {
  ring: XY[];
  openings: { id: string; line: XY[] }[];
  guide: [XY, XY] | null;
  distance: number;
}

/** Slide a whole room. Doors on its walls come along, and a wall can catch a neighbour. */
export function moveRoom(
  ring: XY[],
  openings: { id: string; line: XY[] }[],
  delta: XY,
  opts: WallSnap,
): MovedRoom {
  const attached = openings.filter((o) => o.line.length >= 2 && onAnyEdge(o.line, ring));
  let dx = delta[0];
  let dy = delta[1];
  let guide: [XY, XY] | null = null;
  const caught: XY[] = [];
  const count = ring.length > 1 ? ring.length - 1 : ring.length;
  for (let pass = 0; pass < 2; pass++) {
    const shifted = ring.map((p) => [p[0] + dx, p[1] + dy] as XY);
    let best: { dist: number; shift: XY; guide: [XY, XY]; n: XY } | null = null;
    for (let edge = 0; edge < count; edge++) {
      const a = shifted[edge] as XY;
      const b = shifted[edge + 1] as XY;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.2) continue;
      const dir: XY = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      const n: XY = [-dir[1], dir[0]];
      if (caught.some((u) => Math.abs(u[0] * n[0] + u[1] * n[1]) > WALL_PARALLEL)) continue;
      for (const other of opts.others) {
        for (let i = 0; i + 1 < other.length; i++) {
          const p = other[i] as XY;
          const q = other[i + 1] as XY;
          const olen = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (olen < 0.2) continue;
          const parallel = Math.abs(
            ((q[0] - p[0]) / olen) * dir[0] + ((q[1] - p[1]) / olen) * dir[1],
          );
          if (parallel < WALL_PARALLEL) continue;
          const gap = (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1];
          const dist = Math.abs(gap);
          if (dist <= opts.toleranceM && (!best || dist < best.dist)) {
            best = {
              dist,
              shift: [n[0] * gap, n[1] * gap],
              guide: span([a, b, p, q], a, dir, 0.6),
              n,
            };
          }
        }
      }
    }
    if (!best) break;
    dx += best.shift[0];
    dy += best.shift[1];
    guide = guide ?? best.guide;
    caught.push(best.n);
  }
  if (opts.gridM > 0) {
    const g = opts.gridM;
    const ax = caught.some((n) => Math.abs(n[0]) > WALL_PARALLEL);
    const ay = caught.some((n) => Math.abs(n[1]) > WALL_PARALLEL);
    if (!ax) {
      const x = (ring[0] as XY)[0] + dx;
      const snapped = Math.round(x / g) * g;
      if (Math.abs(snapped - x) <= opts.toleranceM) dx += snapped - x;
    }
    if (!ay) {
      const y = (ring[0] as XY)[1] + dy;
      const snapped = Math.round(y / g) * g;
      if (Math.abs(snapped - y) <= opts.toleranceM) dy += snapped - y;
    }
  }
  const shift = (p: XY): XY => [p[0] + dx, p[1] + dy];
  const next = ring.map(shift);
  next[next.length - 1] = next[0] as XY;
  return {
    ring: next,
    openings: attached.map((o) => ({ id: o.id, line: o.line.map(shift) })),
    guide,
    distance: Math.hypot(dx, dy),
  };
}

/**
 * Doors and windows on the wall move with it.
 * A door that only touches a corner of the wall keeps that end attached.
 */
export function shiftOpenings(
  openings: { id: string; line: XY[] }[],
  ring: XY[],
  edge: number,
  offset: number,
): { id: string; line: XY[] }[] {
  if (Math.abs(offset) < 1e-6) return [];
  const frame = edgeFrame(ring, edge);
  if (!frame) return [];
  const { a, b, n } = frame;
  const shift = (p: XY): XY => [p[0] + n[0] * offset, p[1] + n[1] * offset];
  const nearEnd = (p: XY) =>
    Math.hypot(p[0] - a[0], p[1] - a[1]) <= 0.2 || Math.hypot(p[0] - b[0], p[1] - b[1]) <= 0.2;
  const changed: { id: string; line: XY[] }[] = [];
  for (const opening of openings) {
    if (opening.line.length < 2) continue;
    if (opening.line.every((p) => closestOnSegment(p, a, b) <= 0.3)) {
      changed.push({ id: opening.id, line: opening.line.map(shift) });
      continue;
    }
    if (!opening.line.some(nearEnd)) continue;
    changed.push({
      id: opening.id,
      line: opening.line.map((p) => (nearEnd(p) ? shift(p) : [p[0], p[1]])),
    });
  }
  return changed;
}

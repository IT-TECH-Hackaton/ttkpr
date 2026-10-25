import type { Fixture, FixtureKind } from "@ttkpr/api-client";
import { fromLocal, type LonLat, toLocal, type XY } from "@ttkpr/map-core";

/** Drawn on the plan, then sized and coloured in the properties. */
export const FURNITURE_SHAPES = [
  { id: "shape-circle", label: "Круг" },
  { id: "shape-square", label: "Квадрат" },
  { id: "shape-polygon", label: "Многоугольник" },
] as const;

export type FurnitureShapeId = (typeof FURNITURE_SHAPES)[number]["id"];

export function furnitureShape(id: string): FurnitureShapeId | null {
  return FURNITURE_SHAPES.some((s) => s.id === id) ? (id as FurnitureShapeId) : null;
}

/** Ready-made furniture for the "Мебель" tool: one click puts it, at its real size. */
export interface FurniturePreset {
  id: string;
  label: string;
  kind: FixtureKind;
  shape: "rect" | "circle";
  /** Metres: width × depth, or the diameter for circles. */
  w: number;
  h: number;
}

export const FURNITURE: FurniturePreset[] = [
  { id: "table", label: "Стол", kind: "table", shape: "rect", w: 1.6, h: 0.8 },
  { id: "round-table", label: "Круглый стол", kind: "table", shape: "circle", w: 1.2, h: 1.2 },
  { id: "sofa", label: "Диван", kind: "seating", shape: "rect", w: 2, h: 0.9 },
  { id: "chairs", label: "Ряд кресел", kind: "seating", shape: "rect", w: 4, h: 0.6 },
  { id: "armchair", label: "Кресло", kind: "seating", shape: "rect", w: 0.8, h: 0.8 },
  { id: "counter", label: "Стойка", kind: "counter", shape: "rect", w: 2.4, h: 0.6 },
  { id: "booth", label: "Стенд", kind: "booth", shape: "rect", w: 2, h: 2 },
  { id: "stage", label: "Сцена", kind: "stage", shape: "rect", w: 4, h: 2.5 },
  { id: "screen", label: "Экран", kind: "screen", shape: "rect", w: 1.6, h: 0.2 },
  { id: "plant", label: "Растение", kind: "plant", shape: "circle", w: 0.7, h: 0.7 },
  { id: "column", label: "Колонна", kind: "column", shape: "circle", w: 0.5, h: 0.5 },
];

/** The preset as a fixture centred on `at`, turned like the plan (`rotationDeg`). */
export function furnitureAt(
  preset: FurniturePreset,
  anchor: LonLat,
  at: LonLat,
  levelId: string,
  id: string,
  rotationDeg = 0,
): Fixture {
  const [cx, cy] = toLocal(anchor, at);
  const t = (rotationDeg * Math.PI) / 180;
  const point = (dx: number, dy: number): LonLat =>
    fromLocal(anchor, [
      cx + dx * Math.cos(t) + dy * Math.sin(t),
      cy - dx * Math.sin(t) + dy * Math.cos(t),
    ]);
  const ring =
    preset.shape === "circle"
      ? Array.from({ length: 16 }, (_, i) => {
          const a = (i / 16) * Math.PI * 2;
          return point((preset.w / 2) * Math.cos(a), (preset.h / 2) * Math.sin(a));
        })
      : [
          point(-preset.w / 2, preset.h / 2),
          point(preset.w / 2, preset.h / 2),
          point(preset.w / 2, -preset.h / 2),
          point(-preset.w / 2, -preset.h / 2),
        ];
  return {
    id,
    levelId,
    kind: preset.kind,
    name: preset.label,
    // A screen on a wall or a column people walk around: not in the way of routes.
    obstacle: preset.kind !== "screen",
    geometry: { type: "Polygon", coordinates: [[...ring, ring[0] as LonLat]] },
  };
}

const MIN_M = 0.3;

function openRing(ring: XY[]): XY[] {
  const pts = ring.map((p) => [p[0], p[1]] as XY);
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (a && b && pts.length > 1 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-8) pts.pop();
  return pts;
}

function closeRing(pts: XY[]): XY[] {
  const first = pts[0];
  if (!first) return pts;
  return [...pts, [first[0], first[1]]];
}

function centroid(pts: XY[]): XY {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  const n = pts.length || 1;
  return [x / n, y / n];
}

/** First real side. It turns with the piece and stays put when the other side grows. */
function axes(pts: XY[]): { u: XY; v: XY } {
  let u: XY = [1, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as XY;
    const b = pts[(i + 1) % pts.length] as XY;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) {
      u = [dx / len, dy / len];
      break;
    }
  }
  return { u, v: [-u[1], u[0]] };
}

function frame(ring: XY[]) {
  const pts = openRing(ring);
  const c = centroid(pts);
  const { u, v } = axes(pts);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  const proj = pts.map((p) => {
    const pu = (p[0] - c[0]) * u[0] + (p[1] - c[1]) * u[1];
    const pv = (p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1];
    minU = Math.min(minU, pu);
    maxU = Math.max(maxU, pu);
    minV = Math.min(minV, pv);
    maxV = Math.max(maxV, pv);
    return { p, pu, pv };
  });
  return { pts, c, u, v, minU, maxU, minV, maxV, proj };
}

function at(c: XY, u: XY, v: XY, pu: number, pv: number): XY {
  return [c[0] + u[0] * pu + v[0] * pv, c[1] + u[1] * pu + v[1] * pv];
}

export interface FixtureHandle {
  role: "resize" | "rotate";
  /** 0 right, 1 top, 2 left, 3 bottom of the piece's own box. */
  side: number;
  at: XY;
  cursor: string;
}

function cursorFor(dir: XY): string {
  const a = ((((Math.atan2(dir[1], dir[0]) * 180) / Math.PI) % 180) + 180) % 180;
  if (a < 22.5 || a >= 157.5) return "ew-resize";
  if (a < 67.5) return "nesw-resize";
  if (a < 112.5) return "ns-resize";
  return "nwse-resize";
}

/** Four side grips to stretch, four corner grips to turn. */
export function fixtureHandles(ring: XY[]): FixtureHandle[] {
  const f = frame(ring);
  if (!Number.isFinite(f.minU)) return [];
  const midU = (f.minU + f.maxU) / 2;
  const midV = (f.minV + f.maxV) / 2;
  const sides: { side: number; pu: number; pv: number; dir: XY }[] = [
    { side: 0, pu: f.maxU, pv: midV, dir: f.u },
    { side: 1, pu: midU, pv: f.maxV, dir: f.v },
    { side: 2, pu: f.minU, pv: midV, dir: f.u },
    { side: 3, pu: midU, pv: f.minV, dir: f.v },
  ];
  const corners: { pu: number; pv: number }[] = [
    { pu: f.maxU, pv: f.maxV },
    { pu: f.minU, pv: f.maxV },
    { pu: f.minU, pv: f.minV },
    { pu: f.maxU, pv: f.minV },
  ];
  return [
    ...sides.map((s) => ({
      role: "resize" as const,
      side: s.side,
      at: at(f.c, f.u, f.v, s.pu, s.pv),
      cursor: cursorFor(s.dir),
    })),
    ...corners.map((corner, i) => ({
      role: "rotate" as const,
      side: i,
      at: at(f.c, f.u, f.v, corner.pu, corner.pv),
      cursor: "grab",
    })),
  ];
}

/** Pull one side. The opposite side stays. */
export function stretchFixture(ring: XY[], side: number, pointer: XY): XY[] | null {
  const f = frame(ring);
  if (!f.proj.length) return null;
  const horizontal = side === 0 || side === 2;
  const dir = horizontal ? f.u : f.v;
  const pointerT = (pointer[0] - f.c[0]) * dir[0] + (pointer[1] - f.c[1]) * dir[1];
  const min = horizontal ? f.minU : f.minV;
  const max = horizontal ? f.maxU : f.maxV;
  const fromMin = side === 0 || side === 1;
  const span = Math.max(max - min, 1e-6);
  let next = fromMin ? pointerT - min : max - pointerT;
  if (next < MIN_M) next = MIN_M;
  const scale = next / span;
  const pts = f.proj.map(({ pu, pv }) => {
    const t = horizontal ? pu : pv;
    const other = horizontal ? pv : pu;
    const scaled = fromMin ? min + (t - min) * scale : max - (max - t) * scale;
    return horizontal ? at(f.c, f.u, f.v, scaled, other) : at(f.c, f.u, f.v, other, scaled);
  });
  return closeRing(pts);
}

/** Turn the whole piece around its centre. `from` is the pointer where the drag started. */
export function rotateFixture(ring: XY[], from: XY, to: XY): XY[] | null {
  const pts = openRing(ring);
  const c = centroid(pts);
  const a0 = Math.atan2(from[1] - c[1], from[0] - c[0]);
  const a1 = Math.atan2(to[1] - c[1], to[0] - c[0]);
  const d = a1 - a0;
  const cos = Math.cos(d);
  const sin = Math.sin(d);
  return closeRing(
    pts.map((p) => {
      const x = p[0] - c[0];
      const y = p[1] - c[1];
      return [c[0] + x * cos - y * sin, c[1] + x * sin + y * cos] as XY;
    }),
  );
}

export function fixtureExtent(ring: XY[]): { widthM: number; depthM: number } {
  const f = frame(ring);
  return {
    widthM: Math.max(f.maxU - f.minU, 0),
    depthM: Math.max(f.maxV - f.minV, 0),
  };
}

/** Set the piece's own width and depth, keeping its centre and rotation. */
export function resizeFixture(ring: XY[], widthM: number, depthM: number): XY[] {
  const f = frame(ring);
  const spanU = Math.max(f.maxU - f.minU, 1e-6);
  const spanV = Math.max(f.maxV - f.minV, 1e-6);
  const su = Math.max(widthM, MIN_M) / spanU;
  const sv = Math.max(depthM, MIN_M) / spanV;
  const midU = (f.minU + f.maxU) / 2;
  const midV = (f.minV + f.maxV) / 2;
  const pts = f.proj.map(({ pu, pv }) =>
    at(f.c, f.u, f.v, midU + (pu - midU) * su, midV + (pv - midV) * sv),
  );
  return closeRing(pts);
}

/** Circle through `edge`, at least 0.3 m across. Closed ring in lon/lat. */
export function circleRing(anchor: LonLat, center: LonLat, edge: LonLat): LonLat[] | null {
  const [cx, cy] = toLocal(anchor, center);
  const [ex, ey] = toLocal(anchor, edge);
  const r = Math.max(Math.hypot(ex - cx, ey - cy), MIN_M / 2);
  if (Math.hypot(ex - cx, ey - cy) < 0.15) return null;
  const n = 32;
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return fromLocal(anchor, [cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  });
  return [...pts, pts[0] as LonLat];
}

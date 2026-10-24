import type { Fixture, FixtureKind } from "@ttkpr/api-client";
import { fromLocal, type LonLat, toLocal } from "@ttkpr/map-core";

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

import type { MapDocument } from "@ttkpr/api-client";
import { buildNavGraph, type MapBundle, sortedLevels, unreachablePois } from "@ttkpr/map-core";

/** Something a visitor would trip over, with the object to show on the plan. */
export interface PublishIssue {
  text: string;
  /** Object to select; its level becomes the current one. */
  id?: string;
  levelId?: string;
  /** Blocks publishing (an empty map); the rest are warnings. */
  blocking?: boolean;
}

const RING_EPS = 1e-6;

/** Does the door's line touch the room's outline? Coarse, in lon/lat: enough for a warning. */
function touches(ring: number[][], line: number[][]): boolean {
  const [ax = 0, ay = 0] = line[0] ?? [];
  const [bx = 0, by = 0] = line.at(-1) ?? [];
  if (line.length < 2) return false;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  for (let i = 1; i < ring.length; i++) {
    const [px = 0, py = 0] = ring[i - 1] ?? [];
    const [qx = 0, qy = 0] = ring[i] ?? [];
    const dx = qx - px;
    const dy = qy - py;
    const len2 = dx * dx + dy * dy || RING_EPS;
    const t = Math.max(0, Math.min(1, ((mx - px) * dx + (my - py) * dy) / len2));
    const ex = px + t * dx - mx;
    const ey = py + t * dy - my;
    // ~1.5 m at the latitudes we work in.
    if (ex * ex + ey * ey < 2e-10) return true;
  }
  return false;
}

/** What to fix before publishing: empty plan, no entrance, rooms without doors, unreachable or
 * unnamed places, floors with no stairs or lift. */
export function publishIssues(doc: MapDocument): PublishIssue[] {
  const issues: PublishIssue[] = [];
  const units = doc.units ?? [];
  const openings = doc.openings ?? [];
  const pois = doc.pois ?? [];
  if (units.length === 0) {
    issues.push({ text: "На плане нет ни одного помещения", blocking: true });
    return issues;
  }
  if (!openings.some((o) => o.category === "entrance")) {
    issues.push({ text: "Нет входа в здание — гости не поймут, откуда идти" });
  }
  for (const unit of units) {
    if (unit.walkable === false) continue;
    const ring = (unit.geometry.coordinates[0] ?? []) as number[][];
    const doors = openings.filter(
      (o) =>
        o.levelId === unit.levelId &&
        o.category !== "window" &&
        touches(ring, o.geometry.coordinates as number[][]),
    );
    if (doors.length === 0) {
      issues.push({
        text: `«${unit.name || "Помещение без названия"}» без двери — туда не построится маршрут`,
        id: unit.id,
        levelId: unit.levelId,
      });
    }
  }
  for (const poi of pois) {
    if (!poi.name.trim()) {
      issues.push({ text: "Место без названия", id: poi.id, levelId: poi.levelId });
    }
  }
  const cut = new Set(unreachablePois(buildNavGraph(doc as MapBundle), doc as MapBundle));
  for (const poi of pois) {
    if (cut.has(poi.id) && poi.name.trim()) {
      issues.push({ text: `К «${poi.name}» не дойти`, id: poi.id, levelId: poi.levelId });
    }
  }
  const levels = sortedLevels(doc);
  if (levels.length > 1) {
    const linked = new Set((doc.connectors ?? []).flatMap((c) => c.points.map((p) => p.levelId)));
    for (const level of levels) {
      if (!linked.has(level.id)) {
        issues.push({
          text: `${level.name} не связан лестницей или лифтом`,
          levelId: level.id,
        });
      }
    }
  }
  return issues;
}

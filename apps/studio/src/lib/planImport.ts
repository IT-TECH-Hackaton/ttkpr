import { useMutation, useQuery } from "@tanstack/react-query";
import {
  type Connector,
  createPlanImport,
  getPlanImport,
  type Level,
  type MapDocument,
  type Opening,
  type OpeningCategory,
  type PlanImportOut,
  type Underlay,
  type Unit,
  type UnitCategory,
} from "@ttkpr/api-client";
import { CONNECTOR_LABELS, type LonLat, UNIT_LABELS } from "@ttkpr/map-core";
import { unwrap } from "./api";
import { placeRing } from "./autoPlan";
import { placementCorners } from "./mapView";

type Position = [number, number];

/** What worker.plan_import.recognize_file returns; coordinates are fractions of the page. */
export interface RecognizedPlan {
  pages: RecognizedPage[];
  connectors: { kind: "stairs" | "elevator"; rooms: { page: number; room: number }[] }[];
  metersPerPixel: number | null;
  ocr: boolean;
  warnings: string[];
}

export interface RecognizedPage {
  width: number;
  height: number;
  floor: number | null;
  imageUrl: string;
  sourcePage: number;
  rooms: { ring: Position[]; name: string | null; category: UnitCategory; center: Position }[];
  openings: { a: Position; b: Position; category: OpeningCategory; rooms: number[] }[];
}

/** Building width when the doors gave no scale, m. */
export const FALLBACK_WIDTH_M = 40;

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

export function planResult(job: PlanImportOut | undefined): RecognizedPlan | null {
  return job?.status === "ready" && job.result ? (job.result as unknown as RecognizedPlan) : null;
}

/** Width of the first page in metres: from the door scale, else the fallback for the building. */
export function suggestedWidthM(plan: RecognizedPlan): number {
  const page = plan.pages[0];
  if (!page) return FALLBACK_WIDTH_M;
  if (plan.metersPerPixel) return Math.round(page.width * plan.metersPerPixel * 10) / 10;
  const xs = page.rooms.flatMap((r) => r.ring.map((p) => p[0]));
  const span = xs.length ? Math.max(...xs) - Math.min(...xs) : 1;
  return Math.round(FALLBACK_WIDTH_M / Math.max(span, 0.1));
}

export function planCounts(plan: RecognizedPlan) {
  const rooms = plan.pages.flatMap((p) => p.rooms);
  const openings = plan.pages.flatMap((p) => p.openings);
  return {
    floors: plan.pages.length,
    rooms: rooms.length,
    doors: openings.filter((o) => o.category !== "window").length,
    windows: openings.filter((o) => o.category === "window").length,
    stairs: rooms.filter((r) => r.category === "stairs" || r.category === "elevator").length,
  };
}

/**
 * The recognised plan added to the document: one level per page (an existing level with the
 * same ordinal is reused), the page image as its underlay, rooms, doors and windows, and stairs
 * or lifts that line up on neighbouring floors joined by a connector. Every page gets the same
 * placement, so the floors stay on top of each other.
 */
export function applyRecognizedPlan(
  doc: MapDocument,
  plan: RecognizedPlan,
  /** widthM: metres across the first page; the other pages keep its scale. */
  placement: { center: LonLat; widthM: number },
): { doc: MapDocument; levelIds: string[] } {
  const anchor = doc.venue.anchor;
  const levels: Level[] = [...(doc.levels ?? [])];
  const units: Unit[] = [...(doc.units ?? [])];
  const openings: Opening[] = [...(doc.openings ?? [])];
  const underlays: Underlay[] = [...(doc.underlays ?? [])];
  const connectors: Connector[] = [...(doc.connectors ?? [])];
  const levelIds: string[] = [];
  const roomIds: string[][] = [];
  const centers: Position[][] = [];

  plan.pages.forEach((page, index) => {
    // Page 1 is the ground floor unless the page says which floor it is ("2 этаж").
    const ordinal = page.floor !== null ? page.floor - 1 : index;
    let level = levels.find((l) => l.ordinal === ordinal);
    if (!level) {
      level = { id: newId("l"), name: `${ordinal + 1} этаж`, ordinal };
      levels.push(level);
    }
    const levelId = level.id;
    levelIds.push(levelId);
    const metresPerPx = placement.widthM / (plan.pages[0]?.width ?? page.width);
    const corners = placementCorners(anchor, {
      center: placement.center,
      widthM: page.width * metresPerPx,
      heightM: page.height * metresPerPx,
      rotationDeg: 0,
    }) as Position[];
    underlays.push({
      id: newId("ul"),
      levelId,
      url: page.imageUrl,
      opacity: 0.45,
      coordinates: corners as Underlay["coordinates"],
    });
    const ids: string[] = [];
    const pageCenters: Position[] = [];
    let unnamed = units.filter((u) => u.levelId === levelId).length;
    for (const room of page.rooms) {
      const id = newId("u");
      ids.push(id);
      pageCenters.push((placeRing([room.center], corners)[0] ?? placement.center) as Position);
      const nameless = room.category === "room" || room.category === "hall";
      units.push({
        id,
        levelId,
        name:
          room.name ??
          (nameless ? `Помещение ${++unnamed}` : (UNIT_LABELS[room.category] ?? "Помещение")),
        category: room.category,
        walkable: true,
        geometry: { type: "Polygon", coordinates: [placeRing(room.ring, corners)] },
      });
    }
    roomIds.push(ids);
    centers.push(pageCenters);
    for (const o of page.openings) {
      const [a, b] = placeRing([o.a, o.b], corners) as [Position, Position];
      openings.push({
        id: newId("o"),
        levelId,
        category: o.category,
        geometry: { type: "LineString", coordinates: [a, b] },
      });
    }
  });

  for (const chain of plan.connectors) {
    const points = chain.rooms
      .map(({ page, room }) => ({
        levelId: levelIds[page],
        position: centers[page]?.[room],
      }))
      .filter((p): p is { levelId: string; position: Position } => !!p.levelId && !!p.position);
    if (points.length < 2) continue;
    connectors.push({
      id: newId("c"),
      kind: chain.kind,
      name: CONNECTOR_LABELS[chain.kind],
      points,
    });
  }

  return {
    doc: { ...doc, levels, units, openings, underlays, connectors },
    levelIds,
  };
}

/** Upload a plan file, then poll the job until the worker is done. */
export function usePlanImport(mapId: string) {
  const start = useMutation({
    mutationFn: (file: File) =>
      unwrap(createPlanImport({ path: { map_id: mapId }, body: { file } })),
  });
  const jobId = start.data?.id;
  const job = useQuery({
    queryKey: ["plan-import", jobId],
    queryFn: () => unwrap(getPlanImport({ path: { job_id: jobId as string } })),
    enabled: !!jobId,
    refetchInterval: (query) => (query.state.data?.status === "processing" ? 1500 : false),
  });
  return { start, job: job.data ?? start.data, error: start.error ?? job.error };
}

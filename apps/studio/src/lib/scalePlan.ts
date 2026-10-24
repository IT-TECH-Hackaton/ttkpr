import type { MapDocument } from "@ttkpr/api-client";
import { fromLocal, type LonLat, toLocal } from "@ttkpr/map-core";

type Position = [number, number];

/**
 * The whole plan scaled about `center`: rooms, doors, places, stairs, walkways, furniture, zones
 * and plan images. For a plan drawn at the wrong size (a route of 30 minutes across one floor):
 * measure one room, type its real width, everything follows.
 */
export function scaleDocument(doc: MapDocument, factor: number, center: Position): MapDocument {
  const anchor = doc.venue.anchor;
  const [cx, cy] = toLocal(anchor, center);
  const p = (point: Position | number[]): Position => {
    const [x, y] = toLocal(anchor, point as LonLat);
    return fromLocal(anchor, [cx + (x - cx) * factor, cy + (y - cy) * factor]) as Position;
  };
  const ring = (rings: number[][][]) => rings.map((r) => r.map(p));
  return {
    ...doc,
    units: doc.units?.map((u) => ({
      ...u,
      geometry: { ...u.geometry, coordinates: ring(u.geometry.coordinates) },
    })),
    openings: doc.openings?.map((o) => ({
      ...o,
      geometry: { ...o.geometry, coordinates: o.geometry.coordinates.map(p) },
    })),
    pois: doc.pois?.map((poi) => ({ ...poi, position: p(poi.position) })),
    connectors: doc.connectors?.map((c) => ({
      ...c,
      points: c.points.map((pt) => ({ ...pt, position: p(pt.position) })),
    })),
    paths: doc.paths?.map((w) => ({
      ...w,
      geometry: { ...w.geometry, coordinates: w.geometry.coordinates.map(p) },
    })),
    fixtures: doc.fixtures?.map((f) => ({
      ...f,
      geometry: { ...f.geometry, coordinates: ring(f.geometry.coordinates) },
    })),
    zones: doc.zones?.map((z) => ({
      ...z,
      geometry: { ...z.geometry, coordinates: ring(z.geometry.coordinates) },
    })),
    underlays: doc.underlays?.map((u) => ({
      ...u,
      coordinates: u.coordinates.map(p) as typeof u.coordinates,
    })),
  };
}

/** A point scaled the same way (panoramas live on the server, not in the document). */
export function scalePoint(
  anchor: LonLat,
  point: Position,
  factor: number,
  center: Position,
): Position {
  const [cx, cy] = toLocal(anchor, center);
  const [x, y] = toLocal(anchor, point);
  return fromLocal(anchor, [cx + (x - cx) * factor, cy + (y - cy) * factor]) as Position;
}

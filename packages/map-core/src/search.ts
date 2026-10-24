// What search should find: places, named rooms and zones, with every text visitors may type —
// tags, translations, talks and speakers, the room or zone around. Pure data for MiniSearch.

import type { Poi } from "@ttkpr/api-client";
import type { MapBundle } from "./bundle";
import { amenityLabel, categoryOf } from "./categories";
import type { LonLat } from "./geo";
import { localized } from "./i18n";
import { labelPoint, placeOf } from "./places";

export type SearchKind = "poi" | "unit" | "zone";

export interface SearchEntry {
  /** Unique across kinds: "poi:<id>", "unit:<id>", "zone:<id>". */
  key: string;
  kind: SearchKind;
  id: string;
  levelId: string;
  position: LonLat;
  /** In the requested language when translated. */
  name: string;
  /** "Стенд", "Зал", "Зона"… */
  category: string;
  description: string;
  /** Everything else worth matching, space-separated. */
  keywords: string;
}

/** Room categories as visitors name them. */
export const UNIT_LABELS: Record<string, string> = {
  room: "Помещение",
  corridor: "Коридор",
  lobby: "Холл",
  hall: "Зал",
  restroom: "Туалет",
  stairs: "Лестница",
  elevator: "Лифт",
  outdoor: "Территория",
  nonpublic: "Служебное помещение",
};

const join = (parts: (string | null | undefined)[]) =>
  [...new Set(parts.map((p) => p?.trim()).filter((p): p is string => Boolean(p)))].join(" ");

const translatedTexts = (
  translations:
    | Record<string, { name?: string | null; description?: string | null }>
    | null
    | undefined,
) => Object.values(translations ?? {}).flatMap((t) => [t.name, t.description]);

/** Search fields of one place (for an index of places only, like the viewer's current one). */
export function poiSearchFields(
  bundle: MapBundle,
  poi: Poi,
  lang?: string | null,
): Pick<SearchEntry, "name" | "category" | "description" | "keywords"> {
  const text = localized(poi, lang);
  const { unit, zone } = placeOf(bundle, poi);
  return {
    name: text.name,
    category: categoryOf(bundle, poi.category).label,
    description: text.description ?? "",
    keywords: join([
      poi.name,
      poi.description,
      ...(poi.tags ?? []),
      ...translatedTexts(poi.translations),
      ...(poi.events ?? []).flatMap((e) => [e.title, e.speaker]),
      unit?.name,
      zone?.name,
    ]),
  };
}

/**
 * Entries to index for search: places, named rooms (not corridors) and zones. Rooms and zones
 * appear at a point inside them, so a result can be shown and routed to.
 */
export function searchEntries(
  bundle: MapBundle,
  {
    lang = null,
    kinds = ["poi", "unit", "zone"],
  }: { lang?: string | null; kinds?: SearchKind[] } = {},
): SearchEntry[] {
  const entries: SearchEntry[] = [];
  if (kinds.includes("poi")) {
    for (const poi of bundle.pois ?? []) {
      entries.push({
        key: `poi:${poi.id}`,
        kind: "poi",
        id: poi.id,
        levelId: poi.levelId,
        position: poi.position,
        ...poiSearchFields(bundle, poi, lang),
      });
    }
  }
  if (kinds.includes("unit")) {
    for (const unit of bundle.units ?? []) {
      if (!unit.name || unit.category === "corridor") continue;
      const position = labelPoint(bundle, unit.geometry.coordinates);
      if (!position) continue;
      const text = localized(unit, lang);
      entries.push({
        key: `unit:${unit.id}`,
        kind: "unit",
        id: unit.id,
        levelId: unit.levelId,
        position,
        name: text.name ?? unit.name,
        category: UNIT_LABELS[unit.category] ?? "",
        description: text.description ?? "",
        keywords: join([
          unit.name,
          unit.description,
          ...translatedTexts(unit.translations),
          ...(unit.amenities ?? []).map(amenityLabel),
        ]),
      });
    }
  }
  if (kinds.includes("zone")) {
    for (const zone of bundle.zones ?? []) {
      const position = labelPoint(bundle, zone.geometry.coordinates);
      if (!position) continue;
      const text = localized(zone, lang);
      entries.push({
        key: `zone:${zone.id}`,
        kind: "zone",
        id: zone.id,
        levelId: zone.levelId,
        position,
        name: text.name,
        category: "Зона",
        description: text.description ?? "",
        keywords: join([zone.name, zone.description, ...translatedTexts(zone.translations)]),
      });
    }
  }
  return entries;
}

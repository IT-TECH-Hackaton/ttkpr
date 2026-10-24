import type { Amenity } from "@ttkpr/api-client";
import type { MapBundle } from "./bundle";

/** POI categories shown to visitors and offered in the studio. Keys are stored in the document. */
export const POI_CATEGORIES: Record<string, { label: string; emoji: string }> = {
  stand: { label: "Стенд", emoji: "🏷️" },
  stage: { label: "Сцена", emoji: "🎤" },
  hall: { label: "Зал", emoji: "🏛️" },
  food: { label: "Еда и кофе", emoji: "☕" },
  service: { label: "Сервис", emoji: "🛎️" },
  wifi: { label: "Wi-Fi", emoji: "📶" },
  restroom: { label: "Туалет", emoji: "🚻" },
  entrance: { label: "Вход", emoji: "🚪" },
  other: { label: "Другое", emoji: "📍" },
};

export function categoryLabel(key: string): string {
  return POI_CATEGORIES[key]?.label ?? POI_CATEGORIES.other?.label ?? key;
}

export function categoryEmoji(key: string): string {
  return POI_CATEGORIES[key]?.emoji ?? "📍";
}

export interface CategoryInfo {
  id: string;
  label: string;
  emoji: string;
  /** Organizer's colour (#rrggbb), if set. */
  color: string | null;
  /** Defined by the organizer (`venue.categories`) rather than built in. */
  custom: boolean;
}

/**
 * A POI category with the organizer's own ones merged in: a custom category with a built-in id
 * overrides its label, emoji and colour. Unknown ids read as "Другое" but keep their id.
 */
export function categoryOf(bundle: MapBundle | null | undefined, id: string): CategoryInfo {
  const custom = bundle?.venue.categories?.find((c) => c.id === id);
  const builtIn = POI_CATEGORIES[id];
  if (custom) {
    return {
      id,
      label: custom.label,
      emoji: custom.emoji ?? builtIn?.emoji ?? "📍",
      color: custom.color ?? null,
      custom: true,
    };
  }
  return {
    id,
    label: builtIn?.label ?? categoryLabel("other"),
    emoji: builtIn?.emoji ?? "📍",
    color: null,
    custom: false,
  };
}

/**
 * Categories for filters and pickers: built-in ones first (overridden by custom ones with the
 * same id), then the organizer's. `usedOnly` keeps those some POI of the map has.
 */
export function poiCategories(
  bundle: MapBundle | null | undefined,
  { usedOnly = false }: { usedOnly?: boolean } = {},
): CategoryInfo[] {
  const ids = [
    ...Object.keys(POI_CATEGORIES),
    ...(bundle?.venue.categories ?? []).map((c) => c.id).filter((id) => !(id in POI_CATEGORIES)),
  ];
  const used = new Set((bundle?.pois ?? []).map((p) => p.category));
  return ids.filter((id) => !usedOnly || used.has(id)).map((id) => categoryOf(bundle, id));
}

/** Room amenities: Russian labels and emoji for chips and filters. */
export const AMENITIES: Record<Amenity, { label: string; emoji: string }> = {
  wifi: { label: "Wi-Fi", emoji: "📶" },
  power: { label: "Розетки", emoji: "🔌" },
  accessible: { label: "Доступно на коляске", emoji: "♿" },
  toilet: { label: "Туалет", emoji: "🚻" },
  water: { label: "Питьевая вода", emoji: "🚰" },
  food: { label: "Еда", emoji: "🍽️" },
  quiet: { label: "Тихое место", emoji: "🤫" },
  kids: { label: "Для детей", emoji: "🧸" },
  ac: { label: "Кондиционер", emoji: "❄️" },
  projector: { label: "Проектор", emoji: "📽️" },
  parking: { label: "Парковка", emoji: "🅿️" },
  firstaid: { label: "Медпомощь", emoji: "⛑️" },
  info: { label: "Справочная", emoji: "ℹ️" },
};

export function amenityLabel(key: string): string {
  return AMENITIES[key as Amenity]?.label ?? key;
}

export function amenityEmoji(key: string): string {
  return AMENITIES[key as Amenity]?.emoji ?? "•";
}

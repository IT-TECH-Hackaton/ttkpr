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

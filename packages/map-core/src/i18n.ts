// Texts of places in the visitor's language, falling back to the organizer's original.

import type { MapBundle } from "./bundle";

/** Base language of the texts when the venue does not say. */
export const BASE_LANGUAGE = "ru";

interface TranslatedText {
  name?: string | null;
  description?: string | null;
}

/** Anything with a name, a description and `translations` (POI, room, zone). */
export interface Localizable extends TranslatedText {
  translations?: Record<string, TranslatedText> | null;
}

/** Languages offered to visitors, the base one first (["ru"] when the venue lists none). */
export function venueLanguages(bundle: MapBundle | null | undefined): string[] {
  const listed = (bundle?.venue.languages ?? []).map((l) => l.toLowerCase());
  return listed.length ? [...new Set(listed)] : [BASE_LANGUAGE];
}

/** The best offered language for the visitor's preferences (navigator.languages). */
export function pickLanguage(
  bundle: MapBundle | null | undefined,
  preferred: readonly string[] = [],
): string {
  const offered = venueLanguages(bundle);
  for (const wanted of preferred.map((l) => l.toLowerCase())) {
    const exact = offered.find((l) => l === wanted);
    if (exact) return exact;
    const base = wanted.split("-")[0] as string;
    const close = offered.find((l) => l === base || l.split("-")[0] === base);
    if (close) return close;
  }
  return offered[0] as string;
}

function translationFor(item: Localizable, lang: string): TranslatedText | undefined {
  const all = item.translations ?? {};
  const wanted = lang.toLowerCase();
  const base = wanted.split("-")[0] as string;
  const keys = Object.keys(all);
  const key =
    keys.find((k) => k.toLowerCase() === wanted) ??
    keys.find((k) => k.toLowerCase() === base) ??
    keys.find((k) => k.toLowerCase().split("-")[0] === base);
  return key ? all[key] : undefined;
}

/**
 * Name and description in `lang` (exact code, then the same language with another region),
 * each falling back to the original text on its own. No `lang`: the original.
 */
export function localized<T extends Localizable>(
  item: T,
  lang?: string | null,
): { name: T["name"]; description: string | null } {
  const t = lang ? translationFor(item, lang) : undefined;
  return {
    name: (t?.name || item.name) as T["name"],
    description: t?.description || item.description || null,
  };
}

const LANGUAGE_NAMES: Record<string, string> = {
  ru: "Русский",
  en: "English",
  zh: "中文",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  pt: "Português",
  tr: "Türkçe",
  ar: "العربية",
  ja: "日本語",
  ko: "한국어",
  hi: "हिन्दी",
  kk: "Қазақша",
  uz: "Oʻzbekcha",
  ky: "Кыргызча",
  tg: "Тоҷикӣ",
  be: "Беларуская",
  uk: "Українська",
  hy: "Հայերեն",
  az: "Azərbaycanca",
  ka: "ქართული",
  tt: "Татарча",
  ba: "Башҡортса",
  fa: "فارسی",
  vi: "Tiếng Việt",
};

/** A language's own name for a switcher ("English", "中文"); the code if unknown. */
export function languageName(code: string): string {
  const lower = code.toLowerCase();
  const known = LANGUAGE_NAMES[lower] ?? LANGUAGE_NAMES[lower.split("-")[0] as string];
  if (known) return known;
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    if (name && name.toLowerCase() !== lower) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    // Old browsers or an odd code: fall through.
  }
  return code;
}

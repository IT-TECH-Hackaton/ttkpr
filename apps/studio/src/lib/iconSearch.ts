// Preset icons and a pasted SVG link (Iconify or a similar host). The SVG is stored on the
// room, so the published map does not call the icon host again.

import { isRoomIconId, safeIconSvg } from "@ttkpr/map-core";

export const ROOM_ICON_PRESETS: { id: string; label: string }[] = [
  { id: "mdi:toilet", label: "Туалет" },
  { id: "mdi:shield-account", label: "Охрана" },
  { id: "mdi:coffee", label: "Кафе" },
  { id: "mdi:silverware-fork-knife", label: "Еда" },
  { id: "mdi:information", label: "Справка" },
  { id: "mdi:parking", label: "Парковка" },
  { id: "mdi:hanger", label: "Гардероб" },
  { id: "mdi:door", label: "Вход" },
  { id: "mdi:stairs", label: "Лестница" },
  { id: "mdi:elevator", label: "Лифт" },
  { id: "mdi:medical-bag", label: "Медпункт" },
  { id: "mdi:wifi", label: "Wi-Fi" },
  { id: "mdi:account-group", label: "Люди" },
  { id: "mdi:desk", label: "Ресепшен" },
  { id: "mdi:wheelchair", label: "Доступ" },
];

export function iconPreviewUrl(id: string): string {
  const [prefix, name] = id.split(":");
  return `https://api.iconify.design/${prefix}/${name}.svg?height=32&color=%230f172a`;
}

/** Iconify path `…/mdi/toilet.svg` keeps that id. Any other https SVG gets a stable id. */
export function iconIdFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const match = url.pathname.match(/\/([a-z0-9-]+)\/([a-z0-9-]+)\.svg$/i);
  if (match?.[1] && match?.[2]) {
    const id = `${match[1].toLowerCase()}:${match[2].toLowerCase()}`;
    return isRoomIconId(id) ? id : null;
  }
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) hash = Math.imul(hash ^ raw.charCodeAt(i), 16777619);
  return `svg:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export async function fetchIconSvg(id: string): Promise<string> {
  if (!isRoomIconId(id)) throw new Error("icon");
  const [prefix, name] = id.split(":");
  const url = `https://api.iconify.design/${prefix}/${name}.svg?color=%23ffffff&width=64&height=64`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("icon");
  return readSvg(await response.text());
}

export async function fetchSvgUrl(raw: string): Promise<{ id: string; svg: string }> {
  const id = iconIdFromUrl(raw);
  if (!id) throw new Error("url");
  const url = new URL(raw.trim());
  if (url.hostname === "api.iconify.design") {
    if (!url.searchParams.has("color")) url.searchParams.set("color", "#ffffff");
    url.searchParams.set("width", "64");
    url.searchParams.set("height", "64");
  }
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error("fetch");
  return { id, svg: readSvg(await response.text()) };
}

function readSvg(body: string): string {
  const text = body.trim().replace(/^<\?xml[^>]*>\s*/, "");
  const safe = safeIconSvg(text);
  if (!safe) throw new Error("svg");
  return safe;
}

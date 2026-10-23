// "Сохранить офлайн": everything a map needs goes into OFFLINE_CACHE, which the service worker
// serves first (src/sw.ts). The list of saved maps lives in IndexedDB.

import { DEFAULT_GLYPHS, type MapBundle, type MapManifest, PLAN_FONT } from "@ttkpr/map-core";
import { createStore, del, get, set, values } from "idb-keyval";
import { OFFLINE_CACHE } from "./offline-constants";

export interface SavedMap {
  slug: string;
  title: string;
  version: number;
  savedAt: number;
  bytes: number;
  panoramas: number;
  urls: string[];
}

const store = createStore("ttk-viewer", "saved-maps");

/** Latin, Cyrillic, punctuation (— «»), letterlike (№). */
const GLYPH_RANGES = ["0-255", "256-511", "1024-1279", "8192-8447", "8448-8703"];

export const manifestUrl = (slug: string) =>
  slug === "demo"
    ? "/demo/manifest.json"
    : `/api/public/maps/${encodeURIComponent(slug)}/manifest.json`;

function glyphUrls(): string[] {
  const fontstack = PLAN_FONT.join(",");
  return GLYPH_RANGES.map((range) =>
    DEFAULT_GLYPHS.replace("{fontstack}", fontstack).replace("{range}", range),
  );
}

/** Every URL the visitor app requests for this map version. */
export function mapAssetUrls(slug: string, manifest: MapManifest, bundle: MapBundle): string[] {
  const urls = [manifestUrl(slug), manifest.bundleUrl];
  for (const pano of bundle.panos ?? []) {
    const tiles = pano.tiles;
    if (!tiles) continue;
    urls.push(tiles.previewUrl);
    for (const level of tiles.levels) {
      for (let row = 0; row < level.rows; row++) {
        for (let col = 0; col < level.cols; col++) {
          urls.push(`${tiles.baseUrl}/${level.width}/${row}_${col}.webp`);
        }
      }
    }
  }
  for (const underlay of bundle.underlays ?? []) urls.push(underlay.url);
  return [...new Set(urls)];
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await run(items[next++] as T);
  });
  await Promise.all(workers);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return (await response.json()) as T;
}

export async function saveMapOffline(
  slug: string,
  onProgress: (fraction: number) => void,
): Promise<SavedMap> {
  const manifest = await fetchJson<MapManifest & { version?: number }>(manifestUrl(slug));
  const bundle = await fetchJson<MapBundle>(manifest.bundleUrl);
  const required = mapAssetUrls(slug, manifest, bundle);
  const optional = glyphUrls(); // labels fall back to no text if fonts are unreachable
  const all = [...required, ...optional];
  const cache = await caches.open(OFFLINE_CACHE);
  let bytes = 0;
  let done = 0;

  await pool(all, 6, async (url) => {
    try {
      const response = await fetch(url, { cache: "no-cache", mode: "cors" });
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      bytes += (await response.clone().blob()).size;
      await cache.put(url, response);
    } catch (error) {
      if (required.includes(url)) throw error;
    } finally {
      onProgress(++done / all.length);
    }
  });

  const record: SavedMap = {
    slug,
    title: manifest.title,
    version: manifest.version ?? 1,
    savedAt: Date.now(),
    bytes,
    panoramas: bundle.panos?.length ?? 0,
    urls: all,
  };
  // An older saved version may own files the new one does not: drop them.
  const previous = await getSavedMap(slug);
  if (previous) {
    const keep = new Set(all);
    await Promise.all(previous.urls.filter((u) => !keep.has(u)).map((u) => cache.delete(u)));
  }
  await set(slug, record, store);
  // Ask the browser not to evict saved maps under storage pressure (iOS evicts otherwise).
  await navigator.storage?.persist?.().catch(() => false);
  return record;
}

export async function removeSavedMap(slug: string): Promise<void> {
  const record = await getSavedMap(slug);
  if (!record) return;
  const cache = await caches.open(OFFLINE_CACHE);
  await Promise.all(record.urls.map((url) => cache.delete(url)));
  await del(slug, store);
}

export const getSavedMap = (slug: string) => get<SavedMap>(slug, store);

export async function listSavedMaps(): Promise<SavedMap[]> {
  return (await values<SavedMap>(store)).sort((a, b) => b.savedAt - a.savedAt);
}

/** Saved copy of a JSON file, when the network and the service worker both cannot help. */
export async function savedJson<T>(url: string): Promise<T | undefined> {
  if (!("caches" in globalThis)) return undefined;
  const response = await (await caches.open(OFFLINE_CACHE)).match(url);
  return response ? ((await response.json()) as T) : undefined;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

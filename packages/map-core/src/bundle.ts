import type { MapDocument } from "@ttkpr/api-client";

export type MapBundle = MapDocument;

/** Short-lived pointer to the current immutable version (`/m/{slug}` reads this). */
export interface MapManifest {
  slug: string;
  title: string;
  /** Published version number; changes on every publish. */
  version?: number;
  bundleUrl: string;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return (await response.json()) as T;
}

export function loadManifest(url: string): Promise<MapManifest> {
  // Always revalidate: the manifest is the only mutable file of a published map.
  return getJson<MapManifest>(url, { cache: "no-cache" });
}

export function loadBundle(manifest: MapManifest): Promise<MapBundle> {
  // Bundles are immutable and cached forever by URL.
  return getJson<MapBundle>(manifest.bundleUrl);
}

export function sortedLevels(bundle: MapBundle) {
  return [...(bundle.levels ?? [])].sort((a, b) => a.ordinal - b.ordinal);
}

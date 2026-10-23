import { useQuery } from "@tanstack/react-query";
import { loadBundle, loadManifest, type MapBundle, type MapManifest } from "@ttkpr/map-core";
import { manifestUrl, savedJson } from "./offline";

export { manifestUrl };

export interface LoadedMap {
  manifest: MapManifest;
  bundle: MapBundle;
  /** Opened from the copy saved on this device because the network failed. */
  fromSaved: boolean;
}

// Network errors only (TypeError): an HTTP 403/404 must not be masked by an old saved copy.
const isNetworkError = (e: unknown) => e instanceof TypeError;

async function load(slug: string): Promise<LoadedMap> {
  const url = manifestUrl(slug);
  try {
    const manifest = await loadManifest(url);
    return { manifest, bundle: await loadBundle(manifest), fromSaved: false };
  } catch (error) {
    // The service worker already falls back to saved copies; this covers pages it does not
    // control yet (first visit, dev server).
    const manifest = isNetworkError(error) ? await savedJson<MapManifest>(url) : undefined;
    const bundle = manifest ? await savedJson<MapBundle>(manifest.bundleUrl) : undefined;
    if (!manifest || !bundle) throw error;
    return { manifest, bundle, fromSaved: true };
  }
}

export function useMapBundle(slug: string) {
  return useQuery({ queryKey: ["bundle", slug], queryFn: () => load(slug), networkMode: "always" });
}

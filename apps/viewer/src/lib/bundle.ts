import { useQuery } from "@tanstack/react-query";
import { loadBundle, loadManifest } from "@ttkpr/map-core";

const MAPS_BASE_URL = import.meta.env.VITE_MAPS_BASE_URL ?? "/maps";

export function manifestUrl(slug: string): string {
  return slug === "demo" ? "/demo/manifest.json" : `${MAPS_BASE_URL}/${slug}/manifest.json`;
}

export function useMapBundle(slug: string) {
  return useQuery({
    queryKey: ["bundle", slug],
    queryFn: async () => {
      const manifest = await loadManifest(manifestUrl(slug));
      return { manifest, bundle: await loadBundle(manifest) };
    },
  });
}

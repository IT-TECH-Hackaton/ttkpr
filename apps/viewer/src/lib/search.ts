import type { Poi } from "@ttkpr/api-client";
import { categoryLabel, type MapBundle } from "@ttkpr/map-core";
import MiniSearch from "minisearch";
import { useMemo } from "react";

interface SearchDoc {
  id: string;
  name: string;
  category: string;
  description: string;
}

export function usePoiSearch(bundle: MapBundle | undefined) {
  return useMemo(() => {
    const index = new MiniSearch<SearchDoc>({
      fields: ["name", "category", "description"],
      storeFields: ["id"],
      searchOptions: { prefix: true, fuzzy: 0.2, boost: { name: 3, category: 2 } },
    });
    const byId = new Map<string, Poi>();
    for (const poi of bundle?.pois ?? []) {
      byId.set(poi.id, poi);
      index.add({
        id: poi.id,
        name: poi.name,
        category: categoryLabel(poi.category),
        description: poi.description ?? "",
      });
    }
    return (query: string): Poi[] =>
      query.trim()
        ? index
            .search(query)
            .slice(0, 8)
            .flatMap((hit) => byId.get(String(hit.id)) ?? [])
        : [];
  }, [bundle]);
}

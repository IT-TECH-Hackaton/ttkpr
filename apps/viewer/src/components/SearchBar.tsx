import type { Level, Poi } from "@ttkpr/api-client";
import { categoryEmoji, categoryLabel } from "@ttkpr/map-core";
import { useState } from "react";

interface Props {
  search: (query: string) => Poi[];
  levels: Level[];
  onPick: (poi: Poi) => void;
}

export function SearchBar({ search, levels, onPick }: Props) {
  const [query, setQuery] = useState("");
  const results = search(query);
  const levelName = (id: string) => levels.find((l) => l.id === id)?.name ?? "";

  return (
    <div className="relative">
      <input
        type="search"
        inputMode="search"
        enterKeyHint="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Найти место: зал, стенд, кофе…"
        aria-label="Поиск по карте"
        className="h-12 w-full rounded-2xl border border-border bg-bg px-4 text-base shadow-lg outline-none focus:border-accent"
      />
      {results.length > 0 && (
        <ul className="absolute inset-x-0 top-14 max-h-[50dvh] overflow-auto rounded-2xl border border-border bg-bg py-1 shadow-xl">
          {results.map((poi) => (
            <li key={poi.id}>
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  onPick(poi);
                }}
                className="flex min-h-12 w-full items-center gap-3 px-4 text-left"
              >
                <span aria-hidden>{categoryEmoji(poi.category)}</span>
                <span className="flex-1">
                  <span className="block font-medium">{poi.name}</span>
                  <span className="block text-sm text-muted">
                    {categoryLabel(poi.category)} · {levelName(poi.levelId)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

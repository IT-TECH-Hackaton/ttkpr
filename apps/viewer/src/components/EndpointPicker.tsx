import type { Level, Poi } from "@ttkpr/api-client";
import { categoryEmoji, categoryLabel, type Endpoint, type MapBundle } from "@ttkpr/map-core";
import { ArrowLeft, Crosshair, LocateFixed } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { End } from "../lib/routing";

interface Props {
  end: End;
  bundle: MapBundle;
  levels: Level[];
  search: (query: string) => Poi[];
  hereId?: string;
  /** Already chosen for the other end: not offered again. */
  exclude?: string;
  onPick: (endpoint: Endpoint) => void;
  onPickOnMap: () => void;
  onClose: () => void;
}

/** Full-screen chooser for a route end: search, "Вы здесь", or a point on the plan. */
export function EndpointPicker({
  end,
  bundle,
  levels,
  search,
  hereId,
  exclude,
  onPick,
  onPickOnMap,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const here = bundle.pois?.find((p) => p.id === hereId);
  const levelName = (id: string) => levels.find((l) => l.id === id)?.name ?? "";
  const order = new Map(levels.map((l, i) => [l.id, i]));
  const pois = (
    query.trim()
      ? search(query)
      : [...(bundle.pois ?? [])].sort(
          (a, b) =>
            (order.get(a.levelId) ?? 0) - (order.get(b.levelId) ?? 0) ||
            a.name.localeCompare(b.name, "ru"),
        )
  ).filter((p) => p.id !== exclude);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = end === "from" ? "Откуда" : "Куда";
  return (
    <div
      role="dialog"
      aria-modal
      aria-label={title}
      className="fixed inset-0 z-30 flex flex-col bg-bg min-[900px]:inset-auto min-[900px]:bottom-4 min-[900px]:left-4 min-[900px]:top-4 min-[900px]:w-[380px] min-[900px]:overflow-hidden min-[900px]:rounded-2xl min-[900px]:border min-[900px]:border-border min-[900px]:shadow-2xl"
    >
      <div className="safe-top flex items-center gap-1 border-b border-border px-2 pb-2">
        <button
          type="button"
          aria-label="Назад"
          onClick={onClose}
          className="grid size-11 place-items-center rounded-xl active:bg-surface"
        >
          <ArrowLeft className="size-5" />
        </button>
        <input
          // biome-ignore lint/a11y/noAutofocus: the dialog exists to type into this field
          autoFocus
          type="search"
          inputMode="search"
          enterKeyHint="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={end === "from" ? "Откуда идёте?" : "Куда идёте?"}
          aria-label={`${title}: поиск места`}
          className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-base outline-none focus:border-accent"
        />
      </div>
      <div className="flex-1 overflow-auto">
        {!query.trim() && (
          <ul className="border-b-8 border-surface">
            {here && here.id !== exclude && (
              <Option
                icon={<LocateFixed className="size-5 text-green-700" />}
                title="Вы здесь"
                subtitle={here.name}
                onClick={() => onPick({ poiId: here.id })}
              />
            )}
            <Option
              icon={<Crosshair className="size-5 text-accent" />}
              title="Указать на плане"
              subtitle="Коснитесь карты в нужном месте"
              onClick={onPickOnMap}
            />
          </ul>
        )}
        <ul className="divide-y divide-border">
          {pois.map((poi) => (
            <Option
              key={poi.id}
              icon={<span className="text-lg">{categoryEmoji(poi.category)}</span>}
              title={poi.name}
              subtitle={`${categoryLabel(poi.category)} · ${levelName(poi.levelId)}`}
              onClick={() => onPick({ poiId: poi.id })}
            />
          ))}
        </ul>
        {query.trim() && pois.length === 0 && (
          <p className="px-6 py-10 text-center text-muted">Ничего не нашлось</p>
        )}
      </div>
    </div>
  );
}

function Option({
  icon,
  title,
  subtitle,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex min-h-14 w-full items-center gap-3 px-4 text-left active:bg-surface"
      >
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-full bg-surface"
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{title}</span>
          <span className="block truncate text-sm text-muted">{subtitle}</span>
        </span>
      </button>
    </li>
  );
}

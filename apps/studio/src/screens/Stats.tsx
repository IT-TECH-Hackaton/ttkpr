import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getMap, mapStats, type StatCount } from "@ttkpr/api-client";
import { cn } from "@ttkpr/ui";
import { useState } from "react";
import { AppShell } from "../components/AppShell";
import { StatsHeatmap } from "../components/StatsHeatmap";
import { unwrap } from "../lib/api";

const PERIODS = [7, 30, 90] as const;

const TOTALS: { kind: string; label: string }[] = [
  { kind: "view", label: "Открытий карты" },
  { kind: "poi", label: "Открыто мест" },
  { kind: "route", label: "Построено маршрутов" },
  { kind: "pano", label: "Просмотрено панорам" },
];

/** What visitors do with the map: anonymous daily counters sent by the viewer. */
export function StatsScreen({ mapId }: { mapId: string }) {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const map = useQuery({
    queryKey: ["map", mapId],
    queryFn: () => unwrap(getMap({ path: { map_id: mapId } })),
  });
  const stats = useQuery({
    queryKey: ["stats", mapId, days],
    queryFn: () => unwrap(mapStats({ path: { map_id: mapId }, query: { days } })),
    refetchInterval: 60_000,
  });
  const data = stats.data;
  const peak = Math.max(1, ...(data?.days.map((d) => d.views) ?? [0]));

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link
            to="/maps/$mapId"
            params={{ mapId }}
            className="inline-flex min-h-11 items-center text-sm text-muted hover:text-fg"
          >
            ← К редактору
          </Link>
          <h1 className="w-full text-xl font-semibold sm:w-auto sm:flex-1 sm:text-2xl">
            Статистика{map.data ? `: ${map.data.title}` : ""}
          </h1>
          <fieldset className="flex rounded-xl bg-surface p-1 text-sm">
            <legend className="sr-only">Период</legend>
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={days === p}
                onClick={() => setDays(p)}
                className={cn(
                  "min-h-9 rounded-lg px-3 font-medium",
                  days === p ? "bg-bg shadow" : "text-muted",
                )}
              >
                {p} дней
              </button>
            ))}
          </fieldset>
        </header>

        {stats.error && <p className="text-danger">{stats.error.message}</p>}
        {!data && !stats.error && <p className="text-muted">Считаем…</p>}

        {data && (
          <>
            <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {TOTALS.map(({ kind, label }) => (
                <li key={kind} className="rounded-2xl border border-border bg-bg p-4">
                  <p className="text-3xl font-semibold tabular-nums">
                    {(data.totals[kind] ?? 0).toLocaleString("ru-RU")}
                  </p>
                  <p className="text-sm text-muted">{label}</p>
                </li>
              ))}
            </ul>

            <section className="space-y-3 rounded-2xl border border-border bg-bg p-4">
              <h2 className="font-semibold">Открытия карты по дням</h2>
              <div
                className="flex h-40 items-end gap-px"
                role="img"
                aria-label={`Открытия карты за ${days} дней, максимум ${peak} в день`}
              >
                {data.days.map((d) => (
                  <div
                    key={String(d.day)}
                    title={`${new Date(d.day).toLocaleDateString("ru-RU")}: ${d.views}`}
                    className="min-w-0 flex-1 rounded-t bg-accent/80"
                    style={{ height: `${Math.max(2, (d.views / peak) * 100)}%` }}
                  />
                ))}
              </div>
              <div className="flex justify-between text-xs text-muted">
                <span>{new Date(data.days[0]?.day ?? Date.now()).toLocaleDateString("ru-RU")}</span>
                <span>сегодня</span>
              </div>
            </section>

            <StatsHeatmap mapId={mapId} counts={data.topPois} />

            <div className="grid gap-4 lg:grid-cols-2">
              <TopList
                title="Популярные места"
                items={data.topPois}
                empty="Пока никто не открывал места"
              />
              <TopList
                title="Частые маршруты"
                items={data.topRoutes}
                empty="Маршрутов ещё не строили"
              />
              <TopList
                title="Маршруты организатора"
                items={data.topTours}
                empty="Экскурсии ещё не открывали"
              />
              <TopList title="Что ищут" items={data.searches} empty="Поиском ещё не пользовались" />
              <TopList
                title="Искали, но не нашли"
                hint="Стоит добавить такие точки на план или в описания"
                items={data.misses}
                empty="Все поиски что-то находили"
                tone="warn"
              />
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

function TopList({
  title,
  hint,
  items,
  empty,
  tone,
}: {
  title: string;
  hint?: string;
  items: StatCount[];
  empty: string;
  tone?: "warn";
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <section className="space-y-3 rounded-2xl border border-border bg-bg p-4">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {hint && <p className="text-sm text-muted">{hint}</p>}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <ol className="space-y-2">
          {items.map((item) => (
            <li key={item.key} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{item.label}</span>
                <span className="shrink-0 tabular-nums text-muted">{item.count}</span>
              </div>
              <div className="h-1.5 rounded-full bg-surface">
                <div
                  className={cn(
                    "h-full rounded-full",
                    tone === "warn" ? "bg-amber-500" : "bg-accent",
                  )}
                  style={{ width: `${(item.count / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

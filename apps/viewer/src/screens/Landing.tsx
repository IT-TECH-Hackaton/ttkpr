import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatBytes, listSavedMaps } from "../lib/offline";
import { useOnline } from "../lib/useOnline";

const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

export function Landing() {
  const online = useOnline();
  const saved = useQuery({
    queryKey: ["saved", "all"],
    queryFn: listSavedMaps,
    networkMode: "always",
  });

  return (
    <main className="safe-top safe-bottom mx-auto flex min-h-full max-w-md flex-col justify-center gap-8 px-4">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold">Карта пространства</h1>
        <p className="text-muted">
          План здания, панорамы помещений и маршрут до нужного места — прямо в браузере телефона.
        </p>
      </div>

      <section className="space-y-3" aria-labelledby="saved-title">
        <h2 id="saved-title" className="text-lg font-semibold">
          Мои карты
        </h2>
        {!online && (
          <p className="rounded-xl bg-amber-100 p-3 text-sm text-amber-900">
            Нет сети — открываются только сохранённые карты.
          </p>
        )}
        {saved.data?.length === 0 && (
          <p className="text-sm text-muted">
            Здесь появятся карты, которые вы сохраните кнопкой «Сохранить офлайн», — они работают
            без интернета.
          </p>
        )}
        <ul className="space-y-2">
          {saved.data?.map((map) => (
            <li key={map.slug}>
              <Link
                to="/m/$slug"
                params={{ slug: map.slug }}
                className="flex min-h-14 items-center gap-3 rounded-2xl border border-border px-4 py-3"
              >
                <span className="text-xl" aria-hidden>
                  🗺️
                </span>
                <span className="flex-1">
                  <span className="block font-medium">{map.title}</span>
                  <span className="block text-xs text-muted">
                    Сохранена {dateFormat.format(map.savedAt)} · {formatBytes(map.bytes)}
                  </span>
                </span>
                <span className="text-xs font-medium text-emerald-700">офлайн</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <Link
        to="/m/$slug"
        params={{ slug: "demo" }}
        className="inline-flex min-h-12 items-center justify-center rounded-xl bg-accent px-4 font-medium text-accent-fg"
      >
        Открыть демо-карту
      </Link>
    </main>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getDraft, getMap, type MapSummary, publish, updateMap } from "@ttkpr/api-client";
import { categoryEmoji, SLUG_RE, slugify } from "@ttkpr/map-core";
import { Button, cn } from "@ttkpr/ui";
import { useEffect, useState } from "react";
import { AppShell } from "../components/AppShell";
import { downloadQrPng, downloadQrSvg, QrCode } from "../components/QrCode";
import { unwrap } from "../lib/api";
import { hereLink, isLanOnly, localMapLink, mapLink } from "../lib/links";

const ACCESS: { id: MapSummary["accessMode"]; title: string; hint: string }[] = [
  { id: "link", title: "По ссылке", hint: "Видят все, у кого есть ссылка или QR-код" },
  { id: "public", title: "Публичная", hint: "Можно показывать в каталогах и на сайте" },
  { id: "private", title: "Только участники", hint: "Только вошедшие организаторы этой карты" },
];

function copy(text: string, setCopied: (v: string) => void) {
  void navigator.clipboard.writeText(text).then(() => {
    setCopied(text);
    window.setTimeout(() => setCopied(""), 1500);
  });
}

export function ShareScreen({ mapId }: { mapId: string }) {
  const queryClient = useQueryClient();
  const map = useQuery({
    queryKey: ["map", mapId],
    queryFn: () => unwrap(getMap({ path: { map_id: mapId } })),
  });
  const draft = useQuery({
    queryKey: ["draft", mapId],
    queryFn: () => unwrap(getDraft({ path: { map_id: mapId } })),
  });
  const [slug, setSlug] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    if (map.data) setSlug(map.data.slug);
  }, [map.data]);

  const save = useMutation({
    mutationFn: (body: { slug?: string; accessMode?: MapSummary["accessMode"] }) =>
      unwrap(updateMap({ path: { map_id: mapId }, body })),
    onSuccess: (updated) => queryClient.setQueryData(["map", mapId], updated),
  });
  const publishNow = useMutation({
    mutationFn: () => unwrap(publish({ path: { map_id: mapId } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["map", mapId] }),
  });

  if (!map.data) return <div className="grid h-full place-items-center text-muted">Загружаем…</div>;
  const current = map.data;
  const link = mapLink(current.slug);
  const slugValid = SLUG_RE.test(slug);
  const embed = `<iframe src="${link}" width="100%" height="600" style="border:0;border-radius:16px" allow="fullscreen; accelerometer; gyroscope" loading="lazy"></iframe>`;
  const pois = draft.data?.document.pois ?? [];

  return (
    <AppShell>
      <div className="space-y-8 print:p-0">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 print:hidden">
          <Link
            to="/maps/$mapId"
            params={{ mapId }}
            className="inline-flex min-h-11 items-center text-sm text-muted hover:text-fg"
          >
            ← К редактору
          </Link>
          <h1 className="w-full text-xl font-semibold sm:w-auto sm:flex-1 sm:text-2xl">
            Поделиться: {current.title}
          </h1>
        </header>

        {!current.publishedNumber && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-amber-100 dark:bg-amber-950/60 p-4 text-amber-900 dark:text-amber-200 print:hidden">
            <span className="flex-1">
              Карта ещё не опубликована — посетители увидят ошибку по ссылке.
            </span>
            <Button onClick={() => publishNow.mutate()} disabled={publishNow.isPending}>
              Опубликовать сейчас
            </Button>
          </div>
        )}

        <section className="grid gap-6 md:grid-cols-[1fr_auto] print:hidden">
          <div className="min-w-0 space-y-4">
            <h2 className="text-lg font-semibold">Ссылка</h2>
            <div className="flex gap-2">
              <input
                readOnly
                value={link}
                aria-label="Ссылка на карту"
                className="h-12 min-w-0 flex-1 rounded-xl border border-border bg-surface px-4"
              />
              <Button onClick={() => copy(link, setCopied)}>
                {copied === link ? "Скопировано" : "Копировать"}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {"share" in navigator && (
                <Button
                  variant="secondary"
                  onClick={() => void navigator.share({ title: current.title, url: link })}
                >
                  Отправить…
                </Button>
              )}
              <a
                href={localMapLink(current.slug)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 font-medium"
              >
                Открыть как посетитель
              </a>
            </div>
            {isLanOnly() && (
              <p className="rounded-xl bg-surface p-3 text-sm text-muted">
                Это адрес компьютера в локальной сети: ссылка и QR-код откроются только на
                устройствах в той же сети Wi-Fi. Чтобы делиться через интернет, разверните проект на
                сервере или откройте его через туннель — см. README.
              </p>
            )}

            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (slugValid) save.mutate({ slug });
              }}
            >
              <label htmlFor="slug" className="block text-sm text-muted">
                Красивый адрес: …/m/<b>{slug || "адрес"}</b>
              </label>
              <div className="flex flex-wrap gap-2">
                <input
                  id="slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  className={cn(
                    "h-12 min-w-[12rem] flex-1 rounded-xl border bg-bg px-4 outline-none",
                    slugValid ? "border-border focus:border-accent" : "border-danger",
                  )}
                />
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setSlug(slugify(current.title))}
                >
                  Из названия
                </Button>
                <Button
                  type="submit"
                  disabled={!slugValid || slug === current.slug || save.isPending}
                >
                  Сохранить
                </Button>
              </div>
              <p className={cn("text-xs", slugValid ? "text-muted" : "text-danger")}>
                3–32 символа: латиница, цифры и дефис. Старая ссылка перестанет работать.
              </p>
              {save.error && <p className="text-sm text-danger">{save.error.message}</p>}
            </form>
          </div>

          <div className="space-y-3 text-center">
            <div className="rounded-2xl border border-border bg-white p-4">
              <QrCode value={link} size={200} label={`QR-код карты ${current.title}`} />
            </div>
            <div className="flex justify-center gap-2">
              <Button
                variant="secondary"
                className="min-h-9 text-sm"
                onClick={() => void downloadQrPng(link, `${current.slug}-qr.png`)}
              >
                PNG
              </Button>
              <Button
                variant="secondary"
                className="min-h-9 text-sm"
                onClick={() => void downloadQrSvg(link, `${current.slug}-qr.svg`)}
              >
                SVG
              </Button>
              <Button
                variant="secondary"
                className="min-h-9 text-sm"
                onClick={() => window.print()}
              >
                Печать
              </Button>
            </div>
          </div>
        </section>

        <section className="space-y-3 print:hidden">
          <h2 className="text-lg font-semibold">Кто видит карту</h2>
          <div className="grid gap-2 sm:grid-cols-3">
            {ACCESS.map((a) => (
              <button
                key={a.id}
                type="button"
                aria-pressed={current.accessMode === a.id}
                onClick={() => save.mutate({ accessMode: a.id })}
                className={cn(
                  "rounded-2xl border p-4 text-left",
                  current.accessMode === a.id ? "border-accent bg-accent/5" : "border-border",
                )}
              >
                <span className="block font-medium">{a.title}</span>
                <span className="block text-sm text-muted">{a.hint}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-3 print:hidden">
          <h2 className="text-lg font-semibold">Встроить на сайт</h2>
          <textarea
            readOnly
            value={embed}
            aria-label="Код для встраивания"
            className="h-24 w-full rounded-xl border border-border bg-surface p-3 font-mono text-xs"
          />
          <Button variant="secondary" onClick={() => copy(embed, setCopied)}>
            {copied === embed ? "Скопировано" : "Скопировать код"}
          </Button>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between print:hidden">
            <div>
              <h2 className="text-lg font-semibold">QR-метки «Вы здесь»</h2>
              <p className="text-sm text-muted">
                Распечатайте и наклейте у стендов и входов: скан открывает карту, и маршрут строится
                отсюда.
              </p>
            </div>
            <Button variant="secondary" onClick={() => window.print()} disabled={!pois.length}>
              Печать меток
            </Button>
          </div>
          {pois.length === 0 && (
            <p className="text-sm text-muted print:hidden">Добавьте точки на план в редакторе.</p>
          )}
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 print:grid-cols-3">
            {pois.map((poi) => (
              <li
                key={poi.id}
                className="break-inside-avoid space-y-2 rounded-2xl border border-border p-3 text-center"
              >
                <QrCode
                  value={hereLink(current.slug, poi.id)}
                  size={140}
                  className="mx-auto"
                  label={`QR-код точки ${poi.name}`}
                />
                <p className="font-medium">
                  {categoryEmoji(poi.category)} {poi.name}
                </p>
                <p className="text-xs text-muted">Вы здесь · сканируйте, чтобы найти дорогу</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}

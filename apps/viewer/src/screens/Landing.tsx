import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ThemeSwitch } from "@ttkpr/ui";
import { ArrowRight, Footprints, MapPinned, QrCode, View, WifiOff } from "lucide-react";
import { lazy, type ReactNode, Suspense } from "react";
import { formatBytes, listSavedMaps } from "../lib/offline";
import { useOnline } from "../lib/useOnline";

// three.js is a lazy chunk shared with the panorama viewer: the page works before it arrives.
const Hero3D = lazy(() => import("@ttkpr/ui/hero"));

const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

const STEPS: { icon: ReactNode; title: string; text: string }[] = [
  {
    icon: <QrCode className="size-5" />,
    title: "Откройте карту",
    text: "По ссылке, QR-коду «Вы здесь» на площадке или на сайте организатора",
  },
  {
    icon: <View className="size-5" />,
    title: "Осмотритесь",
    text: "Этажи, места с описаниями и панорамы помещений — как будто вы уже внутри",
  },
  {
    icon: <Footprints className="size-5" />,
    title: "Постройте маршрут",
    text: "Откуда → куда: путь на плане и прогулка по нему в панорамах",
  },
  {
    icon: <WifiOff className="size-5" />,
    title: "Без интернета",
    text: "Сохраните карту заранее — в подвале и на выставке связь не нужна",
  },
];

export function Landing() {
  const online = useOnline();
  const saved = useQuery({
    queryKey: ["saved", "all"],
    queryFn: listSavedMaps,
    networkMode: "always",
  });

  return (
    <main className="min-h-full bg-bg">
      <section className="relative h-[68dvh] min-h-[28rem] overflow-hidden bg-[#070b16] text-white">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_25%_15%,rgb(59_130_246/0.4),transparent_55%),radial-gradient(ellipse_at_85%_85%,rgb(20_184_166/0.28),transparent_50%)]" />
        <Suspense fallback={null}>
          {/* Phones: the venue above the headline; wide screens: on the right of it. */}
          <Hero3D
            dark
            aim={{ narrow: -30, wide: 2 }}
            className="absolute inset-x-0 top-0 h-[60%] lg:inset-y-0 lg:left-[38%] lg:h-full"
          />
        </Suspense>
        <header className="safe-top absolute inset-x-0 top-0 z-10 flex items-center justify-between px-5 pt-4 lg:px-12">
          <p className="flex items-center gap-2 font-semibold text-blue-100">
            <MapPinned className="size-5" aria-hidden />
            Карта пространства
          </p>
          <a
            href="/studio/"
            className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm font-medium backdrop-blur transition hover:bg-white/10"
          >
            Для организаторов
          </a>
        </header>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#070b16] via-[#070b16]/85 to-transparent px-5 pb-8 pt-28 lg:inset-y-0 lg:right-auto lg:flex lg:w-[52%] lg:items-center lg:bg-gradient-to-r lg:px-12 lg:pt-0 [&_a]:pointer-events-auto">
          <div className="animate-rise mx-auto max-w-5xl space-y-5">
            <h1 className="max-w-2xl text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
              Осмотрите площадку до того, как придёте
            </h1>
            <p className="max-w-xl text-base text-white/75 sm:text-lg">
              План здания, панорамы помещений и маршрут до нужного места — прямо в браузере
              телефона.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                to="/m/$slug"
                params={{ slug: "demo" }}
                className="group inline-flex min-h-12 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-500 px-5 font-semibold shadow-lg shadow-blue-500/30 transition hover:shadow-blue-500/50"
              >
                Открыть демо-карту
                <ArrowRight className="size-4 transition group-hover:translate-x-0.5" aria-hidden />
              </Link>
              <Link
                to="/m/$slug"
                params={{ slug: "demo" }}
                search={{ tour: "t-hackathon" }}
                className="inline-flex min-h-12 items-center rounded-xl border border-white/20 bg-white/5 px-5 font-medium backdrop-blur transition hover:bg-white/10"
              >
                Экскурсия по площадке
              </Link>
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-5xl space-y-10 px-5 py-10 lg:px-12">
        <section className="space-y-3" aria-labelledby="saved-title">
          <h2 id="saved-title" className="text-xl font-semibold">
            Мои карты
          </h2>
          {!online && (
            <p className="rounded-xl bg-amber-100 p-3 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
              Нет сети — открываются только сохранённые карты.
            </p>
          )}
          {saved.data?.length === 0 && (
            <p className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted">
              Здесь появятся карты, которые вы сохраните кнопкой «Сохранить офлайн», — они работают
              без интернета.
            </p>
          )}
          <ul className="grid gap-2 sm:grid-cols-2">
            {saved.data?.map((map) => (
              <li key={map.slug}>
                <Link
                  to="/m/$slug"
                  params={{ slug: map.slug }}
                  className="flex min-h-16 items-center gap-3 rounded-2xl border border-border px-4 py-3 transition hover:bg-surface"
                >
                  <span
                    className="grid size-10 place-items-center rounded-xl bg-accent/10 text-accent"
                    aria-hidden
                  >
                    <MapPinned className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{map.title}</span>
                    <span className="block text-xs text-muted">
                      Сохранена {dateFormat.format(map.savedAt)} · {formatBytes(map.bytes)}
                    </span>
                  </span>
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                    офлайн
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-4" aria-labelledby="how-title">
          <h2 id="how-title" className="text-xl font-semibold">
            Как это работает
          </h2>
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, i) => (
              <li
                key={step.title}
                className="animate-rise rounded-2xl border border-border p-4"
                style={{ animationDelay: `${0.1 + i * 0.08}s` }}
              >
                <span className="mb-3 grid size-10 place-items-center rounded-xl bg-accent/10 text-accent">
                  {step.icon}
                </span>
                <p className="font-semibold">{step.title}</p>
                <p className="text-sm text-muted">{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6 text-sm text-muted">
          <span>Карта пространства — план, панорамы и маршруты</span>
          <ThemeSwitch className="w-full max-w-xs" />
        </footer>
      </div>
    </main>
  );
}

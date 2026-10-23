import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { login, register } from "@ttkpr/api-client";
import { cn } from "@ttkpr/ui";
import {
  ArrowRight,
  Building2,
  Eye,
  EyeOff,
  Footprints,
  Lock,
  Mail,
  MapPinned,
  Smartphone,
  UserRound,
  WifiOff,
} from "lucide-react";
import { type FormEvent, lazy, type ReactNode, Suspense, useState } from "react";
import { ApiError, unwrap } from "../lib/api";
import { STUDIO_BASE } from "../lib/links";
import { meQueryKey } from "../lib/session";

// three.js is a lazy chunk: the form is usable before the scene arrives.
const Hero3D = lazy(() => import("@ttkpr/ui/hero"));

const FEATURES: { icon: ReactNode; title: string; text: string }[] = [
  {
    icon: <Building2 className="size-5" />,
    title: "План за минуты",
    text: "Комнаты, двери и этажи — или распознавание по картинке плана",
  },
  {
    icon: <Smartphone className="size-5" />,
    title: "Панорамы с телефона",
    text: "Подсказки при съёмке, склейка на сервере, точки прямо в панораме",
  },
  {
    icon: <Footprints className="size-5" />,
    title: "Маршруты и экскурсии",
    text: "Откуда → куда по плану и по панорамам, между зданиями",
  },
  {
    icon: <WifiOff className="size-5" />,
    title: "Работает без сети",
    text: "Посетители сохраняют карту, вы видите статистику",
  },
];

/** Rough strength: length and variety; enough to nudge, not to annoy. */
function strength(password: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (password.length < 8) return { score: 0, label: "Не короче 8 символов" };
  const kinds = [/[a-zа-я]/, /[A-ZА-Я]/, /\d/, /[^\w\s]/].filter((re) => re.test(password)).length;
  const score = (password.length >= 12 ? 1 : 0) + (kinds >= 3 ? 2 : kinds >= 2 ? 1 : 0);
  if (score >= 3) return { score: 3, label: "Надёжный пароль" };
  if (score === 2) return { score: 2, label: "Неплохо" };
  return { score: 1, label: "Слабоват: добавьте цифры или знаки" };
}

export function AuthScreen({ mode, next }: { mode: "login" | "register"; next?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isRegister = mode === "register";
  const quality = strength(password);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (isRegister && password.length < 8) {
      setError("Пароль — не короче 8 символов");
      return;
    }
    setPending(true);
    try {
      const user = isRegister
        ? await unwrap(register({ body: { email, name, password } }))
        : await unwrap(login({ body: { email, password } }));
      queryClient.setQueryData(meQueryKey, user);
      // Only same-app paths: "//host" would be an open redirect.
      const safeNext = next?.startsWith("/") && !next.startsWith("//") ? next : "/";
      // Invite links carry their token in the fragment, which the router does not keep.
      if (safeNext.includes("#")) window.location.assign(`${STUDIO_BASE}${safeNext}`);
      else await navigate({ to: safeNext });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Неверный email или пароль"
          : err instanceof Error
            ? err.message
            : "Что-то пошло не так",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="min-h-full bg-bg lg:grid lg:grid-cols-[1.2fr_1fr]">
      {/* Hero: the demo venue in 3D on a deep night gradient (the same in both themes). */}
      <section
        aria-label="Карта пространства"
        className="relative h-[44dvh] min-h-80 overflow-hidden bg-[#070b16] text-white lg:sticky lg:top-0 lg:h-dvh"
      >
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_20%,rgb(59_130_246/0.35),transparent_55%),radial-gradient(ellipse_at_80%_90%,rgb(20_184_166/0.25),transparent_50%)]" />
        <Suspense fallback={null}>
          <Hero3D dark className="absolute inset-0" />
        </Suspense>
        <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-[#070b16]/90 to-transparent p-6 pb-16 lg:p-10">
          <p className="flex items-center gap-2 text-sm font-semibold tracking-wide text-blue-200">
            <MapPinned className="size-5" aria-hidden />
            Карта пространства
          </p>
          <h2 className="mt-3 max-w-lg text-2xl font-semibold leading-tight sm:text-3xl lg:text-5xl">
            Осмотрите площадку до того, как придёте
          </h2>
        </div>
        <ul className="pointer-events-none absolute inset-x-0 bottom-0 hidden grid-cols-2 gap-3 bg-gradient-to-t from-[#070b16] via-[#070b16]/80 to-transparent p-10 pt-24 lg:grid">
          {FEATURES.map((f, i) => (
            <li
              key={f.title}
              className="animate-rise rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur"
              style={{ animationDelay: `${0.4 + i * 0.12}s` }}
            >
              <span className="mb-2 grid size-9 place-items-center rounded-xl bg-blue-500/20 text-blue-200">
                {f.icon}
              </span>
              <p className="font-semibold">{f.title}</p>
              <p className="text-sm text-white/65">{f.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="relative z-10 -mt-8 rounded-t-[28px] bg-bg px-5 pb-12 pt-8 shadow-[0_-12px_40px_rgb(0_0_0/0.25)] lg:mt-0 lg:flex lg:items-center lg:rounded-none lg:px-10 lg:shadow-none">
        <div className="animate-rise mx-auto w-full max-w-sm space-y-6">
          <nav
            aria-label="Вход или регистрация"
            className="flex rounded-2xl bg-surface p-1 text-sm"
          >
            {(
              [
                ["login", "/login", "Вход"],
                ["register", "/register", "Регистрация"],
              ] as const
            ).map(([id, to, label]) => (
              <Link
                key={id}
                to={to}
                search={{ next }}
                aria-current={mode === id ? "page" : undefined}
                className={cn(
                  "flex min-h-11 flex-1 items-center justify-center rounded-xl font-semibold transition",
                  mode === id ? "bg-bg text-fg shadow" : "text-muted hover:text-fg",
                )}
              >
                {label}
              </Link>
            ))}
          </nav>

          <div className="space-y-1.5">
            <h1 className="text-3xl font-semibold tracking-tight">
              {isRegister ? "Создайте студию" : "С возвращением"}
            </h1>
            <p className="text-muted">
              {isRegister
                ? "Аккаунт организатора: нарисуйте план, снимите панорамы и поделитесь картой."
                : "Войдите, чтобы редактировать карты площадок."}
            </p>
          </div>

          <form onSubmit={submit} className="space-y-4" noValidate>
            {isRegister && (
              <Field id="name" label="Имя или название организации" icon={<UserRound />}>
                <input
                  id="name"
                  className={input}
                  autoComplete="organization"
                  placeholder="Хакатон «Город»"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            )}
            <Field id="email" label="Email" icon={<Mail />}>
              <input
                id="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.ru"
                className={input}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field id="password" label="Пароль" icon={<Lock />}>
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete={isRegister ? "new-password" : "current-password"}
                className={cn(input, "pr-12")}
                required
                minLength={isRegister ? 8 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-1 top-1 grid size-10 place-items-center rounded-lg text-muted hover:text-fg"
              >
                {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
              </button>
            </Field>
            {isRegister && password && (
              <div className="space-y-1" aria-live="polite">
                <div className="flex gap-1">
                  {[1, 2, 3].map((step) => (
                    <span
                      key={step}
                      className={cn(
                        "h-1.5 flex-1 rounded-full transition-colors",
                        quality.score >= step
                          ? quality.score === 3
                            ? "bg-emerald-500"
                            : quality.score === 2
                              ? "bg-amber-500"
                              : "bg-red-500"
                          : "bg-surface",
                      )}
                    />
                  ))}
                </div>
                <p className="text-xs text-muted">{quality.label}</p>
              </div>
            )}
            {error && (
              <p
                role="alert"
                className="rounded-xl bg-red-50 p-3 text-sm text-danger dark:bg-red-950/60"
              >
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={pending}
              className="group flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 font-semibold text-white shadow-lg shadow-blue-600/25 transition hover:shadow-blue-600/40 active:scale-[0.99] disabled:opacity-60"
            >
              {pending ? (
                <span className="size-5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              ) : (
                <>
                  {isRegister ? "Создать аккаунт" : "Войти"}
                  <ArrowRight
                    className="size-4 transition group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </>
              )}
            </button>
          </form>

          <a
            href="/m/demo"
            className="flex min-h-12 items-center justify-between rounded-2xl border border-border px-4 text-sm transition hover:bg-surface"
          >
            <span>
              <span className="block font-medium">Посмотреть демо-карту</span>
              <span className="block text-muted">Как её увидят гости — без регистрации</span>
            </span>
            <ArrowRight className="size-4 text-muted" aria-hidden />
          </a>
        </div>
      </section>
    </main>
  );
}

const input =
  "h-12 w-full rounded-xl border border-border bg-bg pl-11 pr-4 text-base outline-none transition placeholder:text-muted/60 focus:border-accent focus:ring-4 focus:ring-accent/15";

function Field({
  id,
  label,
  icon,
  children,
}: {
  id: string;
  label: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <span
          className="pointer-events-none absolute left-3.5 top-3.5 text-muted [&>svg]:size-5"
          aria-hidden
        >
          {icon}
        </span>
        {children}
      </div>
    </div>
  );
}

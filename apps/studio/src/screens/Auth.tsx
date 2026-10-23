import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { login, register } from "@ttkpr/api-client";
import { Button } from "@ttkpr/ui";
import { type FormEvent, useState } from "react";
import { ApiError, unwrap } from "../lib/api";
import { meQueryKey } from "../lib/session";

const field =
  "h-12 w-full rounded-xl border border-border bg-bg px-4 text-base outline-none focus:border-accent";

export function AuthScreen({ mode, next }: { mode: "login" | "register"; next?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isRegister = mode === "register";

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
      if (safeNext.includes("#")) window.location.assign(safeNext);
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
    <main className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <div className="space-y-2">
        <p className="text-sm font-medium text-accent">Карта пространства · студия</p>
        <h1 className="text-3xl font-semibold">{isRegister ? "Регистрация" : "Вход"}</h1>
        <p className="text-muted">
          {isRegister
            ? "Создайте аккаунт организатора: нарисуйте план, снимите панорамы и поделитесь картой."
            : "Войдите, чтобы редактировать карты площадок."}
        </p>
      </div>

      <form onSubmit={submit} className="space-y-3" noValidate>
        {isRegister && (
          <div className="space-y-1">
            <label htmlFor="name" className="text-sm text-muted">
              Имя или название организации
            </label>
            <input
              id="name"
              className={field}
              autoComplete="organization"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        )}
        <div className="space-y-1">
          <label htmlFor="email" className="text-sm text-muted">
            Email
          </label>
          <input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            className={field}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="password" className="text-sm text-muted">
            Пароль{isRegister && " (от 8 символов)"}
          </label>
          <input
            id="password"
            type="password"
            autoComplete={isRegister ? "new-password" : "current-password"}
            className={field}
            required
            minLength={isRegister ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" className="h-12 w-full" disabled={pending}>
          {pending ? "Подождите…" : isRegister ? "Создать аккаунт" : "Войти"}
        </Button>
      </form>

      <p className="text-center text-sm text-muted">
        {isRegister ? "Уже есть аккаунт? " : "Нет аккаунта? "}
        <Link
          to={isRegister ? "/login" : "/register"}
          search={{ next }}
          className="font-medium text-accent"
        >
          {isRegister ? "Войти" : "Зарегистрироваться"}
        </Link>
      </p>
    </main>
  );
}

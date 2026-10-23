import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { changePassword, logoutEverywhere, updateProfile } from "@ttkpr/api-client";
import { Button } from "@ttkpr/ui";
import { type FormEvent, useEffect, useState } from "react";
import { AppShell } from "../components/AppShell";
import { Avatar } from "../components/UserMenu";
import { unwrap } from "../lib/api";
import { ROLE_HINTS, ROLE_LABELS } from "../lib/permissions";
import { meQueryKey, useMe } from "../lib/session";

const field =
  "h-11 w-full rounded-xl border border-border bg-bg px-3 outline-none focus:border-accent";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-2xl border border-border bg-bg p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function ProfileScreen() {
  const { data: user } = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [passwordDone, setPasswordDone] = useState(false);

  useEffect(() => {
    if (user) setName(user.name);
  }, [user]);

  const rename = useMutation({
    mutationFn: () => unwrap(updateProfile({ body: { name } })),
    onSuccess: (updated) => queryClient.setQueryData(meQueryKey, updated),
  });
  const password = useMutation({
    mutationFn: () =>
      unwrap(changePassword({ body: { currentPassword: current, newPassword: next } })),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setPasswordDone(true);
    },
  });
  const signOutEverywhere = useMutation({
    mutationFn: () => unwrap(logoutEverywhere()),
    onSuccess: async () => {
      queryClient.clear();
      queryClient.setQueryData(meQueryKey, null);
      await navigate({ to: "/login", search: { next: undefined } });
    },
  });

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Avatar name={user?.name} size={56} />
          <div>
            <h1 className="text-2xl font-semibold">{user?.name}</h1>
            <p className="text-muted">{user?.email}</p>
          </div>
        </div>

        <Card title="Профиль">
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (name.trim()) rename.mutate();
            }}
          >
            <label className="flex-1 space-y-1">
              <span className="text-sm text-muted">Имя или организация</span>
              <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <Button
              type="submit"
              disabled={!name.trim() || name === user?.name || rename.isPending}
            >
              {rename.isSuccess && name === user?.name ? "Сохранено" : "Сохранить"}
            </Button>
          </form>
          <p className="text-sm text-muted">Email: {user?.email} — используется для входа.</p>
        </Card>

        <Card title="Пароль">
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setPasswordDone(false);
              if (next.length >= 8) password.mutate();
            }}
          >
            <label className="space-y-1">
              <span className="text-sm text-muted">Текущий пароль</span>
              <input
                type="password"
                autoComplete="current-password"
                className={field}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="text-sm text-muted">Новый пароль (от 8 символов)</span>
              <input
                type="password"
                autoComplete="new-password"
                className={field}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </label>
            <div className="flex items-center gap-3 sm:col-span-2">
              <Button type="submit" disabled={!current || next.length < 8 || password.isPending}>
                Сменить пароль
              </Button>
              {password.error && (
                <span className="text-sm text-danger">{password.error.message}</span>
              )}
              {passwordDone && (
                <span className="text-sm text-emerald-700">
                  Пароль изменён, остальные устройства вышли из аккаунта
                </span>
              )}
            </div>
          </form>
        </Card>

        <Card title="Безопасность">
          <p className="text-sm text-muted">
            Потеряли телефон или входили с чужого компьютера? Завершите все сеансы — везде, включая
            это устройство, потребуется войти заново.
          </p>
          <Button
            variant="secondary"
            className="text-danger"
            disabled={signOutEverywhere.isPending}
            onClick={() => signOutEverywhere.mutate()}
          >
            Выйти на всех устройствах
          </Button>
        </Card>

        <Card title="Роли на картах">
          <p className="text-sm text-muted">
            Роль задаётся на каждой карте отдельно — в разделе «Команда».
          </p>
          <ul className="divide-y divide-border">
            {Object.entries(ROLE_LABELS).map(([role, label]) => (
              <li key={role} className="flex gap-4 py-2 text-sm">
                <span className="w-28 shrink-0 font-medium">{label}</span>
                <span className="text-muted">{ROLE_HINTS[role as keyof typeof ROLE_HINTS]}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </AppShell>
  );
}

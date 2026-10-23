import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { acceptInvite } from "@ttkpr/api-client";
import { Button } from "@ttkpr/ui";
import { useEffect, useMemo } from "react";
import { unwrap } from "../lib/api";
import { ROLE_LABELS } from "../lib/permissions";
import { useMe } from "../lib/session";

/** /invite#t=… : sign in or register, then join the map with the invited role. */
export function InviteScreen() {
  const token = useMemo(() => new URLSearchParams(location.hash.slice(1)).get("t") ?? "", []);
  const { data: user, isPending } = useMe();
  const navigate = useNavigate();
  const accept = useMutation({
    mutationFn: () => unwrap(acceptInvite({ body: { token } })),
    onSuccess: (map) => navigate({ to: "/maps/$mapId", params: { mapId: map.id } }),
  });

  useEffect(() => {
    if (user && token && accept.isIdle) accept.mutate();
  }, [user, token, accept]);

  const next = `/invite#t=${token}`;
  return (
    <main className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-5 px-4 text-center">
      <h1 className="text-2xl font-semibold">Приглашение в команду</h1>
      {!token && <p className="text-muted">В ссылке нет приглашения.</p>}
      {token && !isPending && !user && (
        <>
          <p className="text-muted">
            Войдите или зарегистрируйтесь — после этого вы сразу попадёте в карту.
          </p>
          <Link
            to="/register"
            search={{ next }}
            className="inline-flex h-12 items-center justify-center rounded-xl bg-accent font-medium text-accent-fg"
          >
            Зарегистрироваться
          </Link>
          <Link to="/login" search={{ next }} className="font-medium text-accent">
            У меня уже есть аккаунт
          </Link>
        </>
      )}
      {accept.isPending && <p className="text-muted">Присоединяемся…</p>}
      {accept.error && (
        <>
          <p className="rounded-xl bg-red-50 dark:bg-red-950/60 p-3 text-danger">
            {accept.error.message}
          </p>
          <Button variant="secondary" onClick={() => navigate({ to: "/" })}>
            К моим картам
          </Button>
        </>
      )}
      {accept.data && <p>Вы в команде как «{ROLE_LABELS[accept.data.role ?? "viewer"]}».</p>}
    </main>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  addMember,
  createInvite,
  getMap,
  listMembers,
  type MemberOut,
  removeMember,
  updateMember,
} from "@ttkpr/api-client";
import { Button, cn } from "@ttkpr/ui";
import { ArrowLeft } from "lucide-react";
import { type FormEvent, useState } from "react";
import { AppShell } from "../components/AppShell";
import { QrCode } from "../components/QrCode";
import { Avatar } from "../components/UserMenu";
import { unwrap } from "../lib/api";
import { studioOrigin } from "../lib/links";
import { can, ROLE_HINTS, ROLE_LABELS } from "../lib/permissions";

type Role = MemberOut["role"];
const ASSIGNABLE: Role[] = ["owner", "editor", "photographer", "viewer"];
const INVITABLE: Role[] = ["editor", "photographer", "viewer"];
const field = "h-11 rounded-xl border border-border bg-bg px-3 outline-none focus:border-accent";

export function TeamScreen({ mapId }: { mapId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const map = useQuery({
    queryKey: ["map", mapId],
    queryFn: () => unwrap(getMap({ path: { map_id: mapId } })),
  });
  const members = useQuery({
    queryKey: ["members", mapId],
    queryFn: () => unwrap(listMembers({ path: { map_id: mapId } })),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["members", mapId] });
  const manage = can(map.data, "manage_team");

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [inviteRole, setInviteRole] = useState<Role>("photographer");
  const [copied, setCopied] = useState(false);

  const add = useMutation({
    mutationFn: () => unwrap(addMember({ path: { map_id: mapId }, body: { email, role } })),
    onSuccess: () => {
      setEmail("");
      void refresh();
    },
  });
  const change = useMutation({
    mutationFn: (m: { userId: string; role: Role }) =>
      unwrap(updateMember({ path: { map_id: mapId, user_id: m.userId }, body: { role: m.role } })),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      unwrap(removeMember({ path: { map_id: mapId, user_id: userId } })),
    onSuccess: async (_data, userId) => {
      const me = members.data?.find((m) => m.isYou);
      if (me && me.userId === userId) await navigate({ to: "/" });
      else void refresh();
    },
  });
  const invite = useMutation({
    mutationFn: () => unwrap(createInvite({ path: { map_id: mapId }, body: { role: inviteRole } })),
  });
  const inviteLink = invite.data ? `${studioOrigin()}/invite#t=${invite.data.token}` : "";
  const error = add.error ?? change.error ?? remove.error ?? invite.error;

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link
            to="/maps/$mapId"
            params={{ mapId }}
            className="rounded-xl p-2 hover:bg-bg"
            aria-label="К редактору"
          >
            <ArrowLeft className="size-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-semibold">Команда</h1>
            <p className="text-muted">{map.data?.title}</p>
          </div>
        </div>

        {error && <p className="rounded-xl bg-red-50 p-3 text-sm text-danger">{error.message}</p>}

        <section className="space-y-3 rounded-2xl border border-border bg-bg p-5">
          <h2 className="text-lg font-semibold">Участники</h2>
          <ul className="divide-y divide-border">
            {members.data?.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center gap-3 py-3">
                <Avatar name={m.name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {m.name} {m.isYou && <span className="text-sm text-muted">(вы)</span>}
                  </p>
                  <p className="truncate text-sm text-muted">{m.email}</p>
                </div>
                {manage ? (
                  <select
                    aria-label={`Роль: ${m.name}`}
                    className={field}
                    value={m.role}
                    onChange={(e) =>
                      change.mutate({ userId: m.userId, role: e.target.value as Role })
                    }
                  >
                    {ASSIGNABLE.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="rounded-lg bg-surface px-3 py-1 text-sm">
                    {ROLE_LABELS[m.role]}
                  </span>
                )}
                {(manage || m.isYou) && (
                  <Button
                    variant="ghost"
                    className="text-sm text-danger"
                    onClick={() => remove.mutate(m.userId)}
                  >
                    {m.isYou ? "Покинуть" : "Убрать"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>

        {manage && (
          <div className="grid gap-6 md:grid-cols-2">
            <section className="space-y-3 rounded-2xl border border-border bg-bg p-5">
              <h2 className="text-lg font-semibold">Добавить по email</h2>
              <p className="text-sm text-muted">Для тех, кто уже зарегистрирован в студии.</p>
              <form
                className="space-y-3"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  if (email) add.mutate();
                }}
              >
                <input
                  type="email"
                  aria-label="Email участника"
                  placeholder="name@example.com"
                  className={cn(field, "w-full")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <RolePicker value={role} options={ASSIGNABLE} onChange={setRole} />
                <Button type="submit" className="w-full" disabled={!email || add.isPending}>
                  Добавить
                </Button>
              </form>
            </section>

            <section className="space-y-3 rounded-2xl border border-border bg-bg p-5">
              <h2 className="text-lg font-semibold">Пригласить по ссылке или QR</h2>
              <p className="text-sm text-muted">
                Ссылка действует неделю. Новый человек зарегистрируется и сразу попадёт в команду.
              </p>
              <RolePicker value={inviteRole} options={INVITABLE} onChange={setInviteRole} />
              <Button
                className="w-full"
                onClick={() => invite.mutate()}
                disabled={invite.isPending}
              >
                Создать приглашение
              </Button>
              {inviteLink && (
                <div className="space-y-3">
                  <div className="mx-auto w-fit rounded-xl bg-white p-3">
                    <QrCode value={inviteLink} size={180} label="QR-код приглашения" />
                  </div>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={inviteLink}
                      aria-label="Ссылка-приглашение"
                      className={cn(field, "min-w-0 flex-1 text-sm")}
                    />
                    <Button
                      variant="secondary"
                      onClick={() =>
                        void navigator.clipboard.writeText(inviteLink).then(() => setCopied(true))
                      }
                    >
                      {copied ? "Скопировано" : "Копировать"}
                    </Button>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function RolePicker({
  value,
  options,
  onChange,
}: {
  value: Role;
  options: Role[];
  onChange: (role: Role) => void;
}) {
  return (
    <div className="space-y-2" role="radiogroup" aria-label="Роль">
      {options.map((r) => (
        <label
          key={r}
          className={cn(
            "flex cursor-pointer gap-3 rounded-xl border p-3 text-sm",
            value === r ? "border-accent bg-accent/5" : "border-border",
          )}
        >
          <input type="radio" name="role" checked={value === r} onChange={() => onChange(r)} />
          <span>
            <span className="block font-medium">{ROLE_LABELS[r]}</span>
            <span className="block text-muted">{ROLE_HINTS[r]}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

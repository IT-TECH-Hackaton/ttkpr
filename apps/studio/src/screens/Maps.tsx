import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  createMap,
  deleteMap,
  listMaps,
  type MapDocument,
  type MapSummary,
  saveDraft,
} from "@ttkpr/api-client";
import { Button, cn } from "@ttkpr/ui";
import { Eye, MoreHorizontal, Pencil, Plus, QrCode, Trash, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import demoMap from "../../../../fixtures/demo-map.json";
import { AppShell } from "../components/AppShell";
import { MenuDivider, MenuItem, Popover } from "../components/Popover";
import { unwrap } from "../lib/api";
import { mapLink } from "../lib/links";
import { can, ROLE_LABELS } from "../lib/permissions";
import { useMe } from "../lib/session";

const ACCESS_LABELS: Record<string, string> = {
  public: "Публичная",
  link: "По ссылке",
  password: "По паролю",
  private: "Только участники",
};

const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

export function MapsScreen({ startCreating }: { startCreating?: boolean }) {
  const { data: user } = useMe();
  const queryClient = useQueryClient();
  const maps = useQuery({ queryKey: ["maps"], queryFn: () => unwrap(listMaps()) });
  const [creating, setCreating] = useState(Boolean(startCreating));
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(deleteMap({ path: { map_id: id } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["maps"] }),
  });

  return (
    <AppShell
      wide
      actions={
        <Button onClick={() => setCreating(true)} className="min-h-10">
          <Plus className="size-4" />
          <span className="hidden sm:inline">Создать карту</span>
        </Button>
      }
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">
            {user ? `Здравствуйте, ${user.name.split(" ")[0]}` : "Мои карты"}
          </h1>
          <p className="text-muted">Карты, в командах которых вы состоите.</p>
        </div>

        {maps.isPending && <p className="text-muted">Загружаем…</p>}
        {maps.data?.length === 0 && (
          <div className="space-y-3 rounded-2xl border border-dashed border-border bg-bg p-8 text-center">
            <p className="text-lg font-medium">Карт пока нет</p>
            <p className="text-muted">Создайте карту площадки или начните с готового демо-плана.</p>
            <Button onClick={() => setCreating(true)}>Создать карту</Button>
          </div>
        )}

        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {maps.data?.map((m) => (
            <MapCard
              key={m.id}
              map={m}
              onDelete={() => {
                if (
                  window.confirm(`Удалить карту «${m.title}» вместе с панорамами? Это необратимо.`)
                ) {
                  remove.mutate(m.id);
                }
              }}
            />
          ))}
        </ul>
      </div>
      {creating && <CreateMapDialog onClose={() => setCreating(false)} />}
    </AppShell>
  );
}

function MapCard({ map, onDelete }: { map: MapSummary; onDelete: () => void }) {
  const navigate = useNavigate();
  const open = (to: "/maps/$mapId" | "/maps/$mapId/share" | "/maps/$mapId/team") =>
    void navigate({ to, params: { mapId: map.id } });
  return (
    <li className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-bg p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Link
            to="/maps/$mapId"
            params={{ mapId: map.id }}
            className="block truncate text-lg font-semibold hover:text-accent"
          >
            {map.title}
          </Link>
          <p className="text-sm text-muted">
            {ROLE_LABELS[map.role ?? "viewer"]} · изменена{" "}
            {dateFormat.format(new Date(map.updatedAt))}
          </p>
        </div>
        <Popover
          align="right"
          trigger={({ toggle, open: isOpen }) => (
            <button
              type="button"
              aria-label="Действия с картой"
              aria-expanded={isOpen}
              onClick={toggle}
              className="rounded-lg p-1.5 text-muted hover:bg-surface"
            >
              <MoreHorizontal className="size-5" />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon={<Pencil />} onClick={() => open("/maps/$mapId")}>
                Редактировать
              </MenuItem>
              <MenuItem
                icon={<QrCode />}
                disabled={!can(map, "share")}
                onClick={() => open("/maps/$mapId/share")}
              >
                Поделиться и QR
              </MenuItem>
              <MenuItem icon={<Users />} onClick={() => open("/maps/$mapId/team")}>
                Команда
              </MenuItem>
              <MenuItem
                icon={<Eye />}
                disabled={!map.publishedNumber}
                onClick={() => {
                  close();
                  window.open(mapLink(map.slug), "_blank");
                }}
              >
                Открыть как посетитель
              </MenuItem>
              {can(map, "delete") && (
                <>
                  <MenuDivider />
                  <MenuItem
                    icon={<Trash />}
                    danger
                    onClick={() => {
                      close();
                      onDelete();
                    }}
                  >
                    Удалить карту
                  </MenuItem>
                </>
              )}
            </>
          )}
        </Popover>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <span
          className={cn(
            "rounded-full px-2.5 py-1",
            map.publishedNumber ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800",
          )}
        >
          {map.publishedNumber ? `Опубликована · v${map.publishedNumber}` : "Черновик"}
        </span>
        <span className="rounded-full bg-surface px-2.5 py-1 text-muted">
          {ACCESS_LABELS[map.accessMode] ?? map.accessMode}
        </span>
      </div>
      <p className="truncate text-xs text-muted">{mapLink(map.slug)}</p>
      <Link
        to="/maps/$mapId"
        params={{ mapId: map.id }}
        className="mt-auto inline-flex min-h-10 items-center justify-center rounded-xl bg-accent px-3 text-sm font-medium text-accent-fg"
      >
        Открыть редактор
      </Link>
    </li>
  );
}

function CreateMapDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [demo, setDemo] = useState(false);
  const create = useMutation({
    mutationFn: async () => {
      const created = await unwrap(createMap({ body: { title: title.trim() } }));
      if (demo) {
        // JSON imports widen [lon, lat] tuples; the fixture is generated from the schema.
        const base = demoMap as unknown as MapDocument;
        const document = { ...base, panos: [], venue: { ...base.venue, name: title.trim() } };
        await unwrap(
          saveDraft({
            path: { map_id: created.id },
            body: { document, version: created.draftVersion },
          }),
        );
      }
      return created;
    },
    onSuccess: (created) => navigate({ to: "/maps/$mapId", params: { mapId: created.id } }),
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <form
        className="w-full max-w-md space-y-4 rounded-2xl bg-bg p-6 shadow-2xl"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (title.trim()) create.mutate();
        }}
      >
        <h2 id="create-title" className="text-xl font-semibold">
          Новая карта
        </h2>
        <label className="block space-y-1">
          <span className="text-sm text-muted">Название площадки</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: the only field of a dialog the user just opened
            autoFocus
            className="h-12 w-full rounded-xl border border-border bg-bg px-4 outline-none focus:border-accent"
            placeholder="Отель «Сокол», выставка, кампус…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="flex items-start gap-3 rounded-xl border border-border p-3 text-sm">
          <input
            type="checkbox"
            checked={demo}
            onChange={(e) => setDemo(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium">Начать с демо-плана</span>
            <span className="text-muted">
              Два этажа, залы, кафе и точки — удобно посмотреть, как всё работает.
            </span>
          </span>
        </label>
        {create.error && <p className="text-sm text-danger">{create.error.message}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" disabled={!title.trim() || create.isPending}>
            {create.isPending ? "Создаём…" : "Создать"}
          </Button>
        </div>
      </form>
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getDraft, getMap, type MapSummary, publish } from "@ttkpr/api-client";
import { Button, cn } from "@ttkpr/ui";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { EditorMap } from "../components/EditorMap";
import {
  GridReadout,
  HelpDialog,
  HistoryAndHelp,
  LayersButton,
  panel,
  TOOLS,
  Toolbar,
  TopLeft,
  TopRight,
  ZoomControls,
} from "../components/editor/Chrome";
import { markTourSeen, StudioTour, tourPending } from "../components/editor/Tour";
import { Inspector } from "../components/Inspector";
import { unwrap } from "../lib/api";
import {
  clearBackup,
  type DraftBackup,
  readBackup,
  useAutosave,
  useUnsavedGuard,
} from "../lib/autosave";
import { localMapLink, mapLink } from "../lib/links";
import { usePanoramaActions, usePanoramas } from "../lib/panos";
import { can } from "../lib/permissions";
import { useUploadPlan } from "../lib/uploadPlan";
import { useDraft } from "../store";

export function EditorScreen({ mapId }: { mapId: string }) {
  const queryClient = useQueryClient();
  const map = useQuery({
    queryKey: ["map", mapId],
    queryFn: () => unwrap(getMap({ path: { map_id: mapId } })),
  });
  const draft = useQuery({
    queryKey: ["draft", mapId],
    queryFn: () => unwrap(getDraft({ path: { map_id: mapId } })),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const loadedFor = useDraft((s) => s.mapId);
  const [published, setPublished] = useState<number | null>(null);
  const [staleBackup, setStaleBackup] = useState<DraftBackup | null>(null);

  useEffect(() => {
    if (!draft.data) return;
    const { document, version } = draft.data;
    const backup = readBackup(mapId);
    const differs = backup && JSON.stringify(backup.doc) !== JSON.stringify(document);
    if (backup && differs && backup.baseVersion === version) {
      // Edits made offline (or before a crash) on top of the current server version: resume them.
      useDraft.getState().load(mapId, backup.doc, version, true);
      return;
    }
    if (backup && differs) setStaleBackup(backup);
    else if (backup) clearBackup(mapId);
    useDraft.getState().load(mapId, document, version);
  }, [draft.data, mapId]);

  useAutosave();
  useUnsavedGuard();

  const publishMutation = useMutation({
    mutationFn: () => unwrap(publish({ path: { map_id: mapId } })),
    onSuccess: (result) => {
      setPublished(result.number);
      void queryClient.invalidateQueries({ queryKey: ["map", mapId] });
    },
  });

  if (draft.error || map.error) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        Карта не найдена или нет доступа.
      </div>
    );
  }
  if (!draft.data || loadedFor !== mapId || !map.data) {
    return <div className="grid h-full place-items-center text-muted">Открываем редактор…</div>;
  }

  return (
    <EditorLayout
      map={map.data}
      onPublish={() => publishMutation.mutate()}
      publishing={publishMutation.isPending}
      published={published}
      onDismissPublished={() => setPublished(null)}
      onReload={() => {
        useDraft.getState().setSaveState("saved");
        void draft.refetch();
      }}
      staleBackup={staleBackup}
      onRestoreBackup={() => {
        if (staleBackup && draft.data) {
          useDraft.getState().load(mapId, staleBackup.doc, draft.data.version, true);
        }
        setStaleBackup(null);
      }}
      onDiscardBackup={() => {
        clearBackup(mapId);
        setStaleBackup(null);
      }}
    />
  );
}

interface LayoutProps {
  map: MapSummary;
  onPublish: () => void;
  publishing: boolean;
  published: number | null;
  onDismissPublished: () => void;
  onReload: () => void;
  staleBackup: DraftBackup | null;
  onRestoreBackup: () => void;
  onDiscardBackup: () => void;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement;

function EditorLayout(props: LayoutProps) {
  const { map, published, staleBackup } = props;
  const panos = usePanoramas(map.id);
  const panoActions = usePanoramaActions(map.id);
  const tool = useDraft((s) => s.tool);
  const hint = useDraft((s) => s.hint);
  const selectedId = useDraft((s) => s.selectedId);
  const panoSpot = useDraft((s) => s.panoSpot);
  const moving = useDraft((s) => s.movingPanoId);
  const saveState = useDraft((s) => s.saveState);
  const saveError = useDraft((s) => s.saveError);
  const { undo, redo } = useStore(useDraft.temporal);
  const [help, setHelp] = useState(false);
  // The tour starts by itself the first time this device opens the editor.
  const [tour, setTour] = useState(tourPending);
  const closeTour = () => {
    setTour(false);
    markTourSeen();
  };
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.matchMedia("(min-width: 768px)").matches,
  );
  const plan = useUploadPlan(map.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const canEdit = can(map, "edit");
  const canCapture = can(map, "capture");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const s = useDraft.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        if (s.tool !== "select") s.setTool("select");
        else s.select(null);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && s.selectedId && canEdit) {
        e.preventDefault();
        s.remove(s.selectedId);
        return;
      }
      const def = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (def && can(map, def.needs)) s.setTool(def.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, canEdit, map]);

  // A new selection reopens the panel. Clicking empty ground clears it and closes the panel,
  // instead of swapping the room for the map overview.
  const openedFor = useRef<string | null>(selectedId ?? (panoSpot ? "pano-spot" : null));
  useEffect(() => {
    const current = selectedId ?? (panoSpot ? "pano-spot" : null);
    if (current) setInspectorOpen(true);
    else if (openedFor.current) setInspectorOpen(false);
    openedFor.current = current;
  }, [selectedId, panoSpot]);

  const activeTool = TOOLS.find((t) => t.id === tool);
  const status =
    hint ??
    (moving
      ? "Кликните, куда перенести панораму"
      : tool !== "select"
        ? `${activeTool?.label}: ${activeTool?.hint} · Esc — выйти`
        : null);

  return (
    <div className="relative h-full overflow-hidden bg-slate-200">
      <EditorMap
        panos={panos.data ?? []}
        canEdit={canEdit}
        onMovePano={(id, position) => panoActions.update.mutate({ id, patch: { position } })}
      />

      <div className="safe-top pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 px-3">
        <TopLeft map={map} onOpenHelp={() => setHelp(true)} />
        <TopRight map={map} onPublish={props.onPublish} publishing={props.publishing} />
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-20 flex flex-col items-center gap-2 px-3">
        {!canEdit && (
          <p className={cn(panel, "pointer-events-auto px-4 py-2 text-sm")}>
            {canCapture
              ? "Роль «Съёмщик»: можно снимать и загружать панорамы, план — только просмотр"
              : "Только просмотр: изменять карту может владелец или редактор"}
          </p>
        )}
        {published !== null && (
          <div className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/60 px-4 py-2 text-sm text-emerald-900 dark:text-emerald-200 shadow-lg">
            <span>
              Опубликована версия {published}. Ссылка не меняется:{" "}
              <a
                href={localMapLink(map.slug)}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline"
              >
                {mapLink(map.slug)}
              </a>
            </span>
            <button type="button" aria-label="Закрыть" onClick={props.onDismissPublished}>
              <X className="size-4" />
            </button>
          </div>
        )}
        {staleBackup && (
          <div className="pointer-events-auto flex max-w-xl flex-wrap items-center gap-2 rounded-2xl bg-sky-50 dark:bg-sky-950/60 px-4 py-2 text-sm text-sky-900 dark:text-sky-200 shadow-lg">
            <span className="flex-1">
              На этом устройстве есть несохранённые изменения от{" "}
              {new Date(staleBackup.savedAt).toLocaleString("ru-RU")}, а карту уже меняли.
            </span>
            <Button variant="secondary" className="min-h-9" onClick={props.onRestoreBackup}>
              Вернуть мои
            </Button>
            <Button variant="ghost" className="min-h-9" onClick={props.onDiscardBackup}>
              Отбросить
            </Button>
          </div>
        )}
        {saveState === "conflict" && (
          <div className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-2xl bg-amber-100 dark:bg-amber-950/60 px-4 py-2 text-sm text-amber-900 dark:text-amber-200 shadow-lg">
            <span className="flex-1">{saveError} Загрузите свежую версию.</span>
            <Button variant="secondary" className="min-h-9" onClick={props.onReload}>
              Обновить
            </Button>
          </div>
        )}
        {plan.error && (
          <p className="pointer-events-auto rounded-2xl bg-red-50 dark:bg-red-950/60 px-4 py-2 text-sm text-danger shadow-lg">
            {plan.error}
          </p>
        )}
        {plan.pending && (
          <p className={cn(panel, "pointer-events-auto px-4 py-2 text-sm")}>Загружаем план…</p>
        )}
      </div>

      {inspectorOpen ? (
        <aside
          aria-label="Свойства"
          data-tour="inspector"
          className="absolute bottom-24 right-3 top-20 z-10 flex w-[min(22rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl bg-bg shadow-2xl max-md:inset-x-3 max-md:bottom-[7.5rem] max-md:top-auto max-md:max-h-[50dvh] max-md:w-auto"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <span className="text-sm font-medium text-muted">Свойства</span>
            <button
              type="button"
              aria-label="Свернуть панель"
              onClick={() => setInspectorOpen(false)}
              className="-mr-2 grid size-10 place-items-center rounded-lg hover:bg-surface"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <Inspector panos={panos.data ?? []} mapId={map.id} slug={map.slug} canEdit={canEdit} />
          </div>
        </aside>
      ) : (
        <button
          type="button"
          onClick={() => setInspectorOpen(true)}
          data-tour="inspector"
          className={cn(panel, "absolute right-3 top-20 z-10 px-3 py-2 text-sm")}
        >
          Свойства
        </button>
      )}

      <div className="safe-bottom pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-2 px-3">
        <LayersButton />
        <div className="flex min-w-0 flex-1 flex-col items-center gap-2 max-md:order-last max-md:w-full max-md:flex-none">
          {status && (
            <p className="max-w-full rounded-xl bg-slate-900/80 px-3 py-1.5 text-center text-xs text-white">
              {status}
            </p>
          )}
          <Toolbar map={map} onUploadPlan={() => fileRef.current?.click()} />
        </div>
        <div className="flex flex-col items-end gap-2">
          <GridReadout />
          <HistoryAndHelp onOpenHelp={() => setHelp(true)} />
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-24 left-3 max-md:hidden">
        <ZoomControls />
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void plan.upload(file);
          e.target.value = "";
        }}
      />
      {help && (
        <HelpDialog
          onClose={() => setHelp(false)}
          onStartTour={() => {
            setHelp(false);
            setTour(true);
          }}
        />
      )}
      {tour && <StudioTour onClose={closeTour} />}
    </div>
  );
}

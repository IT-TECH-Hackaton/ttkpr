import { useNavigate } from "@tanstack/react-router";
import type { MapSummary } from "@ttkpr/api-client";
import { bundleBounds, CONNECTOR_LABELS, POI_CATEGORIES, sortedLevels } from "@ttkpr/map-core";
import { cn } from "@ttkpr/ui";
import {
  Armchair,
  Camera,
  ChartColumn,
  Check,
  ChevronDown,
  CircleQuestionMark,
  CloudOff,
  DoorOpen,
  Eye,
  Footprints,
  ImagePlus,
  Layers,
  LoaderCircle,
  Magnet,
  Map as MapIcon,
  MapPin,
  Maximize2,
  Menu,
  Minus,
  MousePointer2,
  Move,
  Pentagon,
  Plus,
  QrCode,
  Redo2,
  Rocket,
  Route,
  Square,
  Undo2,
  UserRound,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { FURNITURE } from "../../lib/furniture";
import { localMapLink } from "../../lib/links";
import { fitTo, zoomIn, zoomOut } from "../../lib/mapView";
import { can, ROLE_LABELS } from "../../lib/permissions";
import { type DoorType, type LayerGroup, type SaveState, type Tool, useDraft } from "../../store";
import { MenuDivider, MenuItem, Popover } from "../Popover";
import { UserMenu } from "../UserMenu";

export const panel = "rounded-2xl bg-slate-900/95 text-white shadow-xl backdrop-blur";
const iconButton =
  "grid size-11 shrink-0 place-items-center rounded-xl text-white/90 hover:bg-white/10 disabled:opacity-35 [&>svg]:size-5";

export interface ToolDef {
  id: Tool;
  label: string;
  key: string;
  icon: ReactNode;
  hint: string;
  needs: "edit" | "capture";
}

export const TOOLS: ToolDef[] = [
  {
    id: "select",
    label: "Выбор",
    key: "V",
    icon: <MousePointer2 />,
    hint: "Клик — выбрать. Точки на стенах и угол меняют размер",
    needs: "capture",
  },
  {
    id: "rect",
    label: "Комната",
    key: "R",
    icon: <Square />,
    hint: "Два клика по углам. Двойной клик включает перемещение",
    needs: "edit",
  },
  {
    id: "room",
    label: "Контур",
    key: "P",
    icon: <Pentagon />,
    hint: "Помещение любой формы: клики по углам, замкнуть на первой точке",
    needs: "edit",
  },
  {
    id: "door",
    label: "Дверь",
    key: "D",
    icon: <DoorOpen />,
    hint: "Клик по стене — дверь встанет вдоль неё",
    needs: "edit",
  },
  {
    id: "stairs",
    label: "Лестница/лифт",
    key: "S",
    icon: <Footprints />,
    hint: "Клик — связь с этажом выше",
    needs: "edit",
  },
  {
    id: "poi",
    label: "Точка",
    key: "M",
    icon: <MapPin />,
    hint: "Клик — точка выбранной категории, можно ставить подряд",
    needs: "edit",
  },
  {
    id: "furniture",
    label: "Мебель",
    key: "F",
    icon: <Armchair />,
    hint: "Клик — стол, диван, стенд или растение. Двойной клик или двойное нажатие включает перемещение",
    needs: "edit",
  },
  {
    id: "move",
    label: "Перемещение",
    key: "G",
    icon: <Move />,
    hint: "Перетащите комнату, мебель, точку или панораму",
    needs: "edit",
  },
  {
    id: "path",
    label: "Дорожка",
    key: "W",
    icon: <Route />,
    hint: "Клики по изгибам дорожки, двойной клик — готово. Соединяет входы зданий через улицу",
    needs: "edit",
  },
  {
    id: "pano",
    label: "Панорама",
    key: "C",
    icon: <Camera />,
    hint: "Клик в месте съёмки — дальше QR для телефона",
    needs: "capture",
  },
];

const DOOR_TYPES: { id: DoorType; label: string }[] = [
  { id: "door", label: "Дверь 0,9 м" },
  { id: "double", label: "Двойная 1,6 м" },
  { id: "passage", label: "Проход 2 м" },
  { id: "entrance", label: "Вход в здание" },
  { id: "window", label: "Окно 1,2 м" },
];

const PUBLISH_BLOCKED: Record<Exclude<SaveState, "saved">, string> = {
  dirty: "изменения ещё сохраняются, подождите пару секунд",
  saving: "изменения ещё сохраняются, подождите пару секунд",
  offline: "нет интернета — изменения сохранятся, когда сеть вернётся",
  conflict: "карту изменили в другой вкладке или на другом устройстве — обновите страницу",
  error: "последнее сохранение не прошло — проверьте ошибку вверху и попробуйте ещё раз",
};

const SAVE: Record<SaveState, { label: string; icon: ReactNode; tone: string }> = {
  saved: { label: "Сохранено", icon: <Check />, tone: "text-emerald-300" },
  dirty: {
    label: "Изменения…",
    icon: <LoaderCircle className="animate-spin" />,
    tone: "text-white/70",
  },
  saving: {
    label: "Сохраняем…",
    icon: <LoaderCircle className="animate-spin" />,
    tone: "text-white/70",
  },
  offline: { label: "Нет сети — на устройстве", icon: <CloudOff />, tone: "text-amber-300" },
  conflict: { label: "Конфликт версий", icon: <CloudOff />, tone: "text-red-300" },
  error: { label: "Ошибка сохранения", icon: <CloudOff />, tone: "text-red-300" },
};

// --- top left: menu, title, level ----------------------------------------------------------

export function TopLeft({ map, onOpenHelp }: { map: MapSummary; onOpenHelp: () => void }) {
  const navigate = useNavigate();
  const doc = useDraft((s) => s.doc);
  const levelId = useDraft((s) => s.levelId);
  const { setLevel, addLevel, updateLevel } = useDraft.getState();
  const levels = sortedLevels(doc);
  const level = levels.find((l) => l.id === levelId);
  const editable = can(map, "edit");

  return (
    <div className="pointer-events-auto flex items-center gap-2">
      <Popover
        trigger={({ toggle, open }) => (
          <button
            type="button"
            aria-label="Меню"
            aria-expanded={open}
            onClick={toggle}
            className={cn(panel, iconButton)}
          >
            <Menu />
          </button>
        )}
      >
        {(close) => {
          const go = (to: string) => {
            close();
            void navigate({ to, params: { mapId: map.id } } as never);
          };
          return (
            <>
              <MenuItem icon={<MapIcon />} onClick={() => go("/")}>
                Мои карты
              </MenuItem>
              <MenuItem
                icon={<Plus />}
                onClick={() => void navigate({ to: "/", search: { create: true } } as never)}
              >
                Создать карту
              </MenuItem>
              <MenuDivider />
              <MenuItem
                icon={<QrCode />}
                disabled={!can(map, "share")}
                onClick={() => go("/maps/$mapId/share")}
              >
                Поделиться, QR-коды
              </MenuItem>
              <MenuItem icon={<Users />} onClick={() => go("/maps/$mapId/team")}>
                Команда и роли
              </MenuItem>
              <MenuItem icon={<ChartColumn />} onClick={() => go("/maps/$mapId/stats")}>
                Статистика посещений
              </MenuItem>
              <MenuItem
                icon={<Eye />}
                disabled={!map.publishedNumber}
                onClick={() => {
                  close();
                  window.open(localMapLink(map.slug), "_blank");
                }}
              >
                Открыть как посетитель
              </MenuItem>
              <MenuDivider />
              <MenuItem icon={<UserRound />} onClick={() => go("/profile")}>
                Профиль
              </MenuItem>
              <MenuItem
                icon={<CircleQuestionMark />}
                onClick={() => {
                  close();
                  onOpenHelp();
                }}
              >
                Подсказки и горячие клавиши
              </MenuItem>
            </>
          );
        }}
      </Popover>

      <div className={cn(panel, "flex h-11 min-w-0 items-center gap-2 px-4 max-sm:hidden")}>
        <span className="max-w-[28vw] truncate font-semibold lg:max-w-64">{map.title}</span>
        <span className="hidden whitespace-nowrap rounded-md bg-white/10 px-2 py-0.5 text-xs text-white/80 lg:inline">
          {ROLE_LABELS[map.role ?? "viewer"]}
        </span>
      </div>

      <Popover
        trigger={({ toggle, open }) => (
          <button
            type="button"
            aria-label="Этаж"
            aria-expanded={open}
            onClick={toggle}
            className={cn(
              panel,
              "flex h-11 items-center gap-1.5 whitespace-nowrap px-3 text-sm font-medium",
            )}
          >
            {level?.name ?? "Этаж"}
            <ChevronDown className="size-4 opacity-70" />
          </button>
        )}
      >
        {(close) => (
          <>
            {[...levels].reverse().map((l) => (
              <MenuItem
                key={l.id}
                icon={l.id === levelId ? <Check /> : <span className="inline-block size-4" />}
                onClick={() => {
                  setLevel(l.id);
                  close();
                }}
              >
                {l.name}
              </MenuItem>
            ))}
            {editable && (
              <>
                <MenuDivider />
                {level && (
                  <label className="block px-3 py-1 text-xs text-muted">
                    Название этажа
                    <input
                      className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-fg"
                      value={level.name}
                      onChange={(e) => updateLevel(level.id, { name: e.target.value })}
                    />
                  </label>
                )}
                <MenuItem
                  icon={<Plus />}
                  onClick={() => {
                    addLevel();
                    close();
                  }}
                >
                  Добавить этаж выше
                </MenuItem>
              </>
            )}
          </>
        )}
      </Popover>
    </div>
  );
}

// --- top right: save state, share, team, publish, account ---------------------------------

export function TopRight({
  map,
  onPublish,
  publishing,
}: {
  map: MapSummary;
  onPublish: () => void;
  publishing: boolean;
}) {
  const navigate = useNavigate();
  const saveState = useDraft((s) => s.saveState);
  const saveError = useDraft((s) => s.saveError);
  const save = SAVE[saveState];

  return (
    <div className="pointer-events-auto flex items-center gap-2">
      <div
        className={cn(
          panel,
          "hidden h-11 items-center gap-2 whitespace-nowrap px-3 text-sm xl:flex",
          save.tone,
        )}
        title={saveError ?? undefined}
        aria-live="polite"
      >
        <span className="[&>svg]:size-4">{save.icon}</span>
        {save.label}
      </div>
      <div className={cn(panel, "flex items-center p-0.5 max-md:hidden")}>
        <button
          type="button"
          title="Поделиться: ссылка и QR-коды"
          aria-label="Поделиться"
          disabled={!can(map, "share")}
          onClick={() => void navigate({ to: "/maps/$mapId/share", params: { mapId: map.id } })}
          className={iconButton}
        >
          <QrCode />
        </button>
        <button
          type="button"
          title="Команда и роли"
          aria-label="Команда"
          onClick={() => void navigate({ to: "/maps/$mapId/team", params: { mapId: map.id } })}
          className={iconButton}
        >
          <Users />
        </button>
        <button
          type="button"
          title={map.publishedNumber ? "Открыть опубликованную карту" : "Карта ещё не опубликована"}
          aria-label="Открыть как посетитель"
          disabled={!map.publishedNumber}
          onClick={() => window.open(localMapLink(map.slug), "_blank")}
          className={iconButton}
        >
          <Eye />
        </button>
      </div>
      {can(map, "publish") && (
        <button
          type="button"
          onClick={() => {
            // On a phone there is no tooltip: say why publishing has to wait instead of a dead button.
            if (saveState === "saved") return onPublish();
            useDraft.getState().setHint(`Опубликовать пока нельзя: ${PUBLISH_BLOCKED[saveState]}`);
          }}
          disabled={publishing}
          title={
            saveState !== "saved" ? PUBLISH_BLOCKED[saveState] : "Опубликовать: ссылка не меняется"
          }
          className={cn(
            "flex h-11 items-center gap-2 rounded-2xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-xl hover:bg-emerald-500 disabled:opacity-50",
            saveState !== "saved" && "opacity-50",
          )}
        >
          <Rocket className="size-4" />
          <span className="hidden lg:inline">{publishing ? "Публикуем…" : "Опубликовать"}</span>
        </button>
      )}
      <UserMenu />
    </div>
  );
}

// --- bottom centre: tools -----------------------------------------------------------------

function ToolButton({
  def,
  active,
  onClick,
  onDoubleClick,
}: {
  def: ToolDef;
  active: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={`${def.label} (${def.key}) — ${def.hint}`}
      aria-label={def.label}
      aria-pressed={active}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(iconButton, active && "bg-accent text-white hover:bg-accent")}
    >
      {def.icon}
    </button>
  );
}

function OptionMenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Popover
      side="top"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          aria-label={label}
          aria-expanded={open}
          onClick={toggle}
          className="-ml-1 grid h-11 w-7 place-items-center rounded-lg text-white/60 hover:bg-white/10"
        >
          <ChevronDown className="size-3.5" />
        </button>
      )}
    >
      {(close) => (
        <>
          <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted">{label}</p>
          {options.map((o) => (
            <MenuItem
              key={o.id}
              icon={o.id === value ? <Check /> : <span className="inline-block size-4" />}
              onClick={() => {
                onChange(o.id);
                close();
              }}
            >
              {o.label}
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
}

export function Toolbar({ map, onUploadPlan }: { map: MapSummary; onUploadPlan: () => void }) {
  const tool = useDraft((s) => s.tool);
  const doorType = useDraft((s) => s.doorType);
  const connectorKind = useDraft((s) => s.connectorKind);
  const poiCategory = useDraft((s) => s.poiCategory);
  const furniture = useDraft((s) => s.furniture);
  const snapping = useDraft((s) => s.snapping);
  const { setTool, setOptions } = useDraft.getState();
  const tools = TOOLS.filter((t) => can(map, t.needs));
  if (!can(map, "capture")) return null;

  const options: Partial<Record<Tool, ReactNode>> = {
    door: (
      <OptionMenu
        label="Тип прохода"
        value={doorType}
        options={DOOR_TYPES}
        onChange={(v) => {
          setOptions({ doorType: v });
          setTool("door");
        }}
      />
    ),
    stairs: (
      <OptionMenu
        label="Связь между этажами"
        value={connectorKind}
        options={Object.entries(CONNECTOR_LABELS).map(([id, label]) => ({
          id: id as typeof connectorKind,
          label,
        }))}
        onChange={(v) => {
          setOptions({ connectorKind: v });
          setTool("stairs");
        }}
      />
    ),
    poi: (
      <OptionMenu
        label="Категория точки"
        value={poiCategory}
        options={Object.entries(POI_CATEGORIES).map(([id, c]) => ({
          id,
          label: `${c.emoji} ${c.label}`,
        }))}
        onChange={(v) => {
          setOptions({ poiCategory: v });
          setTool("poi");
        }}
      />
    ),
    furniture: (
      <OptionMenu
        label="Что поставить"
        value={furniture}
        options={FURNITURE.map((p) => ({ id: p.id, label: p.label }))}
        onChange={(v) => {
          setOptions({ furniture: v });
          setTool("furniture");
        }}
      />
    ),
  };

  return (
    <div
      role="toolbar"
      aria-label="Инструменты"
      className={cn(
        panel,
        "pointer-events-auto flex max-w-full snap-x items-center overflow-x-auto p-1 [scrollbar-width:none]",
      )}
    >
      {tools.map((def) => (
        <div key={def.id} className="flex items-center">
          <ToolButton
            def={def}
            active={tool === def.id}
            onClick={() => setTool(def.id)}
            onDoubleClick={
              def.id === "furniture" || def.id === "rect" ? () => setTool("move") : undefined
            }
          />
          {options[def.id]}
        </div>
      ))}
      {can(map, "edit") && (
        <>
          <span className="mx-1 h-7 w-px bg-white/15" />
          <button
            type="button"
            title="Загрузить готовый план (картинка)"
            aria-label="Загрузить план"
            onClick={onUploadPlan}
            className={iconButton}
          >
            <ImagePlus />
          </button>
          <button
            type="button"
            title={snapping ? "Привязка к углам, стенам и сетке 0,5 м: вкл" : "Привязка выключена"}
            aria-label="Привязка"
            aria-pressed={snapping}
            onClick={() => setOptions({ snapping: !snapping })}
            className={cn(iconButton, snapping && "text-sky-300")}
          >
            <Magnet />
          </button>
        </>
      )}
    </div>
  );
}

// --- bottom left: layers; bottom right: history and zoom ------------------------------------

const LAYER_LABELS: { id: LayerGroup; label: string }[] = [
  { id: "underlay", label: "Подложка плана" },
  { id: "rooms", label: "Помещения" },
  { id: "doors", label: "Двери и проходы" },
  { id: "connectors", label: "Лестницы и лифты" },
  { id: "points", label: "Точки" },
  { id: "panos", label: "Панорамы" },
  { id: "labels", label: "Подписи" },
];

export function LayersButton() {
  const hidden = useDraft((s) => s.hiddenLayers);
  const { toggleLayer } = useDraft.getState();
  return (
    <Popover
      side="top"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          aria-label="Слои"
          aria-expanded={open}
          title="Слои"
          onClick={toggle}
          className={cn(panel, iconButton, "pointer-events-auto")}
        >
          <Layers />
        </button>
      )}
    >
      {() => (
        <>
          <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted">Показывать на плане</p>
          {LAYER_LABELS.map((l) => (
            <label
              key={l.id}
              className="flex min-h-10 items-center gap-3 rounded-xl px-3 text-sm hover:bg-surface"
            >
              <input
                type="checkbox"
                checked={!hidden.includes(l.id)}
                onChange={() => toggleLayer(l.id)}
              />
              {l.label}
            </label>
          ))}
        </>
      )}
    </Popover>
  );
}

export function HistoryAndHelp({ onOpenHelp }: { onOpenHelp: () => void }) {
  const { undo, redo, pastStates, futureStates } = useStore(useDraft.temporal);
  return (
    <div className="pointer-events-auto flex items-end gap-2">
      <div className={cn(panel, "flex p-0.5")}>
        <button
          type="button"
          aria-label="Отменить"
          title="Отменить (Ctrl+Z)"
          disabled={!pastStates.length}
          onClick={() => undo()}
          className={iconButton}
        >
          <Undo2 />
        </button>
        <button
          type="button"
          aria-label="Повторить"
          title="Повторить (Ctrl+Shift+Z)"
          disabled={!futureStates.length}
          onClick={() => redo()}
          className={iconButton}
        >
          <Redo2 />
        </button>
      </div>
      <button
        type="button"
        aria-label="Помощь"
        onClick={onOpenHelp}
        className={cn(panel, "flex h-11 items-center gap-2 px-3 text-sm")}
      >
        <span className="hidden lg:inline">Помощь</span>
        <CircleQuestionMark className="size-4" />
      </button>
    </div>
  );
}

/** Vertical zoom column on the right edge, above the bottom bar (as in map apps). */
export function ZoomControls() {
  const doc = useDraft((s) => s.doc);
  return (
    <div className={cn(panel, "pointer-events-auto flex flex-col p-0.5")}>
      <button
        type="button"
        aria-label="Весь план"
        title="Показать весь план"
        onClick={() => fitTo(bundleBounds(doc), doc.venue.anchor)}
        className={iconButton}
      >
        <Maximize2 />
      </button>
      <button type="button" aria-label="Приблизить" onClick={zoomIn} className={iconButton}>
        <Plus />
      </button>
      <button type="button" aria-label="Отдалить" onClick={zoomOut} className={iconButton}>
        <Minus />
      </button>
    </div>
  );
}

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stops the backdrop click */}
      <div
        className="max-h-[85dvh] w-full max-w-lg space-y-4 overflow-y-auto rounded-2xl bg-bg p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
      >
        <h2 id="help-title" className="text-xl font-semibold">
          Как быстро сделать карту
        </h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            Есть схема здания? Загрузите её кнопкой с картинкой на панели — она ляжет подложкой.
          </li>
          <li>
            «Комната» (R): два клика по углам. Углы прилипают к соседним комнатам — стены совпадут.
          </li>
          <li>
            «Дверь» (D): наведите на стену — появится жёлтая дверь, кликните. Тип — в стрелке рядом.
          </li>
          <li>«Лестница/лифт» (S): клик — связь с этажом выше (этаж добавится сам).</li>
          <li>
            «Точка» (M): выберите категорию и ставьте точки подряд, названия — в панели справа.
          </li>
          <li>«Панорама» (C): клик в месте съёмки, отсканируйте QR телефоном и снимайте.</li>
          <li>«Опубликовать» — посетители увидят карту по постоянной ссылке.</li>
        </ol>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          {TOOLS.map((t) => (
            <div key={t.id} className="flex justify-between">
              <span>{t.label}</span>
              <kbd className="text-muted">{t.key}</kbd>
            </div>
          ))}
          <div className="flex justify-between">
            <span>Удалить выбранное</span>
            <kbd className="text-muted">Delete</kbd>
          </div>
          <div className="flex justify-between">
            <span>Отмена / выйти из инструмента</span>
            <kbd className="text-muted">Esc</kbd>
          </div>
          <div className="flex justify-between">
            <span>Отменить / повторить</span>
            <kbd className="text-muted">Ctrl+Z / Ctrl+Shift+Z</kbd>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="h-11 w-full rounded-xl bg-accent font-medium text-accent-fg"
        >
          Понятно
        </button>
      </div>
    </div>
  );
}

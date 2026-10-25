import type { PanoramaOut } from "@ttkpr/api-client";
import {
  buildNavGraph,
  CONNECTOR_LABELS,
  findTourRoute,
  formatDistance,
  formatDuration,
  labelPoint,
  POI_CATEGORIES,
  plural,
  sortedLevels,
  UNIT_COLORS,
  unitSize,
} from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import {
  ChevronDown,
  ChevronUp,
  MousePointerClick,
  Plus,
  Route as RouteIcon,
  Wand2,
  X,
} from "lucide-react";
import { lazy, type ReactNode, Suspense, useMemo, useRef, useState } from "react";
import { detectRooms, placeRing } from "../lib/autoPlan";
import { mapLink } from "../lib/links";
import { cornersPlacement, placementCorners, viewCenter } from "../lib/mapView";
import { usePanoramaActions } from "../lib/panos";
import { scalePoint } from "../lib/scalePlan";
import { useDraft } from "../store";
import { CaptureQrDialog } from "./CaptureQrDialog";
import { ChatInbox } from "./ChatInbox";
import { LiveStatusField } from "./LiveStatusField";
import { PlanImportDialog } from "./PlanImportDialog";
import { RoomIconField } from "./RoomIconField";
import { RouteCheck } from "./RouteCheck";

const PanoPlacer = lazy(() => import("./PanoPlacer"));

const UNIT_CATEGORY_LABELS: Record<string, string> = {
  room: "Помещение",
  hall: "Зал",
  corridor: "Коридор",
  lobby: "Холл",
  restroom: "Туалет",
  stairs: "Лестница",
  elevator: "Лифт",
  outdoor: "Территория, улица",
  nonpublic: "Служебное",
};

const STATUS_LABELS: Record<string, string> = {
  uploading: "Загружаются кадры",
  processing: "Склеивается",
  ready: "Готова",
  failed: "Ошибка",
};

const field =
  "w-full rounded-xl border border-border bg-bg px-3 py-2 outline-none focus:border-accent";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

export function Inspector({
  panos,
  mapId,
  slug,
  canEdit,
}: {
  panos: PanoramaOut[];
  mapId: string;
  /** For tour links (/m/{slug}?tour=…). */
  slug: string;
  canEdit: boolean;
}) {
  const doc = useDraft((s) => s.doc);
  const selectedId = useDraft((s) => s.selectedId);
  const panoSpot = useDraft((s) => s.panoSpot);

  const unit = doc.units?.find((u) => u.id === selectedId);
  const poi = doc.pois?.find((p) => p.id === selectedId);
  const opening = doc.openings?.find((o) => o.id === selectedId);
  const underlay = doc.underlays?.find((u) => u.id === selectedId);
  const connector = doc.connectors?.find((c) => c.id === selectedId);
  const fixture = doc.fixtures?.find((f) => f.id === selectedId);
  const tour = doc.tours?.find((t) => t.id === selectedId);
  const path = doc.paths?.find((w) => w.id === selectedId);
  const pano = panos.find((p) => p.id === selectedId);

  let content: ReactNode;
  if (panoSpot) content = <PanoSpotPanel mapId={mapId} spot={panoSpot} />;
  else if (pano) content = <PanoPanel key={pano.id} mapId={mapId} pano={pano} canEdit={canEdit} />;
  else if (unit) content = <UnitPanel id={unit.id} mapId={mapId} panos={panos} />;
  else if (fixture) content = <FixturePanel id={fixture.id} />;
  else if (poi) content = <PoiPanel id={poi.id} mapId={mapId} />;
  else if (underlay) content = <UnderlayPanel id={underlay.id} />;
  else if (connector) content = <ConnectorPanel id={connector.id} />;
  else if (tour) content = <TourPanel id={tour.id} slug={slug} />;
  else if (path) {
    content = (
      <Section title="Дорожка">
        <p className="text-sm text-muted">{Math.round(lineLength(path.geometry.coordinates))} м</p>
        <DeleteButton id={path.id} />
      </Section>
    );
  } else if (opening) {
    content = (
      <Section title="Дверь / проход">
        <DeleteButton id={opening.id} />
      </Section>
    );
  } else content = <OverviewPanel panos={panos} mapId={mapId} canEdit={canEdit} />;

  // Roles without the edit right see the same panels, read-only (panoramas manage themselves).
  return (
    <fieldset disabled={!canEdit && !panoSpot && !pano} className="min-w-0 disabled:opacity-80">
      {content}
    </fieldset>
  );
}

function ConnectorPanel({ id }: { id: string }) {
  const doc = useDraft((s) => s.doc);
  const connector = doc.connectors?.find((c) => c.id === id);
  if (!connector) return null;
  const update = (patch: Partial<typeof connector>) =>
    useDraft.setState((s) => ({
      doc: {
        ...s.doc,
        connectors: s.doc.connectors?.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      },
    }));
  const levelName = (levelId: string) => doc.levels?.find((l) => l.id === levelId)?.name ?? levelId;
  return (
    <Section title="Лестница / лифт">
      <Field label="Название" htmlFor="connector-name">
        <input
          id="connector-name"
          className={field}
          value={connector.name ?? ""}
          onChange={(e) => update({ name: e.target.value })}
        />
      </Field>
      <Field label="Тип" htmlFor="connector-kind">
        <select
          id="connector-kind"
          className={field}
          value={connector.kind}
          onChange={(e) => update({ kind: e.target.value as typeof connector.kind })}
        >
          {Object.entries(CONNECTOR_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-sm text-muted">
        {connector.points.map((p) => levelName(p.levelId)).join(" ↔ ")}
      </p>
      <DeleteButton id={connector.id} />
    </Section>
  );
}

function DeleteButton({ id, duplicable = false }: { id: string; duplicable?: boolean }) {
  return (
    <div className="flex gap-2">
      {duplicable && (
        <Button
          variant="secondary"
          className="flex-1"
          title="Ctrl+D"
          onClick={() => useDraft.getState().duplicate(id)}
        >
          Дублировать
        </Button>
      )}
      <Button
        variant="secondary"
        className="flex-1 text-danger"
        onClick={() => useDraft.getState().remove(id)}
      >
        Удалить
      </Button>
    </div>
  );
}

function UnitPanel({ id, mapId, panos }: { id: string; mapId: string; panos: PanoramaOut[] }) {
  const unit = useDraft((s) => s.doc.units?.find((u) => u.id === id));
  const { updateUnit } = useDraft.getState();
  if (!unit) return null;
  return (
    <Section title="Помещение">
      <Field label="Название" htmlFor="unit-name">
        <input
          id="unit-name"
          className={field}
          value={unit.name ?? ""}
          onChange={(e) => updateUnit(unit.id, { name: e.target.value })}
        />
      </Field>
      <Field label="Тип" htmlFor="unit-category">
        <select
          id="unit-category"
          className={field}
          value={unit.category}
          onChange={(e) =>
            updateUnit(unit.id, { category: e.target.value as typeof unit.category })
          }
        >
          {Object.keys(UNIT_COLORS).map((key) => (
            <option key={key} value={key}>
              {UNIT_CATEGORY_LABELS[key] ?? key}
            </option>
          ))}
        </select>
      </Field>
      <RoomIconField unitId={unit.id} />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={unit.walkable ?? true}
          onChange={(e) => updateUnit(unit.id, { walkable: e.target.checked })}
        />
        Можно пройти (участвует в маршрутах)
      </label>
      <RoomSize unitId={unit.id} mapId={mapId} panos={panos} />
      <DeleteButton id={unit.id} duplicable />
    </Section>
  );
}

/**
 * Size of the room as drawn, and "real width": typing the measured width rescales the whole
 * plan (rooms, doors, places, furniture, plan images and panoramas), so route times are right.
 */
function RoomSize({
  unitId,
  mapId,
  panos,
}: {
  unitId: string;
  mapId: string;
  panos: PanoramaOut[];
}) {
  const doc = useDraft((s) => s.doc);
  const unit = doc.units?.find((u) => u.id === unitId);
  const actions = usePanoramaActions(mapId);
  const [real, setReal] = useState("");
  const size = unit ? unitSize(doc, unit) : null;
  if (!unit || !size) return null;
  const wanted = Number(real.replace(",", "."));
  const factor = wanted > 0 ? wanted / size.widthM : 0;
  const apply = () => {
    if (!factor || Math.abs(factor - 1) < 0.001) return;
    const center = (labelPoint(doc, unit.geometry.coordinates as [number, number][][]) ??
      doc.venue.anchor) as [number, number];
    useDraft.getState().scalePlan(factor, center);
    for (const p of panos) {
      const position = scalePoint(doc.venue.anchor, p.position, factor, center);
      actions.update.mutate({ id: p.id, patch: { position } });
    }
    setReal("");
  };
  return (
    <div className="space-y-2 rounded-xl bg-surface p-3 text-sm">
      <p>
        Размер: <b>{size.widthM.toFixed(1)}</b> × <b>{size.depthM.toFixed(1)}</b> м,{" "}
        {Math.round(size.areaM2)} м²
      </p>
      <label className="flex flex-wrap items-center gap-2">
        Реальная длина, м
        <input
          type="number"
          inputMode="decimal"
          min={0.5}
          step={0.1}
          className={`${field} w-24`}
          placeholder={size.widthM.toFixed(1)}
          value={real}
          onChange={(e) => setReal(e.target.value)}
        />
      </label>
      {factor > 0 && Math.abs(factor - 1) >= 0.001 && (
        <Button variant="secondary" className="w-full" onClick={apply}>
          Пересчитать масштаб всего плана ×{factor.toFixed(2)}
        </Button>
      )}
      <p className="text-xs text-muted">
        Время маршрута неверное? Введите реальную длину комнаты — план пересчитается.
      </p>
    </div>
  );
}

function FixturePanel({ id }: { id: string }) {
  const fixture = useDraft((s) => s.doc.fixtures?.find((f) => f.id === id));
  const { updateFixture } = useDraft.getState();
  if (!fixture) return null;
  return (
    <Section title="Мебель">
      <Field label="Название" htmlFor="fixture-name">
        <input
          id="fixture-name"
          className={field}
          value={fixture.name ?? ""}
          placeholder="Без подписи на плане"
          onChange={(e) => updateFixture(fixture.id, { name: e.target.value || null })}
        />
      </Field>
      <p className="text-xs text-muted">
        {fixture.obstacle === false ? "Не мешает проходу" : "Маршруты обходят"}
      </p>
      <DeleteButton id={fixture.id} duplicable />
    </Section>
  );
}

function PoiPanel({ id, mapId }: { id: string; mapId: string }) {
  const poi = useDraft((s) => s.doc.pois?.find((p) => p.id === id));
  const { updatePoi } = useDraft.getState();
  if (!poi) return null;
  return (
    <Section title="Точка интереса">
      <Field label="Название" htmlFor="poi-name">
        <input
          id="poi-name"
          className={field}
          value={poi.name}
          onChange={(e) => updatePoi(poi.id, { name: e.target.value })}
        />
      </Field>
      <Field label="Категория" htmlFor="poi-category">
        <select
          id="poi-category"
          className={field}
          value={poi.category}
          onChange={(e) => updatePoi(poi.id, { category: e.target.value })}
        >
          {Object.entries(POI_CATEGORIES).map(([key, { label }]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Описание" htmlFor="poi-description">
        <textarea
          id="poi-description"
          className={`${field} min-h-24`}
          value={poi.description ?? ""}
          onChange={(e) => updatePoi(poi.id, { description: e.target.value })}
        />
      </Field>
      <LiveStatusField mapId={mapId} poiId={poi.id} />
      <DeleteButton id={poi.id} duplicable />
    </Section>
  );
}

function UnderlayPanel({ id }: { id: string }) {
  const doc = useDraft((s) => s.doc);
  const underlay = doc.underlays?.find((u) => u.id === id);
  const { updateUnderlay } = useDraft.getState();
  if (!underlay) return null;
  const anchor = doc.venue.anchor;
  const placement = cornersPlacement(anchor, underlay.coordinates);
  const place = (patch: Partial<typeof placement>) =>
    updateUnderlay(id, { coordinates: placementCorners(anchor, { ...placement, ...patch }) });

  return (
    <Section title="Подложка плана">
      <p className="text-sm text-muted">
        Совместите картинку с планом: подвиньте карту, нажмите «Сюда», подгоните ширину и поворот,
        затем обведите помещения инструментами сверху.
      </p>
      <Field
        label={`Прозрачность: ${Math.round((underlay.opacity ?? 0.6) * 100)}%`}
        htmlFor="ul-opacity"
      >
        <input
          id="ul-opacity"
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={underlay.opacity ?? 0.6}
          onChange={(e) => updateUnderlay(id, { opacity: Number(e.target.value) })}
          className="w-full"
        />
      </Field>
      <Field label="Ширина здания на плане, м" htmlFor="ul-width">
        <input
          id="ul-width"
          type="number"
          min={1}
          step={0.5}
          className={field}
          value={placement.widthM.toFixed(1)}
          onChange={(e) => {
            const widthM = Number(e.target.value);
            if (widthM > 0) {
              place({ widthM, heightM: (placement.heightM * widthM) / placement.widthM });
            }
          }}
        />
      </Field>
      <Field label={`Поворот: ${Math.round(placement.rotationDeg)}°`} htmlFor="ul-rotation">
        <input
          id="ul-rotation"
          type="range"
          min={-180}
          max={180}
          step={0.5}
          value={placement.rotationDeg}
          onChange={(e) => place({ rotationDeg: Number(e.target.value) })}
          className="w-full"
        />
      </Field>
      <Button
        variant="secondary"
        className="w-full"
        onClick={() => {
          const center = viewCenter();
          if (center) place({ center });
        }}
      >
        Сюда (в центр экрана)
      </Button>
      <AutoRooms underlayId={id} />
      <DeleteButton id={id} />
    </Section>
  );
}

/** "Распознать комнаты": room outlines from the plan image, added as one undoable step. */
function AutoRooms({ underlayId }: { underlayId: string }) {
  const [state, setState] = useState<{ busy: boolean; message: string | null }>({
    busy: false,
    message: null,
  });
  const run = async () => {
    const { doc, addUnits } = useDraft.getState();
    const underlay = doc.underlays?.find((u) => u.id === underlayId);
    if (!underlay) return;
    setState({ busy: true, message: null });
    try {
      const rooms = await detectRooms(underlay.url);
      const rings = rooms.map((room) => placeRing(room.ring, underlay.coordinates));
      addUnits(rings);
      setState({
        busy: false,
        message: rings.length
          ? `Добавлено: ${plural(rings.length, ["помещение", "помещения", "помещений"])}. Проверьте контуры, назовите комнаты и поставьте двери.`
          : "Замкнутых помещений не нашлось: нужен чёткий план с тёмными стенами.",
      });
    } catch {
      setState({ busy: false, message: "Не удалось прочитать картинку плана" });
    }
  };
  return (
    <div className="space-y-2 rounded-xl border border-dashed border-border p-3">
      <Button className="w-full" disabled={state.busy} onClick={() => void run()}>
        <Wand2 className="size-4" aria-hidden />
        {state.busy ? "Распознаём…" : "Распознать комнаты по плану"}
      </Button>
      <p className="text-xs text-muted">
        {state.message ??
          "Тёмные линии станут стенами, замкнутые области — помещениями. Сначала совместите подложку с картой. Отменить — Ctrl+Z."}
      </p>
    </div>
  );
}

function PanoPanel({
  mapId,
  pano,
  canEdit,
}: {
  mapId: string;
  pano: PanoramaOut;
  canEdit: boolean;
}) {
  const actions = usePanoramaActions(mapId);
  const [heading, setHeading] = useState(pano.headingDeg);
  const moving = useDraft((s) => s.movingPanoId === pano.id);
  const preview = pano.tiles?.previewUrl;
  const [placing, setPlacing] = useState(false);
  const saveHeading = () => actions.update.mutate({ id: pano.id, patch: { headingDeg: heading } });

  return (
    <Section title="Панорама">
      <p className="text-sm">
        {STATUS_LABELS[pano.status] ?? pano.status}
        {(pano.status === "processing" || pano.status === "uploading") && ` · ${pano.progress}%`}
      </p>
      {pano.error && (
        <p className="rounded-xl bg-red-50 dark:bg-red-950/60 p-3 text-sm text-danger">
          {pano.error}
        </p>
      )}
      {preview && <img src={preview} alt="Превью панорамы" className="w-full rounded-xl" />}
      {canEdit && pano.status === "ready" && pano.tiles && (
        <Button className="w-full" onClick={() => setPlacing(true)}>
          <MousePointerClick className="size-4" aria-hidden />
          Поставить точки в панораме
        </Button>
      )}
      {placing && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-black" />}>
          <PanoPlacer pano={pano} onClose={() => setPlacing(false)} />
        </Suspense>
      )}
      {pano.quality && (
        <p className="text-xs text-muted">
          Кадров: {String(pano.quality.frames)} · совпадений: {String(pano.quality.matches)} ·
          только по гироскопу: {String(pano.quality.framesOnSensorsOnly)} · ошибка склейки:{" "}
          {String(pano.quality.rmsPx)} px
        </p>
      )}
      {canEdit && (
        <>
          <Field label={`Направление (север = 0°): ${Math.round(heading)}°`} htmlFor="pano-heading">
            <input
              id="pano-heading"
              type="range"
              min={0}
              max={359}
              value={heading}
              onChange={(e) => setHeading(Number(e.target.value))}
              onPointerUp={saveHeading}
              onKeyUp={saveHeading}
              className="w-full"
            />
          </Field>
          <p className="text-xs text-muted">
            Поверните так, чтобы точки внутри панорамы стояли там же, где на плане.
          </p>
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => useDraft.getState().setMovingPano(moving ? null : pano.id)}
          >
            {moving ? "Кликните по плану…" : "Переместить на плане"}
          </Button>
          <Button
            variant="secondary"
            className="w-full text-danger"
            onClick={() => {
              actions.remove.mutate(pano.id);
              useDraft.getState().select(null);
            }}
          >
            Удалить панораму
          </Button>
        </>
      )}
    </Section>
  );
}

function PanoSpotPanel({ mapId, spot }: { mapId: string; spot: [number, number] }) {
  const levelId = useDraft((s) => s.levelId);
  const actions = usePanoramaActions(mapId);
  const [qr, setQr] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <Section title="Новая панорама">
      <Button className="w-full" onClick={() => setQr(true)}>
        Снять с телефона
      </Button>
      <Button variant="secondary" className="w-full" onClick={() => fileRef.current?.click()}>
        Загрузить готовую 360° (2:1)
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          actions.upload.mutate(
            { file, levelId, position: spot },
            { onSuccess: (pano) => useDraft.getState().select(pano.id) },
          );
        }}
      />
      {actions.upload.isPending && <p className="text-sm text-muted">Загружаем…</p>}
      {actions.upload.error && (
        <p className="text-sm text-danger">{actions.upload.error.message}</p>
      )}
      <Button
        variant="ghost"
        className="w-full"
        onClick={() => useDraft.getState().setPanoSpot(null)}
      >
        Отмена
      </Button>
      {qr && (
        <CaptureQrDialog
          mapId={mapId}
          levelId={levelId}
          position={spot}
          onClose={() => {
            setQr(false);
            useDraft.getState().setPanoSpot(null);
            void actions.refresh();
          }}
        />
      )}
    </Section>
  );
}

function OverviewPanel({
  panos,
  mapId,
  canEdit,
}: {
  panos: PanoramaOut[];
  mapId: string;
  canEdit: boolean;
}) {
  const [importing, setImporting] = useState(false);
  const doc = useDraft((s) => s.doc);
  const levelId = useDraft((s) => s.levelId);
  const { select } = useDraft.getState();
  const on = <T extends { levelId: string }>(items: T[] | undefined) =>
    (items ?? []).filter((i) => i.levelId === levelId);
  const underlays = on(doc.underlays);
  const level = sortedLevels(doc).find((l) => l.id === levelId);

  return (
    <div className="space-y-6">
      <Section title={level?.name ?? "Этаж"}>
        <ul className="grid grid-cols-2 gap-2 text-sm">
          <li className="rounded-xl bg-surface p-3">
            {plural(on(doc.units).length, ["помещение", "помещения", "помещений"])}
          </li>
          <li className="rounded-xl bg-surface p-3">
            {plural(on(doc.openings).length, ["дверь", "двери", "дверей"])}
          </li>
          <li className="rounded-xl bg-surface p-3">
            {plural(on(doc.pois).length, ["точка", "точки", "точек"])}
          </li>
          <li className="rounded-xl bg-surface p-3">
            {plural(on(panos).length, ["панорама", "панорамы", "панорам"])}
          </li>
        </ul>
      </Section>

      <Section title="Вопросы гостей">
        <ChatInbox mapId={mapId} canReply={canEdit} />
      </Section>

      <Section title="Маршруты">
        <RouteCheck />
      </Section>

      <ToursSection />

      {underlays.length > 0 && (
        <Section title="Подложка">
          {underlays.map((u, i) => (
            <Button key={u.id} variant="secondary" className="w-full" onClick={() => select(u.id)}>
              Настроить план {underlays.length > 1 ? i + 1 : ""}
            </Button>
          ))}
        </Section>
      )}

      <Section title="Быстрый старт">
        <Button className="w-full" onClick={() => setImporting(true)}>
          <Wand2 className="size-4" aria-hidden />
          Распознать план из файла
        </Button>
        {importing && <PlanImportDialog mapId={mapId} onClose={() => setImporting(false)} />}
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>
            «Распознать план из файла»: PDF или картинка — помещения, двери, лестницы и этажи
            появятся сами. Или загрузите схему подложкой и рисуйте поверх.
          </li>
          <li>«Комната» (3): два клика по углам — следующая прилипнет к соседней.</li>
          <li>«Дверь» (5): наведите на стену и кликните.</li>
          <li>«Точка» (7): выберите категорию в стрелке и расставляйте подряд.</li>
          <li>«Дорожка» (9): соедините входы зданий через двор или улицу.</li>
          <li>«Панорама» (0): клик в месте съёмки → QR для телефона.</li>
          <li>«Маршруты для гостей»: экскурсия по точкам со ссылкой и QR.</li>
          <li>Нажмите «Опубликовать».</li>
        </ol>
      </Section>
    </div>
  );
}

function lineLength(coordinates: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const [lon1, lat1] = coordinates[i - 1] as [number, number];
    const [lon2, lat2] = coordinates[i] as [number, number];
    const k = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
    total += Math.hypot((lon2 - lon1) * k, lat2 - lat1) * 111_320;
  }
  return total;
}

const NO_TOURS: never[] = [];
const NO_STOPS: string[] = [];

/** Organizer's routes in the overview: excursions, stand tours, the way from the entrance. */
function ToursSection() {
  // Select the array itself: `?? []` inside the selector would be a new value on every read.
  const tours = useDraft((s) => s.doc.tours) ?? NO_TOURS;
  const { addTour, select } = useDraft.getState();
  return (
    <Section title="Маршруты для гостей">
      {tours.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border text-sm">
          {tours.map((tour) => (
            <li key={tour.id}>
              <button
                type="button"
                onClick={() => select(tour.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface"
              >
                <RouteIcon className="size-4 shrink-0 text-accent" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">{tour.name}</span>
                <span className="shrink-0 text-muted">
                  {plural(tour.stops?.length ?? 0, ["точка", "точки", "точек"])}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="secondary" className="w-full" onClick={addTour}>
        <Plus className="size-4" aria-hidden />
        Новый маршрут
      </Button>
    </Section>
  );
}

function TourPanel({ id, slug }: { id: string; slug: string }) {
  const doc = useDraft((s) => s.doc);
  const editing = useDraft((s) => s.editingTourId === id);
  const { updateTour, moveTourStop, removeTourStop, setEditingTour } = useDraft.getState();
  const [copied, setCopied] = useState(false);
  const tour = doc.tours?.find((t) => t.id === id);
  const stops = tour?.stops ?? NO_STOPS;
  // Same computation as the viewer, on the draft: what guests will get after publishing.
  const route = useMemo(
    () =>
      tour && stops.length >= 2
        ? findTourRoute(buildNavGraph(doc), doc, stops, { avoidStairs: tour.avoidStairs })
        : null,
    [doc, tour, stops],
  );
  if (!tour) return null;
  // A point may be visited twice: key = id + how many times it came before.
  const stopKeys = stops.map(
    (poiId, i) => `${poiId}:${stops.slice(0, i).filter((s) => s === poiId).length}`,
  );
  const poiName = (poiId: string) =>
    doc.pois?.find((p) => p.id === poiId)?.name ?? "Удалённая точка";
  const link = `${mapLink(slug)}?tour=${encodeURIComponent(tour.id)}`;

  return (
    <Section title="Маршрут для гостей">
      <Field label="Название" htmlFor="tour-name">
        <input
          id="tour-name"
          className={field}
          value={tour.name}
          maxLength={120}
          onChange={(e) => updateTour(tour.id, { name: e.target.value })}
        />
      </Field>
      <Field label="Описание" htmlFor="tour-description">
        <textarea
          id="tour-description"
          className={`${field} h-20 py-2`}
          value={tour.description ?? ""}
          maxLength={1000}
          placeholder="Что гости увидят по пути"
          onChange={(e) => updateTour(tour.id, { description: e.target.value || null })}
        />
      </Field>

      <div className="space-y-2">
        <p className="text-sm text-muted">Остановки по порядку</p>
        {stops.length === 0 && (
          <p className="rounded-xl bg-surface p-3 text-sm text-muted">
            Нажмите «Добавлять точки» и кликайте по точкам на плане.
          </p>
        )}
        <ol className="space-y-1">
          {stops.map((poiId, i) => (
            <li
              key={stopKeys[i]}
              className="flex items-center gap-2 rounded-xl bg-surface px-2 py-1 text-sm"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-fg">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{poiName(poiId)}</span>
              <button
                type="button"
                aria-label="Выше"
                disabled={i === 0}
                onClick={() => moveTourStop(tour.id, i, -1)}
                className="grid size-8 place-items-center rounded-lg hover:bg-bg disabled:opacity-30"
              >
                <ChevronUp className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Ниже"
                disabled={i === stops.length - 1}
                onClick={() => moveTourStop(tour.id, i, 1)}
                className="grid size-8 place-items-center rounded-lg hover:bg-bg disabled:opacity-30"
              >
                <ChevronDown className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Убрать остановку"
                onClick={() => removeTourStop(tour.id, i)}
                className="grid size-8 place-items-center rounded-lg text-danger hover:bg-bg"
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ol>
        <Button
          variant={editing ? "primary" : "secondary"}
          className="w-full"
          aria-pressed={editing}
          onClick={() => setEditingTour(editing ? null : tour.id)}
        >
          <MousePointerClick className="size-4" aria-hidden />
          {editing ? "Готово" : "Добавлять точки кликом на плане"}
        </Button>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={tour.avoidStairs ?? false}
          onChange={(e) => updateTour(tour.id, { avoidStairs: e.target.checked })}
        />
        Без ступенек (лифты и пандусы)
      </label>

      {stops.length >= 2 && (
        <p
          className={
            route
              ? "rounded-xl bg-green-50 p-3 text-sm text-green-900 dark:bg-green-950 dark:text-green-200"
              : "rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
          }
        >
          {route
            ? `${formatDistance(route.distanceM)} · ${formatDuration(route.durationS)} пешком`
            : "Между некоторыми точками нет прохода: проверьте двери и лестницы"}
        </p>
      )}

      <div className="space-y-2">
        <p className="text-sm text-muted">Ссылка для гостей (после публикации)</p>
        <div className="flex gap-2">
          <input
            readOnly
            value={link}
            aria-label="Ссылка на маршрут"
            className={`${field} min-w-0 flex-1 text-xs`}
          />
          <Button
            variant="secondary"
            onClick={() =>
              void navigator.clipboard.writeText(link).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? "Есть" : "Копия"}
          </Button>
        </div>
      </div>
      <DeleteButton id={tour.id} />
    </Section>
  );
}

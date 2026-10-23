import type { PanoramaOut } from "@ttkpr/api-client";
import {
  CONNECTOR_LABELS,
  POI_CATEGORIES,
  plural,
  sortedLevels,
  UNIT_COLORS,
} from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { type ReactNode, useRef, useState } from "react";
import { cornersPlacement, placementCorners, viewCenter } from "../lib/mapView";
import { usePanoramaActions } from "../lib/panos";
import { useDraft } from "../store";
import { CaptureQrDialog } from "./CaptureQrDialog";
import { RouteCheck } from "./RouteCheck";

const UNIT_CATEGORY_LABELS: Record<string, string> = {
  room: "Помещение",
  hall: "Зал",
  corridor: "Коридор",
  lobby: "Холл",
  restroom: "Туалет",
  stairs: "Лестница",
  elevator: "Лифт",
  outdoor: "Улица",
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
  canEdit,
}: {
  panos: PanoramaOut[];
  mapId: string;
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
  const pano = panos.find((p) => p.id === selectedId);

  let content: ReactNode;
  if (panoSpot) content = <PanoSpotPanel mapId={mapId} spot={panoSpot} />;
  else if (pano) content = <PanoPanel key={pano.id} mapId={mapId} pano={pano} canEdit={canEdit} />;
  else if (unit) content = <UnitPanel id={unit.id} />;
  else if (poi) content = <PoiPanel id={poi.id} />;
  else if (underlay) content = <UnderlayPanel id={underlay.id} />;
  else if (connector) content = <ConnectorPanel id={connector.id} />;
  else if (opening) {
    content = (
      <Section title="Дверь / проход">
        <p className="text-sm text-muted">
          {opening.category === "entrance" ? "Вход в здание" : "Соединяет соседние помещения"} — по
          ней пройдут маршруты.
        </p>
        <DeleteButton id={opening.id} />
      </Section>
    );
  } else content = <OverviewPanel panos={panos} />;

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
        Соединяет: {connector.points.map((p) => levelName(p.levelId)).join(" ↔ ")}. Для маршрутов
        «без ступенек» используются только лифты и пандусы.
      </p>
      <DeleteButton id={connector.id} />
    </Section>
  );
}

function DeleteButton({ id }: { id: string }) {
  return (
    <Button
      variant="secondary"
      className="w-full text-danger"
      onClick={() => useDraft.getState().remove(id)}
    >
      Удалить
    </Button>
  );
}

function UnitPanel({ id }: { id: string }) {
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
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={unit.walkable ?? true}
          onChange={(e) => updateUnit(unit.id, { walkable: e.target.checked })}
        />
        Можно пройти (участвует в маршрутах)
      </label>
      <DeleteButton id={unit.id} />
    </Section>
  );
}

function PoiPanel({ id }: { id: string }) {
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
          {Object.entries(POI_CATEGORIES).map(([key, { emoji, label }]) => (
            <option key={key} value={key}>
              {emoji} {label}
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
      <DeleteButton id={poi.id} />
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
      <DeleteButton id={id} />
    </Section>
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
  const saveHeading = () => actions.update.mutate({ id: pano.id, patch: { headingDeg: heading } });

  return (
    <Section title="Панорама">
      <p className="text-sm">
        {STATUS_LABELS[pano.status] ?? pano.status}
        {(pano.status === "processing" || pano.status === "uploading") && ` · ${pano.progress}%`}
      </p>
      {pano.error && <p className="rounded-xl bg-red-50 p-3 text-sm text-danger">{pano.error}</p>}
      {preview && <img src={preview} alt="Превью панорамы" className="w-full rounded-xl" />}
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
      <p className="text-sm text-muted">Точка съёмки отмечена на плане. Как получить панораму?</p>
      <Button className="w-full" onClick={() => setQr(true)}>
        📱 Снять с телефона
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

function OverviewPanel({ panos }: { panos: PanoramaOut[] }) {
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

      <Section title="Маршруты">
        <RouteCheck />
      </Section>

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
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>Загрузите схему здания (кнопка с картинкой) или рисуйте с нуля.</li>
          <li>«Комната»: два клика по углам — следующая прилипнет к соседней.</li>
          <li>«Дверь»: наведите на стену и кликните.</li>
          <li>«Точка»: выберите категорию в стрелке и расставляйте подряд.</li>
          <li>«Панорама»: клик в месте съёмки → QR для телефона.</li>
          <li>Нажмите «Опубликовать».</li>
        </ol>
      </Section>
    </div>
  );
}

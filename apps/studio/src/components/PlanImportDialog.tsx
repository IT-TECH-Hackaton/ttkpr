import { UNIT_COLORS } from "@ttkpr/map-core";
import { Button, cn } from "@ttkpr/ui";
import { FileUp } from "lucide-react";
import { useId, useState } from "react";
import { fitTo, viewCenter } from "../lib/mapView";
import {
  applyRecognizedPlan,
  planCounts,
  planResult,
  type RecognizedPage,
  suggestedWidthM,
  usePlanImport,
} from "../lib/planImport";
import { useDraft } from "../store";

const OPENING_COLORS = {
  door: "#dc2626",
  passage: "#dc2626",
  entrance: "#16a34a",
  window: "#0891b2",
};

/**
 * "Распознать план": upload a plan (image, or a PDF with a floor per page), preview what the
 * worker found on every floor, set the building width and add it all as one undoable step.
 */
export function PlanImportDialog({ mapId, onClose }: { mapId: string; onClose: () => void }) {
  const titleId = useId();
  const { start, job, error } = usePlanImport(mapId);
  const plan = planResult(job);
  const [page, setPage] = useState(0);
  const [width, setWidth] = useState<string>("");
  const widthM = Number(width.replace(",", ".")) || (plan ? suggestedWidthM(plan) : 0);
  const counts = plan ? planCounts(plan) : null;
  const shown = plan?.pages[page];

  const apply = () => {
    if (!plan) return;
    const { doc, replaceDoc } = useDraft.getState();
    const center = viewCenter() ?? doc.venue.anchor;
    const next = applyRecognizedPlan(doc, plan, { center, widthM });
    replaceDoc(next.doc, next.levelIds[0] ?? useDraft.getState().levelId);
    const first = next.doc.underlays?.at(-plan.pages.length);
    if (first) {
      const lons = first.coordinates.map((c) => c[0]);
      const lats = first.coordinates.map((c) => c[1]);
      fitTo(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        center,
      );
    }
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-3 sm:p-4"
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-2xl bg-bg p-4 shadow-2xl sm:p-5">
        <div className="space-y-1">
          <h2 id={titleId} className="text-lg font-semibold">
            Распознать план здания
          </h2>
          <p className="text-sm text-muted">PDF (страница — этаж) или картинка</p>
        </div>

        {!job && (
          <label
            className={cn(
              "grid cursor-pointer place-items-center gap-2 rounded-2xl border-2 border-dashed border-border p-8 text-center",
              start.isPending && "opacity-60",
            )}
          >
            <FileUp className="size-8 text-muted" aria-hidden />
            <span className="font-medium">
              {start.isPending ? "Загружаем…" : "Выберите файл плана"}
            </span>
            <span className="text-xs text-muted">PDF, JPEG, PNG или WebP, до 25 МБ</span>
            <input
              type="file"
              className="sr-only"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              disabled={start.isPending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) start.mutate(file);
              }}
            />
          </label>
        )}

        {job?.status === "processing" && (
          <div className="space-y-2" aria-live="polite">
            <p className="text-sm">Распознаём план… {job.progress}%</p>
            <div className="h-2 overflow-hidden rounded-full bg-surface">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${job.progress}%` }}
              />
            </div>
          </div>
        )}

        {(job?.status === "failed" || error) && (
          <p className="rounded-xl bg-red-100 p-3 text-sm text-red-900 dark:bg-red-950/60 dark:text-red-200">
            {job?.error ?? (error instanceof Error ? error.message : "Не удалось распознать план")}
          </p>
        )}

        {plan && counts && shown && (
          <>
            <p className="text-sm">
              Этажей: {counts.floors} · помещений: {counts.rooms} · дверей: {counts.doors} · окон:{" "}
              {counts.windows} · лестниц и лифтов: {counts.stairs}
            </p>
            {plan.warnings.map((w) => (
              <p key={w} className="text-xs text-amber-700 dark:text-amber-300">
                {w}
              </p>
            ))}
            {plan.pages.length > 1 && (
              <div className="flex flex-wrap gap-2" role="tablist">
                {plan.pages.map((p, i) => (
                  <Button
                    key={p.sourcePage}
                    role="tab"
                    aria-selected={i === page}
                    variant={i === page ? "primary" : "secondary"}
                    onClick={() => setPage(i)}
                  >
                    {p.floor ?? i + 1} этаж
                  </Button>
                ))}
              </div>
            )}
            <PagePreview page={shown} />
            <label className="flex flex-wrap items-center gap-2 text-sm">
              Ширина здания по плану, м
              <input
                type="number"
                inputMode="decimal"
                min={3}
                max={2000}
                className="w-28 rounded-lg border border-border bg-bg px-2 py-1"
                placeholder={String(suggestedWidthM(plan))}
                value={width}
                onChange={(e) => setWidth(e.target.value)}
              />
              <span className="text-xs text-muted">
                {plan.metersPerPixel ? "оценили по ширине дверей" : "не определилась — укажите"}
              </span>
            </label>
          </>
        )}

        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            {plan ? "Отмена" : "Закрыть"}
          </Button>
          {plan && (
            <Button className="flex-1" disabled={!counts?.rooms || widthM <= 0} onClick={apply}>
              Добавить на план
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function PagePreview({ page }: { page: RecognizedPage }) {
  const { width: w, height: h } = page;
  const font = Math.max(w, h) * 0.014;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="max-h-[55vh] w-full rounded-xl border border-border bg-white"
      role="img"
      aria-label="Найденные помещения и двери поверх плана"
    >
      <image href={page.imageUrl} width={w} height={h} opacity={0.55} />
      {page.rooms.map((room, i) => (
        <polygon
          // biome-ignore lint/suspicious/noArrayIndexKey: rooms have no ids before they are added
          key={i}
          points={room.ring.map(([x, y]) => `${x * w},${y * h}`).join(" ")}
          fill={UNIT_COLORS[room.category] ?? "#e8eef7"}
          fillOpacity={0.7}
          stroke="#2563eb"
          strokeWidth={Math.max(w, h) * 0.0015}
        />
      ))}
      {page.openings.map((o, i) => (
        <line
          // biome-ignore lint/suspicious/noArrayIndexKey: openings have no ids before they are added
          key={i}
          x1={o.a[0] * w}
          y1={o.a[1] * h}
          x2={o.b[0] * w}
          y2={o.b[1] * h}
          stroke={OPENING_COLORS[o.category]}
          strokeWidth={Math.max(w, h) * 0.005}
          strokeLinecap="round"
        />
      ))}
      {page.rooms.map((room, i) => {
        const label =
          room.category === "stairs"
            ? "Лестница"
            : room.category === "elevator"
              ? "Лифт"
              : room.name;
        return label ? (
          <text
            // biome-ignore lint/suspicious/noArrayIndexKey: rooms have no ids before they are added
            key={i}
            x={room.center[0] * w}
            y={room.center[1] * h}
            fontSize={font}
            textAnchor="middle"
            fill="#1e3a8a"
            stroke="#ffffff"
            strokeWidth={font * 0.25}
            paintOrder="stroke"
          >
            {label}
          </text>
        ) : null;
      })}
    </svg>
  );
}

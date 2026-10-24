import { UNIT_COLORS } from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { useId } from "react";

const DOTS = [
  { color: "#2563eb", label: "Место: стенд, кафе, регистрация — нажмите, чтобы открыть" },
  { color: "#7c3aed", label: "Лестница или лифт — переход на другой этаж" },
  { color: "#16a34a", label: "«Вы здесь» и начало маршрута" },
  { color: "#dc2626", label: "Конец маршрута" },
];

const AREAS = [
  { color: UNIT_COLORS.hall, label: "Зал" },
  { color: UNIT_COLORS.room, label: "Помещение" },
  { color: UNIT_COLORS.corridor, label: "Коридор" },
  { color: UNIT_COLORS.lobby, label: "Холл, вход" },
  { color: UNIT_COLORS.restroom, label: "Туалет" },
  { color: UNIT_COLORS.stairs, label: "Лестница, лифт" },
  { color: UNIT_COLORS.nonpublic, label: "Служебное" },
];

const LINES = [
  { style: "h-1.5 bg-[#2563eb] rounded-full", label: "Маршрут" },
  { style: "h-1 border-t-4 border-dashed border-[#c8b68f]", label: "Дорожка по улице" },
  { style: "h-1.5 bg-white border border-[#5b6577]", label: "Дверь — разрыв в стене" },
  { style: "h-1.5 bg-[#38bdf8]", label: "Окно" },
];

/** What the marks on the plan mean: opened by "?" and once on the first visit. */
export function Legend({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      // Above the place sheet, which is portalled with a very high z-index of its own.
      className="fixed inset-0 z-[2147483000] grid place-items-end bg-black/40 sm:place-items-center"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stops the backdrop click */}
      <div
        className="safe-bottom max-h-[85dvh] w-full space-y-4 overflow-y-auto rounded-t-3xl bg-bg p-5 shadow-2xl sm:max-w-md sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="text-lg font-semibold">
          Обозначения на карте
        </h2>
        <ul className="space-y-2.5 text-sm">
          {DOTS.map((d) => (
            <li key={d.label} className="flex items-center gap-3">
              <span
                className="size-4 shrink-0 rounded-full border-2 border-white shadow"
                style={{ background: d.color }}
                aria-hidden
              />
              {d.label}
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-2 text-sm">
          {AREAS.map((a) => (
            <div key={a.label} className="flex items-center gap-2">
              <span
                className="h-4 w-6 shrink-0 rounded border border-[#5b6577]"
                style={{ background: a.color }}
                aria-hidden
              />
              {a.label}
            </div>
          ))}
        </div>
        <ul className="space-y-2.5 text-sm">
          {LINES.map((l) => (
            <li key={l.label} className="flex items-center gap-3">
              <span className={`w-6 shrink-0 ${l.style}`} aria-hidden />
              {l.label}
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted">
          Нажмите на комнату или место — внизу откроется карточка с панорамой и маршрутом. 3D —
          объёмный вид этажа, кубик — макет по фотографиям, деревья — показать или скрыть природу.
        </p>
        <Button className="w-full" onClick={onClose}>
          Понятно
        </Button>
      </div>
    </div>
  );
}

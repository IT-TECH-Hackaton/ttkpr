import { UNIT_COLORS } from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { MapPinned, Navigation, View } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

const INTRO: { icon: ReactNode; title: string; text: string }[] = [
  {
    icon: <MapPinned className="size-7" aria-hidden />,
    title: "Найдите место",
    text: "Поиск сверху или нажмите на комнату на плане — внизу откроется её карточка.",
  },
  {
    icon: <Navigation className="size-7" aria-hidden />,
    title: "Постройте маршрут",
    text: "«Маршрут сюда» в карточке. Без лестниц — кнопка «Без ступенек», старт с QR на стене — «Вы здесь».",
  },
  {
    icon: <View className="size-7" aria-hidden />,
    title: "Осмотритесь заранее",
    text: "Панорамы 360° из карточки комнаты и вдоль маршрута, 3D-вид и этажи — кнопками справа.",
  },
];

/** "Где что": a question, a short answer and the control to light up on the map. */
const WHERE: { q: string; a: string; target?: string }[] = [
  {
    q: "Где поиск?",
    a: "Строка сверху: зал, стенд, кофе.",
    target: '[aria-label="Поиск по карте"]',
  },
  {
    q: "Как сменить этаж?",
    a: "Стрелки справа, рядом номер этажа.",
    target: 'fieldset[aria-label="Этаж"]',
  },
  { q: "Где 3D?", a: "Кнопка «3D» справа.", target: '[aria-label="Объёмный вид этажа"]' },
  {
    q: "Как убрать деревья?",
    a: "Кнопка с деревом справа.",
    target: '[aria-label="Деревья и газон вокруг зданий"]',
  },
  {
    q: "Где 3D-макет по фото?",
    a: "Кнопка с кубиком справа.",
    target: '[aria-label="3D-макет этажа по фотографиям"]',
  },
  {
    q: "Как приблизить?",
    a: "Кнопки «+» и «−» справа или двумя пальцами.",
    target: '[aria-label="Приблизить"]',
  },
  { q: "Где панорама?", a: "Нажмите на комнату — кнопка «Панорама» в карточке внизу." },
  { q: "Как построить маршрут?", a: "Нажмите на комнату или место — «Маршрут сюда»." },
  {
    q: "Как сохранить карту без интернета?",
    a: "Потяните нижнюю панель вверх — «Сохранить карту офлайн».",
  },
  { q: "Как задать вопрос организаторам?", a: "Нижняя панель — «Вопрос организаторам»." },
];

function spotlight(selector: string) {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return;
  el.scrollIntoView({ block: "nearest" });
  el.classList.remove("faq-spot");
  void el.offsetWidth; // restart the animation on a second tap
  el.classList.add("faq-spot");
  window.setTimeout(() => el.classList.remove("faq-spot"), 3300);
}

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

/** Help on the map: where the controls are and what the marks mean; "?" and the first visit. */
export function Legend({ onClose, intro = false }: { onClose: () => void; intro?: boolean }) {
  const titleId = useId();
  // First visit: three short steps, then the legend itself.
  const [step, setStep] = useState(intro ? 0 : INTRO.length);
  const current = INTRO[step];
  const [tab, setTab] = useState<"where" | "marks">("where");
  const tabClass = (on: boolean) =>
    `min-h-10 flex-1 rounded-xl text-sm font-semibold ${on ? "bg-bg shadow" : "text-muted"}`;
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
        {current ? (
          <div className="space-y-4">
            <div className="grid size-14 place-items-center rounded-2xl bg-accent text-accent-fg">
              {current.icon}
            </div>
            <h2 id={titleId} className="text-xl font-semibold">
              {current.title}
            </h2>
            <p className="leading-relaxed text-muted">{current.text}</p>
            <div className="flex items-center gap-2">
              {INTRO.map((item, i) => (
                <span
                  key={item.title}
                  className={
                    i === step ? "h-2 w-6 rounded-full bg-accent" : "size-2 rounded-full bg-border"
                  }
                  aria-hidden
                />
              ))}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={onClose}>
                Пропустить
              </Button>
              <Button className="flex-1" onClick={() => setStep(step + 1)}>
                Дальше
              </Button>
            </div>
          </div>
        ) : (
          <>
            <h2 id={titleId} className="text-lg font-semibold">
              Обозначения на карте
            </h2>
            <div className="flex gap-1 rounded-2xl bg-surface p-1" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "where"}
                className={tabClass(tab === "where")}
                onClick={() => setTab("where")}
              >
                Где что
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "marks"}
                className={tabClass(tab === "marks")}
                onClick={() => setTab("marks")}
              >
                Значки и цвета
              </button>
            </div>
            {tab === "where" ? (
              <ul className="divide-y divide-border">
                {WHERE.map((w) => (
                  <li key={w.q} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{w.q}</p>
                      <p className="text-sm text-muted">{w.a}</p>
                    </div>
                    {w.target && (
                      <Button
                        variant="secondary"
                        className="shrink-0 px-3"
                        onClick={() => {
                          const target = w.target;
                          onClose();
                          if (target) window.setTimeout(() => spotlight(target), 150);
                        }}
                      >
                        Показать
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <>
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
              </>
            )}
            <Button className="w-full" onClick={onClose}>
              Понятно
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

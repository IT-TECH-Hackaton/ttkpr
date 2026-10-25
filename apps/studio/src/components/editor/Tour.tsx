import { Button } from "@ttkpr/ui";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * First-visit tour of the editor: the screen dims, the block being explained stays lit with an
 * outline, and a card with an arrow says what it is for. Steps whose block is not on screen
 * (another role, another screen size) are skipped.
 */

export const TOUR_KEY = "ttkpr.studio.tour.v1";

interface Step {
  /** CSS selector of the block; none — a card in the middle of the screen. */
  target?: string;
  /** Light up the target's parent (a group of buttons) instead of the button itself. */
  group?: boolean;
  title: string;
  text: string;
}

const tool = (label: string) => `[aria-label="Инструменты"] [aria-label="${label}"]`;

const STEPS: Step[] = [
  {
    title: "Это студия",
    text: "Здесь рисуется карта здания: помещения, двери, места для гостей и панорамы. Покажем, где что, — это минута.",
  },
  {
    target: '[aria-label="Инструменты"]',
    title: "Инструменты",
    text: "Всё, чем рисуется план. Выберите инструмент и кликайте по карте. На телефоне панель листается вбок.",
  },
  {
    target: tool("Выбор"),
    title: "Выбор",
    text: "Нажмите на объект, чтобы изменить его. Точки на стенах и углах меняют размер комнаты.",
  },
  {
    target: tool("Перемещение"),
    title: "Перемещение",
    text: "Перетащите комнату, мебель, точку или панораму на новое место.",
  },
  {
    target: tool("Комната"),
    title: "Комната",
    text: "Два клика по противоположным углам. Углы прилипают к соседним комнатам — стены совпадают.",
  },
  {
    target: tool("Контур"),
    title: "Помещение любой формы",
    text: "Клики по углам, замкните контур на первой точке.",
  },
  {
    target: tool("Дверь"),
    title: "Двери и окна",
    text: "Клик по стене — дверь встанет вдоль неё. Стрелка рядом: двойная дверь, проход, вход в здание, окно.",
  },
  {
    target: tool("Лестница/лифт"),
    title: "Лестница и лифт",
    text: "Связывают этажи для маршрутов. Лифт нужен для маршрута «Без ступенек».",
  },
  {
    target: tool("Точка"),
    title: "Места для гостей",
    text: "Стенды, кафе, регистрация — их ищут и к ним строят маршрут. Категория — в стрелке рядом.",
  },
  {
    target: tool("Мебель"),
    title: "Мебель",
    text: "Столы, диваны, сцена в натуральную величину. Маршруты обходят их.",
  },
  {
    target: tool("Дорожка"),
    title: "Дорожка",
    text: "Путь по улице между зданиями: соединяет входы.",
  },
  {
    target: tool("Панорама"),
    title: "Панорама",
    text: "Отметьте место съёмки — появится QR. Откройте его телефоном и снимайте по целям.",
  },
  {
    target: '[aria-label="Загрузить план"]',
    title: "Схема здания",
    text: "Картинка плана ляжет подложкой — обводите комнаты поверх. PDF распознаётся сам: «Распознать план из файла» в свойствах.",
  },
  {
    target: '[aria-label="Привязка"]',
    title: "Привязка",
    text: "Углы и стены прилипают к сетке и соседним объектам. Выключите для точной ручной подгонки.",
  },
  {
    target: 'button[aria-label="Этаж"]',
    title: "Этажи",
    text: "Переключение, добавление и названия этажей.",
  },
  {
    target: '[aria-label="Слои"]',
    title: "Слои",
    text: "Скрыть подложку, подписи, точки или панорамы, чтобы не мешали.",
  },
  {
    target: '[data-tour="inspector"]',
    title: "Свойства",
    text: "Название, тип и размер выбранного объекта. Ничего не выбрано — сводка карты, маршруты и вопросы гостей.",
  },
  {
    target: '[aria-label="Отменить"]',
    group: true,
    title: "Отменить и повторить",
    text: "Любое действие можно отменить. Всё сохраняется само.",
  },
  {
    target: '[aria-label="Опубликовать"]',
    title: "Публикация",
    text: "Гости увидят карту по постоянной ссылке. Пока изменения сохраняются, кнопка бледная — нажмите, и появится причина.",
  },
  {
    target: '[aria-label="Поделиться"]',
    group: true,
    title: "Ссылка, команда, просмотр",
    text: "QR и код для сайта, приглашение коллег с ролями и карта глазами гостя.",
  },
  {
    target: '[aria-label="Помощь"]',
    title: "Помощь",
    text: "Справка и это обучение — здесь, пройти его можно ещё раз.",
  },
];

type Side = "below" | "above" | "left" | "right" | "over";

const ARROW_SIDE: Record<Side, string> = {
  below: "-top-1.5",
  above: "-bottom-1.5",
  left: "-right-1.5",
  right: "-left-1.5",
  over: "hidden",
};

/**
 * Where the card goes: under or over the block if it fits there, else beside it (a tall panel),
 * else over the block at the bottom of the screen. Always fully on screen.
 */
function place(
  rect: DOMRect | null,
  view: { w: number; h: number },
  cardW: number,
  cardH: number,
): { card: CSSProperties; arrow: CSSProperties; side: Side } {
  const M = 12;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  if (!rect) {
    return {
      card: {
        left: (view.w - cardW) / 2,
        top: clamp(view.h / 2 - cardH / 2, M, view.h - cardH - M),
        width: cardW,
      },
      arrow: {},
      side: "over",
    };
  }
  const gap = PAD + GAP;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const left = clamp(cx - cardW / 2, M, view.w - cardW - M);
  const arrowX = { left: clamp(cx - left - 7, 14, cardW - 28) };
  const below = view.h - rect.bottom - gap - M;
  const above = rect.top - gap - M;
  if (below >= cardH && below >= above) {
    return { card: { left, top: rect.bottom + gap, width: cardW }, arrow: arrowX, side: "below" };
  }
  if (above >= cardH) {
    return {
      card: { left, bottom: view.h - rect.top + gap, width: cardW },
      arrow: arrowX,
      side: "above",
    };
  }
  if (below >= cardH) {
    return { card: { left, top: rect.bottom + gap, width: cardW }, arrow: arrowX, side: "below" };
  }
  const top = clamp(cy - cardH / 2, M, view.h - cardH - M);
  const arrowY = { top: clamp(cy - top - 7, 14, cardH - 28) };
  if (rect.left - gap - M >= cardW) {
    return {
      card: { left: rect.left - gap - cardW, top, width: cardW },
      arrow: arrowY,
      side: "left",
    };
  }
  if (view.w - rect.right - gap - M >= cardW) {
    return { card: { left: rect.right + gap, top, width: cardW }, arrow: arrowY, side: "right" };
  }
  // A block as big as the screen (a phone): the card sits over its lower part.
  return { card: { left, bottom: M, width: cardW }, arrow: {}, side: "over" };
}

const PAD = 6;
const GAP = 14;
const CARD_W = 320;

function targetOf(step: Step | undefined): HTMLElement | null {
  if (!step?.target) return null;
  const el = document.querySelector<HTMLElement>(step.target);
  if (!el) return null;
  const node = step.group ? (el.parentElement ?? el) : el;
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? node : null;
}

export function StudioTour({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  // Index into STEPS; blocks missing on this screen are skipped when moving, since the editor
  // may still be rendering when the tour opens.
  const [index, setIndex] = useState(0);
  const present = (s: Step) => !s.target || targetOf(s) !== null;
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(220);
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight;
    if (h && Math.abs(h - cardH) > 2) setCardH(h);
  });
  const step = STEPS[index];
  const shown = STEPS.filter(present);
  const position = step ? shown.indexOf(step) + 1 : 0;
  const nextIndex = STEPS.findIndex((s, i) => i > index && present(s));
  const backIndex = STEPS.findLastIndex((s, i) => i < index && present(s));
  const last = nextIndex === -1;

  const measure = useCallback(() => {
    setView({ w: window.innerWidth, h: window.innerHeight });
    setRect(targetOf(step)?.getBoundingClientRect() ?? null);
  }, [step]);

  useLayoutEffect(() => {
    // A tool hidden in the scrolled toolbar: bring it into view first.
    targetOf(step)?.scrollIntoView({ block: "nearest", inline: "center" });
    measure();
    const late = window.setTimeout(measure, 320); // after smooth scrolling settles
    return () => window.clearTimeout(late);
  }, [step, measure]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const next = () => (last ? onClose() : setIndex(nextIndex));
  const back = () => backIndex >= 0 && setIndex(backIndex);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "Enter") next();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!step) return null;

  const cardW = Math.min(CARD_W, view.w - 24);
  const { card, arrow, side } = place(rect, view, cardW, cardH);

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="fixed inset-0 z-[70]">
      {/* Dim everything; the hole over the block is the box-shadow of the outline. */}
      {rect ? (
        <div
          aria-hidden
          className="tour-spot pointer-events-none fixed rounded-2xl ring-[3px] ring-sky-400 transition-all duration-300 ease-out"
          style={{
            left: rect.left - PAD,
            top: rect.top - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgb(2 6 23 / 0.62)",
          }}
        />
      ) : (
        <div aria-hidden className="fixed inset-0 bg-slate-950/60" />
      )}

      <div
        ref={cardRef}
        className="fixed rounded-2xl bg-bg p-4 text-fg shadow-2xl transition-all duration-300 ease-out"
        style={card}
      >
        {arrow && (
          <span
            aria-hidden
            className={`absolute size-3.5 rotate-45 bg-bg ${ARROW_SIDE[side]}`}
            style={arrow}
          />
        )}
        <p className="text-xs font-medium text-muted">
          {position} из {shown.length}
        </p>
        <h2 id={titleId} className="mt-1 text-lg font-semibold">
          {step.title}
        </h2>
        <p className="mt-1 text-sm leading-relaxed">{step.text}</p>
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-surface" aria-hidden>
          <div
            className="h-full rounded-full bg-accent transition-all duration-300"
            style={{ width: `${(position / shown.length) * 100}%` }}
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-10 px-1 text-sm font-medium text-muted hover:text-fg"
          >
            Пропустить
          </button>
          <span className="flex-1" />
          {backIndex >= 0 && (
            <Button variant="secondary" className="min-h-10 px-3" onClick={back}>
              Назад
            </Button>
          )}
          <Button className="min-h-10 px-4" onClick={next} autoFocus>
            {last ? "Готово" : "Дальше"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Whether this device has not seen the tour yet. */
export function tourPending(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) === null;
  } catch {
    return false;
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_KEY, "done");
  } catch {
    // Private mode: the tour comes back next time, nothing worse.
  }
}

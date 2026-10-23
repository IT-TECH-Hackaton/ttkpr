import { sortedLevels } from "@ttkpr/map-core";
import { Button, cn } from "@ttkpr/ui";
import { useEffect } from "react";
import { useStore } from "zustand";
import { EditorMap } from "./components/EditorMap";
import { Inspector } from "./components/Inspector";
import { type Tool, useDraft } from "./store";

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: "select", label: "Выбор", hint: "Выбрать помещение или точку" },
  { id: "rect", label: "Комната", hint: "Прямоугольная комната: два клика по углам" },
  {
    id: "room",
    label: "Контур",
    hint: "Помещение произвольной формы: клики по углам, замкнуть на первой точке",
  },
  { id: "poi", label: "Точка", hint: "Точка интереса: стенд, вход, стойка" },
];

function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  URL.revokeObjectURL(url);
}

export function App() {
  const doc = useDraft((s) => s.doc);
  const tool = useDraft((s) => s.tool);
  const levelId = useDraft((s) => s.levelId);
  const { setTool, setLevel } = useDraft.getState();
  const { undo, redo, pastStates, futureStates } = useStore(useDraft.temporal);
  const levels = sortedLevels(doc);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  return (
    <div className="flex h-full flex-col md:flex-row">
      <div className="relative min-h-[55dvh] flex-1">
        <EditorMap />
        <div className="absolute inset-x-3 top-3 flex flex-wrap items-center gap-2">
          <div
            role="toolbar"
            aria-label="Инструменты"
            className="flex rounded-2xl border border-border bg-bg p-1 shadow-lg"
          >
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                title={t.hint}
                aria-pressed={tool === t.id}
                onClick={() => setTool(t.id)}
                className={cn(
                  "min-h-10 rounded-xl px-3 text-sm font-medium",
                  tool === t.id ? "bg-accent text-accent-fg" : "text-fg",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex rounded-2xl border border-border bg-bg p-1 shadow-lg">
            <button
              type="button"
              className="min-h-10 px-3 disabled:opacity-40"
              disabled={!pastStates.length}
              onClick={() => undo()}
              aria-label="Отменить"
            >
              ↶
            </button>
            <button
              type="button"
              className="min-h-10 px-3 disabled:opacity-40"
              disabled={!futureStates.length}
              onClick={() => redo()}
              aria-label="Повторить"
            >
              ↷
            </button>
          </div>
          {levels.length > 1 && (
            <select
              aria-label="Этаж"
              value={levelId}
              onChange={(e) => setLevel(e.target.value)}
              className="min-h-12 rounded-2xl border border-border bg-bg px-3 shadow-lg"
            >
              {levels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <aside className="flex flex-col gap-4 border-border bg-surface p-4 md:w-80 md:border-l">
        <div>
          <h1 className="text-lg font-semibold">{doc.venue.name}</h1>
          <p className="text-sm text-muted">
            {doc.units?.length ?? 0} помещений · {doc.pois?.length ?? 0} точек ·{" "}
            {doc.panos?.length ?? 0} панорам
          </p>
        </div>
        <Inspector />
        <div className="mt-auto space-y-2">
          {/* TODO(studio-editor): save via @ttkpr/api-client saveDraft + publish once auth UI exists. */}
          <Button className="w-full" onClick={() => downloadJson("map-draft.json", doc)}>
            Скачать черновик (JSON)
          </Button>
        </div>
      </aside>
    </div>
  );
}

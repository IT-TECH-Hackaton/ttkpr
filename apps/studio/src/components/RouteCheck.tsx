import { buildNavGraph, unreachablePois } from "@ttkpr/map-core";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { useDraft } from "../store";

interface Issue {
  id: string;
  levelId: string;
  text: string;
}

/**
 * Can visitors get everywhere? Routes run through doors and stairs, so a room without a door
 * or floors without stairs leave places that no route reaches.
 */
export function RouteCheck() {
  const doc = useDraft((s) => s.doc);
  const { select, setLevel } = useDraft.getState();

  const { issues, floorsLinked } = useMemo(() => {
    const graph = buildNavGraph(doc);
    const rooms = [...graph.rooms.values()].flat().map((r) => r.unit);
    const withDoor = new Set(
      [...graph.nodes.values()].filter((n) => n.kind === "door").flatMap((n) => n.unitIds),
    );
    const cut = new Set(unreachablePois(graph, doc));
    const found: Issue[] = [
      ...(rooms.length > 1 ? rooms.filter((u) => !withDoor.has(u.id)) : []).map((u) => ({
        id: u.id,
        levelId: u.levelId,
        text: `Нет двери: «${u.name || "Помещение"}»`,
      })),
      ...(doc.pois ?? [])
        .filter((p) => cut.has(p.id))
        .map((p) => ({ id: p.id, levelId: p.levelId, text: `Не дойти до «${p.name}»` })),
    ];
    const levels = new Set(rooms.map((u) => u.levelId));
    return { issues: found, floorsLinked: levels.size < 2 || (doc.connectors?.length ?? 0) > 0 };
  }, [doc]);

  if ((doc.units?.length ?? 0) === 0) return null;
  if (issues.length === 0 && floorsLinked) {
    return (
      <p className="flex items-center gap-2 rounded-xl bg-green-50 dark:bg-green-950/60 p-3 text-sm text-green-900 dark:text-green-200">
        <CircleCheck className="size-4 shrink-0" aria-hidden />
        Маршруты строятся ко всем местам
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {!floorsLinked && (
        <p className="flex items-start gap-2 rounded-xl bg-amber-50 dark:bg-amber-950/60 p-3 text-sm text-amber-900 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          Этажи не связаны: добавьте лестницу или лифт на каждом этаже.
        </p>
      )}
      {issues.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border text-sm">
          {issues.map((issue) => (
            <li key={issue.id}>
              <button
                type="button"
                onClick={() => {
                  setLevel(issue.levelId);
                  select(issue.id);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface"
              >
                <TriangleAlert className="size-4 shrink-0 text-amber-600" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{issue.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

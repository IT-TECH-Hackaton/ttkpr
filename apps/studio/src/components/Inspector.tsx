import { POI_CATEGORIES, UNIT_COLORS } from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { useDraft } from "../store";

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

const field =
  "w-full rounded-xl border border-border bg-bg px-3 py-2 outline-none focus:border-accent";

export function Inspector() {
  const doc = useDraft((s) => s.doc);
  const selectedId = useDraft((s) => s.selectedId);
  const { updateUnit, updatePoi, remove } = useDraft.getState();

  const unit = doc.units?.find((u) => u.id === selectedId);
  const poi = doc.pois?.find((p) => p.id === selectedId);

  if (!unit && !poi) {
    return (
      <p className="text-sm text-muted">
        Выберите помещение или точку на плане, либо нарисуйте новое инструментами сверху.
      </p>
    );
  }

  return (
    <form className="space-y-3" onSubmit={(e) => e.preventDefault()}>
      <label className="block space-y-1">
        <span className="text-sm text-muted">Название</span>
        <input
          className={field}
          value={(unit ? unit.name : poi?.name) ?? ""}
          onChange={(e) =>
            unit
              ? updateUnit(unit.id, { name: e.target.value })
              : poi && updatePoi(poi.id, { name: e.target.value })
          }
        />
      </label>

      <div className="space-y-1">
        <label htmlFor="inspector-category" className="block text-sm text-muted">
          Категория
        </label>
        {unit ? (
          <select
            id="inspector-category"
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
        ) : (
          poi && (
            <select
              id="inspector-category"
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
          )
        )}
      </div>

      {poi && (
        <label className="block space-y-1">
          <span className="text-sm text-muted">Описание</span>
          <textarea
            className={`${field} min-h-24`}
            value={poi.description ?? ""}
            onChange={(e) => updatePoi(poi.id, { description: e.target.value })}
          />
        </label>
      )}

      <Button
        variant="secondary"
        className="w-full text-danger"
        onClick={() => selectedId && remove(selectedId)}
      >
        Удалить
      </Button>
    </form>
  );
}

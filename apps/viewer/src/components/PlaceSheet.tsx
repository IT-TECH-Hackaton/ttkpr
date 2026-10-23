import type { Level, Poi } from "@ttkpr/api-client";
import { categoryEmoji, categoryLabel, type MapBundle } from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { useEffect, useState } from "react";
import { Sheet } from "react-modal-sheet";

interface Props {
  bundle: MapBundle;
  level: Level | undefined;
  poi: Poi | undefined;
  hasPano: boolean;
  onPickPoi: (poi: Poi) => void;
  onOpenPano: () => void;
  onClose: () => void;
}

/** Pixel snap points; PEEK must match the map's bottom inset in MapScreen. */
export const SHEET_PEEK = 132;
const SNAP_POINTS = [0, SHEET_PEEK, 0.55, 1];

export function PlaceSheet({ bundle, level, poi, hasPano, onPickPoi, onOpenPano, onClose }: Props) {
  const levelPois = (bundle.pois ?? []).filter((p) => p.levelId === level?.id);
  // Open after mount: snap points are measured on mount, so initialSnap needs a mounted sheet.
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(true), []);

  return (
    <Sheet
      isOpen={open}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      initialSnap={1}
      disableDismiss
      disableScrollLocking
      className="pointer-events-none"
    >
      <Sheet.Container className="pointer-events-auto !rounded-t-[var(--radius-sheet)] !bg-bg !shadow-2xl">
        <Sheet.Header />
        <Sheet.Content disableDrag className="safe-bottom px-4">
          {poi ? (
            <section aria-label={poi.name} className="space-y-3">
              <div className="flex items-start gap-3">
                <span className="text-2xl" aria-hidden>
                  {categoryEmoji(poi.category)}
                </span>
                <div className="flex-1">
                  <h2 className="text-xl font-semibold leading-tight">{poi.name}</h2>
                  <p className="text-sm text-muted">
                    {categoryLabel(poi.category)} · {level?.name}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  aria-label="Закрыть"
                  onClick={onClose}
                  className="-mr-2 px-3"
                >
                  ✕
                </Button>
              </div>
              <div className="flex gap-2">
                <Button className="flex-1" disabled title="Маршруты — в работе">
                  Маршрут сюда
                </Button>
                <Button
                  variant="secondary"
                  className="flex-1"
                  disabled={!hasPano}
                  onClick={onOpenPano}
                >
                  Панорама
                </Button>
              </div>
              {poi.description && <p className="leading-relaxed">{poi.description}</p>}
            </section>
          ) : (
            <section className="space-y-2">
              <h2 className="text-lg font-semibold">{bundle.venue.name}</h2>
              <p className="text-sm text-muted">
                {level?.name} · {levelPois.length} мест
              </p>
              <ul className="divide-y divide-border">
                {levelPois.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => onPickPoi(p)}
                      className="flex min-h-12 w-full items-center gap-3 text-left"
                    >
                      <span aria-hidden>{categoryEmoji(p.category)}</span>
                      <span className="flex-1 font-medium">{p.name}</span>
                      <span className="text-sm text-muted">{categoryLabel(p.category)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </Sheet.Content>
      </Sheet.Container>
    </Sheet>
  );
}

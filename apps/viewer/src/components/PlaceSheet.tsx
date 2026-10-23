import type { Level, Poi } from "@ttkpr/api-client";
import { categoryEmoji, categoryLabel, type MapBundle } from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { LocateFixed, Navigation, View } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Sheet, type SheetRef } from "react-modal-sheet";

interface Props {
  bundle: MapBundle;
  level: Level | undefined;
  poi: Poi | undefined;
  hasPano: boolean;
  /** "Вы здесь" from a QR sign at the venue. */
  here?: Poi;
  /** Replaces the venue overview while a route is open (a tapped POI still shows its card). */
  routePanel?: ReactNode;
  onPickPoi: (poi: Poi) => void;
  onOpenPano: () => void;
  onRouteTo: (poi: Poi) => void;
  onRouteFrom: (poi: Poi) => void;
  onClose: () => void;
  /** Shown under the venue title (offline saving). */
  venueExtra?: ReactNode;
  /** Changing it lowers the sheet to the peek height, to show the plan (a tapped route step). */
  peekKey?: number;
}

/** Pixel snap points; PEEK must match the map's bottom inset in MapScreen. */
export const SHEET_PEEK = 132;
const SNAP_POINTS = [0, SHEET_PEEK, 0.55, 1];

export function PlaceSheet({
  bundle,
  level,
  poi,
  hasPano,
  here,
  routePanel,
  onPickPoi,
  onOpenPano,
  onRouteTo,
  onRouteFrom,
  onClose,
  venueExtra,
  peekKey,
}: Props) {
  const levelPois = (bundle.pois ?? []).filter((p) => p.levelId === level?.id);
  // Open after mount: snap points are measured on mount, so initialSnap needs a mounted sheet.
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(true), []);
  const sheetRef = useRef<SheetRef>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!peekKey) return;
    sheetRef.current?.snapTo(1);
    scrollRef.current?.scrollTo({ top: 0 }); // the peek shows the summary, not the middle of the list
  }, [peekKey]);

  return (
    <Sheet
      ref={sheetRef}
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
        <Sheet.Content disableDrag scrollRef={scrollRef} className="safe-bottom px-4">
          {poi ? (
            <section aria-label={poi.name} className="space-y-3">
              <div className="flex items-start gap-3">
                <span className="text-2xl" aria-hidden>
                  {categoryEmoji(poi.category)}
                </span>
                <div className="min-w-0 flex-1">
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
                <Button
                  className="flex-1"
                  onClick={() => onRouteTo(poi)}
                  disabled={poi.id === here?.id}
                >
                  <Navigation className="size-4" aria-hidden />
                  {poi.id === here?.id ? "Вы здесь" : "Маршрут сюда"}
                </Button>
                <Button
                  variant="secondary"
                  className="flex-1"
                  disabled={!hasPano}
                  onClick={onOpenPano}
                >
                  <View className="size-4" aria-hidden />
                  Панорама
                </Button>
              </div>
              <button
                type="button"
                onClick={() => onRouteFrom(poi)}
                className="min-h-10 text-sm font-medium text-accent"
              >
                Проложить маршрут отсюда
              </button>
              {poi.description && <p className="leading-relaxed">{poi.description}</p>}
            </section>
          ) : (
            (routePanel ?? (
              <section className="space-y-2">
                <h2 className="text-lg font-semibold">{bundle.venue.name}</h2>
                {here ? (
                  <p className="flex items-center gap-2 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-900">
                    <LocateFixed className="size-4 shrink-0" aria-hidden />
                    <span>
                      Вы здесь: <b>{here.name}</b>. Выберите место — проложим маршрут.
                    </span>
                  </p>
                ) : (
                  <p className="text-sm text-muted">
                    {level?.name} · {levelPois.length} мест
                  </p>
                )}
                {venueExtra}
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
            ))
          )}
        </Sheet.Content>
      </Sheet.Container>
    </Sheet>
  );
}

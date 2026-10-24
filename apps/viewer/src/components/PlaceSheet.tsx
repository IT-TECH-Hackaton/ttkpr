import type { Level, Poi, Unit } from "@ttkpr/api-client";
import {
  categoryEmoji,
  categoryLabel,
  type MapBundle,
  plural,
  poisIn,
  UNIT_LABELS,
  unitSize,
} from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { LocateFixed, Navigation, Route as RouteIcon, View, X } from "lucide-react";
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
  /** Wide screens: a panel in the left column instead of a bottom sheet. */
  wide?: boolean;
  onPickPoi: (poi: Poi) => void;
  onOpenPano: () => void;
  onRouteTo: (poi: Poi) => void;
  onRouteFrom: (poi: Poi) => void;
  onClose: () => void;
  /** Shown under the venue title (offline saving). */
  venueExtra?: ReactNode;
  onOpenTour?: (id: string) => void;
  /** Changing it lowers the sheet to the peek height, to show the plan (a tapped route step). */
  peekKey?: number;
  /** A room tapped on the plan: its card (size, places, panorama, route). */
  room?: Unit;
  roomPanos?: number;
  onOpenRoomPano?: () => void;
  onRouteToRoom?: () => void;
  onRouteFromRoom?: () => void;
  onCloseRoom?: () => void;
  /** Changing it raises the sheet halfway: a place or a room was picked, show its card. */
  openKey?: string;
}

/** Pixel snap points; PEEK must match the map's bottom inset in MapScreen. */
export const SHEET_PEEK = 132;
const SNAP_POINTS = [0, SHEET_PEEK, 0.55, 1];

export function PlaceSheet({ wide, peekKey, openKey, onClose, ...props }: Props) {
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
  useEffect(() => {
    if (openKey) sheetRef.current?.snapTo(2);
  }, [openKey]);

  const content = <PlaceContent {...props} onClose={onClose} />;

  if (wide) {
    return (
      <aside
        ref={scrollRef}
        aria-label="Панель места"
        className="pointer-events-auto min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-2xl border border-border bg-bg p-4 shadow-xl"
      >
        {content}
      </aside>
    );
  }

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
          {content}
        </Sheet.Content>
      </Sheet.Container>
    </Sheet>
  );
}

function PlaceContent({
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
  onOpenTour,
  room,
  roomPanos = 0,
  onOpenRoomPano,
  onRouteToRoom,
  onRouteFromRoom,
  onCloseRoom,
}: Omit<Props, "wide" | "peekKey" | "openKey">) {
  const levelPois = (bundle.pois ?? []).filter((p) => p.levelId === level?.id);
  const tours = (bundle.tours ?? []).filter((t) => (t.stops?.length ?? 0) >= 2);

  if (poi) {
    return (
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
          <Button variant="ghost" aria-label="Закрыть" onClick={onClose} className="-mr-2 px-3">
            <X className="size-5" aria-hidden />
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            className="min-w-0 flex-1"
            onClick={() => onRouteTo(poi)}
            disabled={poi.id === here?.id}
          >
            <Navigation className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{poi.id === here?.id ? "Вы здесь" : "Маршрут сюда"}</span>
          </Button>
          <Button
            variant="secondary"
            className="min-w-0 flex-1"
            disabled={!hasPano}
            onClick={onOpenPano}
          >
            <View className="size-4 shrink-0" aria-hidden />
            <span className="truncate">Панорама</span>
          </Button>
        </div>
        <button
          type="button"
          onClick={() => onRouteFrom(poi)}
          className="min-h-11 text-sm font-medium text-accent"
        >
          Проложить маршрут отсюда
        </button>
        {poi.description && <p className="leading-relaxed">{poi.description}</p>}
      </section>
    );
  }

  if (room && !routePanel) {
    const size = unitSize(bundle, room);
    const inside = poisIn(bundle, room);
    const kind = UNIT_LABELS[room.category] ?? "Помещение";
    return (
      <section aria-label={room.name ?? kind} className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold leading-tight">{room.name || kind}</h2>
            <p className="text-sm text-muted">
              {[
                room.name && room.name !== kind ? kind : null,
                level?.name,
                size
                  ? `${size.widthM.toFixed(1)} × ${size.depthM.toFixed(1)} м, ${Math.round(size.areaM2)} м²`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <Button variant="ghost" aria-label="Закрыть" onClick={onCloseRoom} className="-mr-2 px-3">
            <X className="size-5" aria-hidden />
          </Button>
        </div>
        <div className="flex gap-2">
          <Button className="min-w-0 flex-1" onClick={onRouteToRoom}>
            <Navigation className="size-4 shrink-0" aria-hidden />
            <span className="truncate">Маршрут сюда</span>
          </Button>
          <Button
            variant="secondary"
            className="min-w-0 flex-1"
            disabled={roomPanos === 0}
            onClick={onOpenRoomPano}
          >
            <View className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{roomPanos === 0 ? "Нет панорамы" : "Панорама"}</span>
          </Button>
        </div>
        <button
          type="button"
          onClick={onRouteFromRoom}
          className="min-h-11 text-sm font-medium text-accent"
        >
          Проложить маршрут отсюда
        </button>
        {room.description && <p className="leading-relaxed">{room.description}</p>}
        {inside.length > 0 && (
          <ul className="divide-y divide-border">
            {inside.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onPickPoi(p)}
                  className="flex min-h-12 w-full items-center gap-3 text-left"
                >
                  <span aria-hidden>{categoryEmoji(p.category)}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                  <span className="shrink-0 text-sm text-muted">{categoryLabel(p.category)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  if (routePanel) return routePanel;

  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">{bundle.venue.name}</h2>
      {here ? (
        <p className="flex items-center gap-2 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950 dark:text-green-200">
          <LocateFixed className="size-4 shrink-0" aria-hidden />
          <span>
            Вы здесь: <b>{here.name}</b>. Выберите место — проложим маршрут.
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted">
          {level?.name} · {plural(levelPois.length, ["место", "места", "мест"])}
        </p>
      )}
      {tours.length > 0 && (
        <div className="space-y-1 pt-1">
          <h3 className="text-sm font-semibold text-muted">Маршруты от организатора</h3>
          <ul className="space-y-1">
            {tours.map((tour) => (
              <li key={tour.id}>
                <button
                  type="button"
                  onClick={() => onOpenTour?.(tour.id)}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl bg-surface px-3 text-left"
                >
                  <RouteIcon className="size-5 shrink-0 text-accent" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-medium">{tour.name}</span>
                  <span className="shrink-0 text-sm text-muted">
                    {plural(tour.stops?.length ?? 0, ["точка", "точки", "точек"])}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
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
              <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
              <span className="shrink-0 text-sm text-muted">{categoryLabel(p.category)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

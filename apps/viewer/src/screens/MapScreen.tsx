import { useNavigate } from "@tanstack/react-router";
import type { Poi } from "@ttkpr/api-client";
import {
  type Endpoint,
  findTourRoute,
  type LonLat,
  largestGapM,
  nearestPano,
  nextStep,
  panosAlongRoute,
  type RouteStep,
  roomAt,
  sortedLevels,
} from "@ttkpr/map-core";
import { Button, cn, ThemeSwitch, useTheme } from "@ttkpr/ui";
import { Box } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { LevelSwitcher } from "../components/LevelSwitcher";
import { OfflineControl } from "../components/OfflineControl";
import { PlaceSheet, SHEET_PEEK } from "../components/PlaceSheet";
import { PlanMap } from "../components/PlanMap";
import { RouteCard, TourCard } from "../components/RouteCard";
import { SearchBar } from "../components/SearchBar";
import { WalkControls } from "../components/WalkControls";
import { useMapBundle } from "../lib/bundle";
import { type End, endpointLabel, formatEndpoint, useNavGraph, useRoute } from "../lib/routing";
import { usePoiSearch } from "../lib/search";
import { track } from "../lib/stats";
import { useMediaQuery, WIDE_QUERY } from "../lib/useMediaQuery";
import { useOnline } from "../lib/useOnline";
import { type MapSearch, mapRoute } from "../router";

const PanoView = lazy(() => import("../components/PanoView"));
const Dollhouse = lazy(() => import("../components/Dollhouse"));
// Route mode only: kept out of the first bundle of a shared map link.
const EndpointPicker = lazy(() =>
  import("../components/EndpointPicker").then((m) => ({ default: m.EndpointPicker })),
);
const RoutePanel = lazy(() =>
  import("../components/RoutePanel").then((m) => ({ default: m.RoutePanel })),
);

const AUTO_WALK_MS = 5000;
/** Width of the left column (search, panel) on wide screens. */
const WIDE_COLUMN = 380;

export function MapScreen() {
  const { slug } = mapRoute.useParams();
  const search = mapRoute.useSearch();
  const navigate = useNavigate({ from: mapRoute.fullPath });
  const { data, error, isPending } = useMapBundle(slug);
  const online = useOnline();
  const wide = useMediaQuery(WIDE_QUERY);
  const bundle = data?.bundle;
  const searchPois = usePoiSearch(bundle);
  const graph = useNavGraph(bundle);
  const {
    from,
    to,
    route: pairRoute,
    problem: pairProblem,
  } = useRoute(bundle, graph, search.from, search.to, search.acc === true);
  // An organizer's tour replaces "откуда → куда" while it is open.
  const tour = bundle?.tours?.find((t) => t.id === search.tour && (t.stops?.length ?? 0) >= 2);
  const tourRoute = useMemo(
    () =>
      bundle && graph && tour
        ? findTourRoute(graph, bundle, tour.stops ?? [], {
            avoidStairs: tour.avoidStairs || search.acc === true,
          })
        : null,
    [bundle, graph, tour, search.acc],
  );
  const route = tour ? tourRoute : pairRoute;
  const problem = tour
    ? tourRoute
      ? null
      : "Между точками этого маршрута нет прохода по плану"
    : pairProblem;
  const walkPanos = useMemo(
    () => (bundle && route ? panosAlongRoute(bundle, route) : []),
    [bundle, route],
  );

  /** Full-screen list for choosing a route end. */
  const [picker, setPicker] = useState<End | null>(null);
  /** The next tap on the plan sets this route end. */
  const [picking, setPicking] = useState<End | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ position: LonLat; n: number }>();
  const [auto, setAuto] = useState(false);
  const [threeD, setThreeD] = useState(false);
  const [dollhouse, setDollhouse] = useState(false);
  const { dark } = useTheme();

  const setSearch = useCallback(
    (patch: Partial<MapSearch>) =>
      navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }),
    [navigate],
  );

  const walkIndex =
    search.walk !== undefined && walkPanos.length > 0
      ? Math.min(search.walk, walkPanos.length - 1)
      : undefined;

  useEffect(() => {
    if (!auto || walkIndex === undefined) return;
    if (walkIndex >= walkPanos.length - 1) {
      setAuto(false);
      return;
    }
    const timer = setTimeout(() => setSearch({ walk: walkIndex + 1 }), AUTO_WALK_MS);
    return () => clearTimeout(timer);
  }, [auto, walkIndex, walkPanos.length, setSearch]);

  // Anonymous counters for the organizer's statistics (see lib/stats.ts).
  const loaded = data !== undefined;
  useEffect(() => {
    if (loaded) track(slug, "view");
  }, [loaded, slug]);
  useEffect(() => {
    if (loaded && search.poi) track(slug, "poi", search.poi);
  }, [loaded, slug, search.poi]);
  useEffect(() => {
    if (loaded && search.pano) track(slug, "pano", search.pano);
  }, [loaded, slug, search.pano]);
  useEffect(() => {
    if (loaded && search.tour) track(slug, "tour", search.tour);
  }, [loaded, slug, search.tour]);
  useEffect(() => {
    // Places only: points tapped on the map are too scattered to be useful.
    const end = (v: string) => (v.startsWith("@") ? "point" : v);
    if (pairRoute && search.from && search.to) {
      track(slug, "route", `${end(search.from)}>${end(search.to)}`);
    }
  }, [pairRoute, slug, search.from, search.to]);

  if (isPending) {
    return <div className="grid h-full place-items-center text-muted">Загружаем карту…</div>;
  }
  if (error || !data || !graph) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <p>
          {error?.message.endsWith("403")
            ? "Эта карта доступна только по приглашению организатора."
            : error?.message.endsWith("404")
              ? "Карта не найдена или ещё не опубликована."
              : "Не удалось открыть карту. Проверьте ссылку или подключение."}
        </p>
      </div>
    );
  }

  const { manifest, fromSaved } = data;
  const map = data.bundle;
  const levels = sortedLevels(map);
  const routeMode = tour !== undefined || search.from !== undefined || search.to !== undefined;
  const selectedPoi = map.pois?.find((p) => p.id === search.poi);
  const herePoi = map.pois?.find((p) => p.id === search.here);
  const levelId =
    search.level ??
    (routeMode ? route?.legs[0]?.levelId : undefined) ??
    selectedPoi?.levelId ??
    herePoi?.levelId ??
    levels[0]?.id ??
    "";
  const level = levels.find((l) => l.id === levelId);
  const walk = walkIndex !== undefined ? walkPanos[walkIndex] : undefined;
  const pano = walk?.pano ?? map.panos?.find((p) => p.id === search.pano);
  const poiPano = selectedPoi ? nearestPano(map, selectedPoi) : null;
  const destPoiId = tour ? tour.stops?.at(-1) : to && "poiId" in to ? to.poiId : undefined;

  const pickPoi = (poi: Poi) => setSearch({ poi: poi.id, level: poi.levelId });

  const setEnd = (end: End, endpoint: Endpoint) => {
    setPicker(null);
    setPicking(null);
    setPickError(null);
    const value = formatEndpoint(endpoint);
    setSearch({
      ...(end === "from" ? { from: value } : { to: value }),
      poi: undefined,
      level: undefined,
      walk: undefined,
    });
    // Ask for the other end right away if it is still missing.
    const other = end === "from" ? search.to : search.from;
    if (!other) setPicker(end === "from" ? "to" : "from");
  };

  const routeTo = (poi: Poi) => {
    const start = search.from ?? (search.here !== poi.id ? search.here : undefined);
    setSearch({ to: poi.id, from: start, poi: undefined, level: undefined, walk: undefined });
    if (!start) setPicker("from");
  };

  const routeFrom = (poi: Poi) => {
    setSearch({ from: poi.id, poi: undefined, level: undefined, walk: undefined });
    if (!search.to) setPicker("to");
  };

  const closeRoute = () => {
    setPicking(null);
    setAuto(false);
    setSearch({
      from: undefined,
      to: undefined,
      tour: undefined,
      walk: undefined,
      level: undefined,
    });
  };

  const tapPlan = (position: LonLat) => {
    if (!picking) {
      setSearch({ poi: undefined });
      return;
    }
    if (!roomAt(graph, levelId, position)) {
      setPickError("Здесь нет прохода — коснитесь внутри помещения");
      return;
    }
    setEnd(picking, { levelId, position });
  };

  const showStep = (step: RouteStep) => {
    setSearch({ level: step.levelId });
    setFocus({ position: step.position, n: Date.now() });
  };

  const openFromDollhouse = (id: string) => {
    setDollhouse(false);
    setSearch({ pano: id });
  };

  const exitWalk = (patch: Partial<MapSearch> = {}) => {
    setAuto(false);
    setSearch({ walk: undefined, ...patch });
  };

  // Phones: controls on top, the sheet at the bottom. Wide screens: a left column like a map app.
  const insets = wide
    ? { top: 16, bottom: 16, left: WIDE_COLUMN + 32 }
    : { top: routeMode ? 160 : 84, bottom: SHEET_PEEK + 24, left: 16 };

  const offlineBanner = (!online || fromSaved) && (
    <p
      role="status"
      className="pointer-events-auto rounded-xl bg-amber-100 dark:bg-amber-950/60 px-3 py-2 text-sm text-amber-900 dark:text-amber-200 shadow"
    >
      Нет сети — показываем сохранённую версию карты
    </p>
  );
  const topControl = picking ? (
    <div
      role="status"
      className="flex items-center gap-3 rounded-2xl bg-accent px-4 py-2 text-accent-fg shadow-lg"
    >
      <p className="flex-1 text-sm font-medium leading-snug">
        {pickError ??
          (picking === "from"
            ? "Коснитесь плана там, откуда идёте"
            : "Коснитесь плана там, куда идёте")}
      </p>
      <Button
        variant="secondary"
        className="min-h-10 shrink-0"
        onClick={() => {
          setPicking(null);
          setPickError(null);
        }}
      >
        Отмена
      </Button>
    </div>
  ) : tour ? (
    <TourCard name={tour.name} stops={tour.stops?.length ?? 0} onClose={closeRoute} />
  ) : routeMode ? (
    <RouteCard
      fromLabel={endpointLabel(map, from, herePoi?.id)}
      toLabel={endpointLabel(map, to, herePoi?.id)}
      onEdit={setPicker}
      onSwap={() =>
        setSearch({ from: search.to, to: search.from, level: undefined, walk: undefined })
      }
      onClose={closeRoute}
    />
  ) : (
    <SearchBar
      search={searchPois}
      levels={levels}
      onPick={pickPoi}
      onQuery={(query, found) => track(slug, found ? "search" : "miss", query)}
    />
  );
  const levelSwitcher = (
    <div className="flex flex-col items-end gap-2">
      <LevelSwitcher
        levels={levels}
        value={levelId}
        onChange={(id) => setSearch({ level: id, poi: undefined })}
      />
      <button
        type="button"
        aria-pressed={threeD}
        aria-label="Объёмный вид этажа"
        onClick={() => setThreeD(!threeD)}
        className={cn(
          "grid size-12 place-items-center rounded-2xl border border-border text-sm font-bold shadow-lg",
          threeD ? "bg-accent text-accent-fg" : "bg-bg text-fg",
        )}
      >
        3D
      </button>
      <button
        type="button"
        aria-label="3D-макет этажа по фотографиям"
        title="3D-макет: стены и пол из панорам"
        onClick={() => setDollhouse(true)}
        className="grid size-12 place-items-center rounded-2xl border border-border bg-bg text-fg shadow-lg"
      >
        <Box className="size-5" aria-hidden />
      </button>
    </div>
  );
  // The sheet is portalled above everything: hidden under a panorama or the end picker.
  const sheet = !pano && !picker && (
    <PlaceSheet
      bundle={map}
      level={level}
      poi={selectedPoi}
      hasPano={poiPano !== null}
      here={herePoi}
      routePanel={
        routeMode ? (
          <Suspense fallback={<p className="text-muted">Строим маршрут…</p>}>
            <RoutePanel
              bundle={map}
              description={tour?.description}
              route={route}
              problem={problem}
              missing={!from ? "from" : !to ? "to" : null}
              avoidStairs={search.acc === true}
              onToggleStairs={() =>
                setSearch({ acc: search.acc ? undefined : true, walk: undefined })
              }
              panoCount={walkPanos.length}
              gapM={route ? largestGapM(route, walkPanos) : 0}
              onWalk={() => setSearch({ walk: 0, pano: undefined })}
              onStep={showStep}
            />
          </Suspense>
        ) : undefined
      }
      onPickPoi={pickPoi}
      onOpenPano={() => poiPano && setSearch({ pano: poiPano.id })}
      onRouteTo={routeTo}
      onOpenTour={(id) =>
        setSearch({ tour: id, from: undefined, to: undefined, poi: undefined, level: undefined })
      }
      onRouteFrom={routeFrom}
      onClose={() => setSearch({ poi: undefined })}
      venueExtra={
        <div className="space-y-2">
          <OfflineControl slug={slug} version={manifest.version} />
          <ThemeSwitch />
        </div>
      }
      peekKey={focus?.n}
      wide={wide}
    />
  );

  return (
    <div className="relative h-full overflow-hidden">
      <PlanMap
        bundle={map}
        levelId={levelId}
        selectedPoiId={selectedPoi?.id}
        route={route}
        hereId={herePoi?.id}
        numbered={tour !== undefined}
        threeD={threeD}
        picking={picking !== null}
        focus={focus}
        topInset={insets.top}
        bottomInset={insets.bottom}
        leftInset={insets.left}
        onSelectPoi={(id) => (picking ? setEnd(picking, { poiId: id }) : setSearch({ poi: id }))}
        onSelectPano={(id) => setSearch({ pano: id })}
        onBackgroundTap={tapPlan}
      />

      {wide ? (
        <>
          <div
            className="pointer-events-none absolute inset-y-0 left-0 z-10 flex flex-col gap-3 p-4"
            style={{ width: WIDE_COLUMN + 32 }}
          >
            {offlineBanner}
            <div className="pointer-events-auto">{topControl}</div>
            {sheet}
          </div>
          <div className="pointer-events-auto absolute right-4 top-4 z-10">{levelSwitcher}</div>
        </>
      ) : (
        <>
          <div className="safe-top pointer-events-none absolute inset-x-0 top-0 z-10 space-y-3 px-4">
            {offlineBanner}
            <div className="pointer-events-auto">{topControl}</div>
            <div className="pointer-events-auto ml-auto w-fit">{levelSwitcher}</div>
          </div>
          {sheet}
        </>
      )}

      {pano && (
        <Suspense fallback={<div className="fixed inset-0 z-20 bg-black" />}>
          <PanoView
            bundle={map}
            pano={pano}
            focusPoiId={selectedPoi?.id}
            routeOverlay={
              route
                ? {
                    route,
                    follow: walk !== undefined,
                    nextPanoId:
                      walkIndex !== undefined ? walkPanos[walkIndex + 1]?.pano.id : undefined,
                    destPoiId,
                  }
                : undefined
            }
            closeLabel={walk ? "← К маршруту" : undefined}
            onSelectPoi={(id) => exitWalk({ poi: id, pano: undefined })}
            onSelectPano={(id) => {
              const index = walkPanos.findIndex((p) => p.pano.id === id);
              if (walk && index >= 0) setSearch({ walk: index });
              else exitWalk({ pano: id });
            }}
            onClose={() => exitWalk({ pano: undefined })}
          >
            {walk && route && walkIndex !== undefined && (
              <WalkControls
                index={walkIndex}
                total={walkPanos.length}
                next={nextStep(route, walk.along)}
                auto={auto}
                onPrev={() => setSearch({ walk: Math.max(0, walkIndex - 1) })}
                onNext={() => setSearch({ walk: walkIndex + 1 })}
                onToggleAuto={() => setAuto(!auto)}
                onFinish={() => exitWalk({ level: route.legs.at(-1)?.levelId })}
              />
            )}
          </PanoView>
        </Suspense>
      )}

      {dollhouse && (
        <Suspense fallback={<div className="fixed inset-0 z-30 bg-bg" />}>
          <Dollhouse
            bundle={map}
            levelId={levelId}
            dark={dark}
            onOpenPano={openFromDollhouse}
            onClose={() => setDollhouse(false)}
          />
        </Suspense>
      )}

      {picker && (
        <Suspense fallback={<div className="fixed inset-0 z-30 bg-bg" />}>
          <EndpointPicker
            end={picker}
            bundle={map}
            levels={levels}
            search={searchPois}
            hereId={herePoi?.id}
            exclude={picker === "from" ? search.to : search.from}
            onPick={(endpoint) => setEnd(picker, endpoint)}
            onPickOnMap={() => {
              setPicking(picker);
              setPicker(null);
            }}
            onClose={() => setPicker(null)}
          />
        </Suspense>
      )}
    </div>
  );
}

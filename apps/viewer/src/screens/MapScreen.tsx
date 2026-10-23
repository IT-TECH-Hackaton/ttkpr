import { useNavigate } from "@tanstack/react-router";
import type { Poi } from "@ttkpr/api-client";
import {
  type Endpoint,
  type LonLat,
  largestGapM,
  nearestPano,
  nextStep,
  panosAlongRoute,
  type RouteStep,
  roomAt,
  sortedLevels,
} from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { EndpointPicker } from "../components/EndpointPicker";
import { LevelSwitcher } from "../components/LevelSwitcher";
import { OfflineControl } from "../components/OfflineControl";
import { PlaceSheet, SHEET_PEEK } from "../components/PlaceSheet";
import { PlanMap } from "../components/PlanMap";
import { RouteCard } from "../components/RouteCard";
import { RoutePanel } from "../components/RoutePanel";
import { SearchBar } from "../components/SearchBar";
import { WalkControls } from "../components/WalkControls";
import { useMapBundle } from "../lib/bundle";
import { type End, endpointLabel, formatEndpoint, useNavGraph, useRoute } from "../lib/routing";
import { usePoiSearch } from "../lib/search";
import { useOnline } from "../lib/useOnline";
import { type MapSearch, mapRoute } from "../router";

const PanoView = lazy(() => import("../components/PanoView"));

const AUTO_WALK_MS = 5000;

export function MapScreen() {
  const { slug } = mapRoute.useParams();
  const search = mapRoute.useSearch();
  const navigate = useNavigate({ from: mapRoute.fullPath });
  const { data, error, isPending } = useMapBundle(slug);
  const online = useOnline();
  const bundle = data?.bundle;
  const searchPois = usePoiSearch(bundle);
  const graph = useNavGraph(bundle);
  const { from, to, route, problem } = useRoute(
    bundle,
    graph,
    search.from,
    search.to,
    search.acc === true,
  );
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
  const routeMode = search.from !== undefined || search.to !== undefined;
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
  const destPoiId = to && "poiId" in to ? to.poiId : undefined;

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
    setSearch({ from: undefined, to: undefined, walk: undefined, level: undefined });
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

  const exitWalk = (patch: Partial<MapSearch> = {}) => {
    setAuto(false);
    setSearch({ walk: undefined, ...patch });
  };

  const topInset = routeMode ? 160 : 84;

  return (
    <div className="relative h-full overflow-hidden">
      <PlanMap
        bundle={map}
        levelId={levelId}
        selectedPoiId={selectedPoi?.id}
        route={route}
        hereId={herePoi?.id}
        picking={picking !== null}
        focus={focus}
        topInset={topInset}
        bottomInset={SHEET_PEEK + 24}
        onSelectPoi={(id) => (picking ? setEnd(picking, { poiId: id }) : setSearch({ poi: id }))}
        onSelectPano={(id) => setSearch({ pano: id })}
        onBackgroundTap={tapPlan}
      />

      <div className="safe-top pointer-events-none absolute inset-x-0 top-0 z-10 space-y-3 px-4">
        {(!online || fromSaved) && (
          <p
            role="status"
            className="pointer-events-auto rounded-xl bg-amber-100 px-3 py-2 text-sm text-amber-900 shadow"
          >
            Нет сети — показываем сохранённую версию карты
          </p>
        )}
        <div className="pointer-events-auto">
          {picking ? (
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
            <SearchBar search={searchPois} levels={levels} onPick={pickPoi} />
          )}
        </div>
        <div className="pointer-events-auto ml-auto w-fit">
          <LevelSwitcher
            levels={levels}
            value={levelId}
            onChange={(id) => setSearch({ level: id, poi: undefined })}
          />
        </div>
      </div>

      {/* The sheet is portalled above everything: hidden under a panorama or the end picker. */}
      {!pano && !picker && (
        <PlaceSheet
          bundle={map}
          level={level}
          poi={selectedPoi}
          hasPano={poiPano !== null}
          here={herePoi}
          routePanel={
            routeMode ? (
              <RoutePanel
                bundle={map}
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
            ) : undefined
          }
          onPickPoi={pickPoi}
          onOpenPano={() => poiPano && setSearch({ pano: poiPano.id })}
          onRouteTo={routeTo}
          onRouteFrom={routeFrom}
          onClose={() => setSearch({ poi: undefined })}
          venueExtra={<OfflineControl slug={slug} version={manifest.version} />}
          peekKey={focus?.n}
        />
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

      {picker && (
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
      )}
    </div>
  );
}

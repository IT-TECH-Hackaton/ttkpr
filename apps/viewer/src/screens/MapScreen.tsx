import { useNavigate } from "@tanstack/react-router";
import type { Poi } from "@ttkpr/api-client";
import { nearestPano, sortedLevels } from "@ttkpr/map-core";
import { lazy, Suspense, useCallback } from "react";
import { LevelSwitcher } from "../components/LevelSwitcher";
import { PlaceSheet, SHEET_PEEK } from "../components/PlaceSheet";
import { PlanMap } from "../components/PlanMap";
import { SearchBar } from "../components/SearchBar";
import { useMapBundle } from "../lib/bundle";
import { usePoiSearch } from "../lib/search";
import { type MapSearch, mapRoute } from "../router";

const PanoView = lazy(() => import("../components/PanoView"));

export function MapScreen() {
  const { slug } = mapRoute.useParams();
  const search = mapRoute.useSearch();
  const navigate = useNavigate({ from: mapRoute.fullPath });
  const { data, error, isPending } = useMapBundle(slug);
  const searchPois = usePoiSearch(data?.bundle);

  const setSearch = useCallback(
    (patch: Partial<MapSearch>) =>
      navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }),
    [navigate],
  );

  if (isPending) {
    return <div className="grid h-full place-items-center text-muted">Загружаем карту…</div>;
  }
  if (error || !data) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <p>Не удалось открыть карту. Проверьте ссылку или подключение.</p>
      </div>
    );
  }

  const { bundle } = data;
  const levels = sortedLevels(bundle);
  const selectedPoi = bundle.pois?.find((p) => p.id === search.poi);
  const levelId = search.level ?? selectedPoi?.levelId ?? levels[0]?.id ?? "";
  const level = levels.find((l) => l.id === levelId);
  const pano = bundle.panos?.find((p) => p.id === search.pano);
  const poiPano = selectedPoi ? nearestPano(bundle, selectedPoi) : null;

  const pickPoi = (poi: Poi) => setSearch({ poi: poi.id, level: poi.levelId });

  return (
    <div className="relative h-full overflow-hidden">
      <PlanMap
        bundle={bundle}
        levelId={levelId}
        selectedPoiId={selectedPoi?.id}
        bottomInset={SHEET_PEEK + 24}
        onSelectPoi={(id) => setSearch({ poi: id })}
        onSelectPano={(id) => setSearch({ pano: id })}
        onBackgroundTap={() => setSearch({ poi: undefined })}
      />

      <div className="safe-top pointer-events-none absolute inset-x-0 top-0 z-10 space-y-3 px-4">
        <div className="pointer-events-auto">
          <SearchBar search={searchPois} levels={levels} onPick={pickPoi} />
        </div>
        <div className="pointer-events-auto ml-auto w-fit">
          <LevelSwitcher
            levels={levels}
            value={levelId}
            onChange={(id) => setSearch({ level: id, poi: undefined })}
          />
        </div>
      </div>

      {/* The sheet is portalled above everything, so it is hidden while a panorama is open. */}
      {!pano && (
        <PlaceSheet
          bundle={bundle}
          level={level}
          poi={selectedPoi}
          hasPano={poiPano !== null}
          onPickPoi={pickPoi}
          onOpenPano={() => poiPano && setSearch({ pano: poiPano.id })}
          onClose={() => setSearch({ poi: undefined })}
        />
      )}

      {pano && (
        <Suspense fallback={<div className="fixed inset-0 z-20 bg-black" />}>
          <PanoView
            bundle={bundle}
            pano={pano}
            focusPoiId={selectedPoi?.id}
            onSelectPoi={(id) => setSearch({ poi: id, pano: undefined })}
            onSelectPano={(id) => setSearch({ pano: id })}
            onClose={() => setSearch({ pano: undefined })}
          />
        </Suspense>
      )}
    </div>
  );
}

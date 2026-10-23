// "Точки в панораме": the organizer looks around a panorama and clicks the floor where an object
// stands; the point lands on the plan (floor ray from the camera height) and shows up in every
// panorama. Existing points are drawn as markers, so a wrong heading is obvious at a glance.
// Loaded lazily: three.js + Photo Sphere Viewer stay out of the editor's first bundle.

import "@photo-sphere-viewer/core/index.css";
import "@photo-sphere-viewer/markers-plugin/index.css";
import { Viewer } from "@photo-sphere-viewer/core";
import {
  type EquirectangularMultiTilesPanorama,
  EquirectangularTilesAdapter,
} from "@photo-sphere-viewer/equirectangular-tiles-adapter";
import { type MarkerConfig, MarkersPlugin } from "@photo-sphere-viewer/markers-plugin";
import type { PanoramaOut } from "@ttkpr/api-client";
import {
  categoryEmoji,
  floorPointFromPano,
  fromLocal,
  type MapBundle,
  panoPose,
  panoTargets,
  toDeg,
  toRad,
} from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useDraft } from "../store";

function tiled(pano: PanoramaOut): EquirectangularMultiTilesPanorama {
  const tiles = pano.tiles;
  if (!tiles) throw new Error("panorama has no tiles yet");
  return {
    baseUrl: tiles.previewUrl,
    levels: tiles.levels.map(({ width, cols, rows }) => ({ width, cols, rows })),
    tileUrl: (col, row, level) => {
      const width = tiles.levels[level]?.width;
      return width ? `${tiles.baseUrl}/${width}/${row}_${col}.webp` : null;
    },
  };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function markers(doc: MapBundle, pano: PanoramaOut): MarkerConfig[] {
  const asPano = { ...pano, status: "ready" as const, tiles: pano.tiles ?? undefined };
  return panoTargets({ ...doc, panos: [] }, asPano)
    .filter((t) => t.kind === "poi")
    .map((t) => {
      const poi = doc.pois?.find((p) => p.id === t.id);
      return {
        id: t.id,
        position: { yaw: toRad(t.yaw), pitch: toRad(t.pitch) },
        html: `<span class="pano-pin">${categoryEmoji(poi?.category ?? "other")} ${escapeHtml(t.label)}</span>`,
        anchor: "bottom center",
      };
    });
}

export default function PanoPlacer({ pano, onClose }: { pano: PanoramaOut; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [hint, setHint] = useState("Кликните по полу у основания объекта — там появится точка");
  const category = useDraft((s) => s.poiCategory);
  const doc = useDraft((s) => s.doc);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the viewer is created once per panorama
  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;
    const viewer = new Viewer({
      container,
      adapter: EquirectangularTilesAdapter,
      panorama: tiled(pano),
      navbar: ["zoom", "move", "fullscreen"],
      loadingTxt: "Загрузка…",
      defaultZoomLvl: 20,
      plugins: [[MarkersPlugin, { markers: markers(useDraft.getState().doc, pano) }]],
    });
    viewerRef.current = viewer;
    viewer.addEventListener("click", ({ data }) => {
      if (data.rightclick || (data as { marker?: unknown }).marker) return;
      const yaw = toDeg(data.yaw);
      const pitch = toDeg(data.pitch);
      if (pitch > -3) {
        setHint("Нужен клик по полу: ниже горизонта, у основания стенда, двери или стойки");
        return;
      }
      const state = useDraft.getState();
      const pose = panoPose(state.doc, {
        ...pano,
        status: "ready",
        tiles: pano.tiles ?? undefined,
      });
      const xy = floorPointFromPano(pose, yaw, pitch);
      if (!xy) return;
      if (state.levelId !== pano.levelId) state.setLevel(pano.levelId);
      state.addPoi(fromLocal(state.doc.venue.anchor, xy));
      setHint(
        "Точка добавлена: переименуйте её в панели справа. Кликайте дальше — точки ставятся подряд",
      );
    });
    return () => {
      viewer.destroy();
      viewerRef.current = null;
    };
  }, [pano.id]);

  // New or moved points (this dialog, the plan, undo) show up in the panorama right away.
  useEffect(() => {
    viewerRef.current?.getPlugin<MarkersPlugin>(MarkersPlugin)?.setMarkers(markers(doc, pano));
  }, [doc, pano]);

  return (
    <div
      role="dialog"
      aria-modal
      aria-label="Точки в панораме"
      className="fixed inset-0 z-50 bg-black"
    >
      <div ref={hostRef} className="absolute inset-0" />
      <div className="safe-top pointer-events-none absolute inset-x-0 top-0 flex items-start gap-3 p-3">
        <p className="pointer-events-auto flex-1 rounded-2xl bg-slate-900/85 px-4 py-3 text-sm text-white shadow-xl backdrop-blur">
          {hint}
          <span className="mt-1 block text-xs text-white/60">
            Категория новых точек: {categoryEmoji(category)} — меняется в панели инструментов. Если
            подписи смещены по кругу, поправьте «Направление» панорамы.
          </span>
        </p>
        <Button
          variant="secondary"
          className="pointer-events-auto shadow-xl"
          onClick={onClose}
          aria-label="Закрыть"
        >
          <X className="size-5" />
          <span className="max-sm:hidden">Готово</span>
        </Button>
      </div>
    </div>
  );
}

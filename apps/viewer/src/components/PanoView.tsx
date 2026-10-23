// Loaded lazily: three.js + PSV stay out of the initial bundle.
import "@photo-sphere-viewer/core/index.css";
import "@photo-sphere-viewer/markers-plugin/index.css";
import { Viewer } from "@photo-sphere-viewer/core";
import {
  type EquirectangularMultiTilesPanorama,
  EquirectangularTilesAdapter,
} from "@photo-sphere-viewer/equirectangular-tiles-adapter";
import { GyroscopePlugin } from "@photo-sphere-viewer/gyroscope-plugin";
import { type MarkerConfig, MarkersPlugin } from "@photo-sphere-viewer/markers-plugin";
import type { Pano } from "@ttkpr/api-client";
import { type MapBundle, panoTargets, toRad } from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { useEffect, useRef, useState } from "react";

interface Props {
  bundle: MapBundle;
  pano: Pano;
  focusPoiId?: string;
  onSelectPoi: (id: string) => void;
  onSelectPano: (id: string) => void;
  onClose: () => void;
}

function tiledPanorama(pano: Pano): EquirectangularMultiTilesPanorama {
  const tiles = pano.tiles;
  if (!tiles) throw new Error(`Pano ${pano.id} has no tiles`);
  return {
    baseUrl: tiles.previewUrl,
    levels: tiles.levels.map(({ width, cols, rows }) => ({ width, cols, rows })),
    tileUrl: (col, row, level) => {
      const width = tiles.levels[level]?.width;
      return width ? `${tiles.baseUrl}/${width}/${row}_${col}.webp` : null;
    },
  };
}

function markersFor(bundle: MapBundle, pano: Pano): MarkerConfig[] {
  return panoTargets(bundle, pano).map((target) => ({
    id: `${target.kind}:${target.id}`,
    position: { yaw: toRad(target.yaw), pitch: toRad(target.pitch) },
    html:
      target.kind === "poi"
        ? `<span class="pano-marker">${escapeHtml(target.label)}</span>`
        : `<span class="pano-marker pano-marker--link">↑ ${escapeHtml(target.label)}</span>`,
    anchor: "center center",
    data: target,
  }));
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export default function PanoView({
  bundle,
  pano,
  focusPoiId,
  onSelectPoi,
  onSelectPano,
  onClose,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const handlers = useRef({ onSelectPoi, onSelectPano });
  handlers.current = { onSelectPoi, onSelectPano };
  const [gyro, setGyro] = useState(false);

  const shownPanoId = useRef(pano.id);

  const focusPosition = () => {
    const target = panoTargets(bundle, pano).find((t) => t.kind === "poi" && t.id === focusPoiId);
    return target ? { yaw: toRad(target.yaw), pitch: toRad(target.pitch) } : undefined;
  };

  // The viewer is created once; later pano/focus changes are applied by the effect below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only by design
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Create on the next frame: an immediate unmount (React StrictMode, fast close) then
    // cancels cleanly instead of aborting the first texture load mid-flight.
    const frame = requestAnimationFrame(() => {
      const initial = focusPosition();
      const viewer = new Viewer({
        container,
        adapter: EquirectangularTilesAdapter,
        panorama: tiledPanorama(pano),
        defaultYaw: initial?.yaw ?? 0,
        defaultPitch: initial?.pitch ?? 0,
        navbar: false,
        loadingTxt: "Загрузка…",
        touchmoveTwoFingers: false,
        plugins: [[MarkersPlugin, { markers: markersFor(bundle, pano) }], GyroscopePlugin],
      });
      viewerRef.current = viewer;
      shownPanoId.current = pano.id;
      if (import.meta.env.DEV) (window as unknown as { psv?: Viewer }).psv = viewer;

      const markers = viewer.getPlugin<MarkersPlugin>(MarkersPlugin);
      markers.addEventListener("select-marker", ({ marker }) => {
        const [kind, id] = marker.id.split(":");
        if (!id) return;
        if (kind === "poi") handlers.current.onSelectPoi(id);
        else handlers.current.onSelectPano(id);
      });
    });

    return () => {
      cancelAnimationFrame(frame);
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusPosition reads bundle/pano/focusPoiId
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const position = focusPosition();
    if (shownPanoId.current !== pano.id) {
      shownPanoId.current = pano.id;
      const markers = viewer.getPlugin<MarkersPlugin>(MarkersPlugin);
      void viewer
        .setPanorama(tiledPanorama(pano), { transition: true, position })
        .then(() => markers.setMarkers(markersFor(bundle, pano)));
    } else if (position && viewer.state.ready) {
      viewer.animate({ ...position, speed: "8rpm" });
    }
  }, [bundle, pano, focusPoiId]);

  const toggleGyro = async () => {
    const plugin = viewerRef.current?.getPlugin<GyroscopePlugin>(GyroscopePlugin);
    if (!plugin) return;
    if (!(await plugin.isSupported())) return;
    if (gyro) plugin.stop();
    else await plugin.start(); // iOS asks for motion permission here, inside the tap.
    setGyro(!gyro);
  };

  return (
    <div className="fixed inset-0 z-20 bg-black">
      <div ref={containerRef} className="absolute inset-0" />
      <div className="safe-top pointer-events-none absolute inset-x-0 top-0 flex justify-between px-4">
        <Button variant="secondary" className="pointer-events-auto shadow-lg" onClick={onClose}>
          ← К плану
        </Button>
        <Button
          variant={gyro ? "primary" : "secondary"}
          className="pointer-events-auto shadow-lg"
          onClick={toggleGyro}
          aria-pressed={gyro}
        >
          Гироскоп
        </Button>
      </div>
    </div>
  );
}

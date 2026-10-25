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
import {
  type MapBundle,
  panoTargets,
  type Route,
  routeOnFloor,
  toRad,
  yawAlongRoute,
} from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";

export interface RouteOverlay {
  route: Route;
  /** Look along the route on arrival instead of at the focused POI. */
  follow?: boolean;
  /** The panorama to go to next: its link is labelled "Дальше по маршруту". */
  nextPanoId?: string;
  destPoiId?: string;
}

interface Props {
  bundle: MapBundle;
  pano: Pano;
  focusPoiId?: string;
  /** Draws the route on the floor. */
  routeOverlay?: RouteOverlay;
  /** Extra controls over the panorama (walking a route). */
  children?: ReactNode;
  closeLabel?: string;
  onSelectPoi: (id: string) => void;
  onSelectPano: (id: string) => void;
  onClose: () => void;
}

// Looking slightly down on arrival keeps the route on the floor in view.
const FOLLOW_PITCH = toRad(-14);

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

function markersFor(bundle: MapBundle, pano: Pano, overlay?: RouteOverlay): MarkerConfig[] {
  const markers: MarkerConfig[] = [];
  if (overlay) {
    // Under the labels: a white casing and the blue line, like on the plan.
    routeOnFloor(bundle, overlay.route, pano).forEach((line, i) => {
      const polyline = line.map(([yaw, pitch]) => [toRad(yaw), toRad(pitch)] as [number, number]);
      for (const [layer, stroke, width] of [
        ["casing", "rgba(255, 255, 255, 0.85)", "18px"],
        ["line", "rgba(37, 99, 235, 0.9)", "10px"],
      ] as const) {
        markers.push({
          id: `route:${layer}:${i}`,
          polyline,
          svgStyle: {
            stroke,
            strokeWidth: width,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            fill: "none",
          },
        });
      }
    });
  }
  for (const target of panoTargets(bundle, pano)) {
    const next = target.kind === "pano" && target.id === overlay?.nextPanoId;
    const dest = target.kind === "poi" && target.id === overlay?.destPoiId;
    markers.push({
      id: `${target.kind}:${target.id}`,
      position: { yaw: toRad(target.yaw), pitch: toRad(target.pitch) },
      html:
        target.kind === "poi"
          ? `<span class="pano-marker${dest ? " pano-marker--dest" : ""}">${escapeHtml(target.label)}</span>`
          : `<span class="pano-marker pano-marker--link${next ? " pano-marker--next" : ""}">↑ ${next ? "Дальше по маршруту" : escapeHtml(target.label)}</span>`,
      anchor: "center center",
      zIndex: next || dest ? 10 : 1,
      data: target,
    });
  }
  return markers;
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export default function PanoView({
  bundle,
  pano,
  focusPoiId,
  routeOverlay,
  children,
  closeLabel = "← К плану",
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
    if (routeOverlay?.follow) {
      const yaw = yawAlongRoute(bundle, routeOverlay.route, pano);
      if (yaw !== null) return { yaw: toRad(yaw), pitch: FOLLOW_PITCH };
    }
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
        // A portrait phone gets a wider view; the default (50) feels like a zoomed-in tube.
        defaultZoomLvl: container.clientHeight > container.clientWidth ? 10 : 50,
        navbar: false,
        loadingTxt: "Загрузка…",
        touchmoveTwoFingers: false,
        plugins: [
          [MarkersPlugin, { markers: markersFor(bundle, pano, routeOverlay) }],
          GyroscopePlugin,
        ],
      });
      viewerRef.current = viewer;
      shownPanoId.current = pano.id;
      if (import.meta.env.DEV) (window as unknown as { psv?: Viewer }).psv = viewer;

      const markers = viewer.getPlugin<MarkersPlugin>(MarkersPlugin);
      markers.addEventListener("select-marker", ({ marker }) => {
        const [kind, id] = marker.id.split(":");
        if (!id) return;
        if (kind === "poi") handlers.current.onSelectPoi(id);
        else if (kind === "pano") handlers.current.onSelectPano(id);
      });
    });

    return () => {
      cancelAnimationFrame(frame);
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, []);

  const { route, follow, nextPanoId, destPoiId } = routeOverlay ?? {};
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusPosition and the overlay read these
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const position = focusPosition();
    const markers = viewer.getPlugin<MarkersPlugin>(MarkersPlugin);
    if (shownPanoId.current !== pano.id) {
      shownPanoId.current = pano.id;
      viewer
        .setPanorama(tiledPanorama(pano), { transition: true, position })
        .then(() => markers.setMarkers(markersFor(bundle, pano, routeOverlay)))
        .catch(() => {}); // superseded by a newer panorama (fast "Дальше")
    } else {
      markers.setMarkers(markersFor(bundle, pano, routeOverlay));
      if (position && viewer.state.ready) viewer.animate({ ...position, speed: "8rpm" });
    }
  }, [bundle, pano, focusPoiId, route, follow, nextPanoId, destPoiId]);

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
          {closeLabel}
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
      {children}
    </div>
  );
}

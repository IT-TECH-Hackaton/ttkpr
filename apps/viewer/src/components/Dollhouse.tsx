// "Макет": a 3D model of the floor built from the plan and the photos. Walls and floors of rooms
// that have a panorama are textured with it — every fragment looks up the colour the camera saw
// in that direction (equirect lookup from the pano's position, heading and height). Rooms without
// a panorama stay plain. Orbit with a finger or the mouse; tap a textured room to step inside.
// Loaded lazily with three.js.

import type { Pano } from "@ttkpr/api-client";
import { type MapBundle, panoPose, plural, toLocal, wallSegments, type XY } from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  DirectionalLight,
  type Material,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const WALL_H = 2.6;
const WALL_T = 0.12;

interface Props {
  bundle: MapBundle;
  levelId: string;
  dark: boolean;
  onOpenPano: (id: string) => void;
  onClose: () => void;
}

/** The panorama as one equirect canvas from its tiles (≤ 2048 px wide), for texturing. */
async function equirect(pano: Pano): Promise<HTMLCanvasElement | null> {
  const tiles = pano.tiles;
  if (!tiles) return null;
  const level = [...tiles.levels]
    .filter((l) => l.width <= 2048)
    .sort((a, b) => b.width - a.width)[0];
  if (!level) return null;
  const canvas = document.createElement("canvas");
  canvas.width = level.width;
  canvas.height = level.width / 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const size = level.width / level.cols;
  const jobs: Promise<void>[] = [];
  for (let row = 0; row < level.rows; row++) {
    for (let col = 0; col < level.cols; col++) {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.src = `${tiles.baseUrl}/${level.width}/${row}_${col}.webp`;
      jobs.push(
        image
          .decode()
          .then(() => ctx.drawImage(image, col * size, row * size, size, size))
          .catch(() => {}),
      );
    }
  }
  await Promise.all(jobs);
  return canvas;
}

// Scene axes: x = east, y = up, z = south (local plan y negated).
const VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 camera0;
  uniform float heading;
  varying vec3 vWorld;
  const float PI = 3.141592653589793;
  void main() {
    vec3 d = vWorld - camera0;
    float east = d.x, north = -d.z, up = d.y;
    float yaw = atan(east, north) - heading;          // clockwise from the image centre
    yaw = mod(yaw + PI, 2.0 * PI) - PI;
    float pitch = atan(up, length(vec2(east, north)));
    vec2 uv = vec2(0.5 + yaw / (2.0 * PI), 0.5 + pitch / PI);
    gl_FragColor = vec4(texture2D(map, uv).rgb, 1.0);
    #include <colorspace_fragment>
  }
`;

function insideRing([x, y]: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as XY;
    const [xj, yj] = ring[j] as XY;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export default function Dollhouse({ bundle, levelId, dark, onOpenPano, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [textured, setTextured] = useState(0);
  const [rooms, setRooms] = useState(0);
  // Latest callback without rebuilding the scene on every parent render.
  const openRef = useRef(onOpenPano);
  openRef.current = onOpenPano;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const renderer = new WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(dark ? "#0b0f17" : "#eef1f5");
    host.appendChild(renderer.domElement);

    const scene = new Scene();
    scene.add(new AmbientLight("#ffffff", dark ? 1.2 : 1.6));
    const sun = new DirectionalLight("#ffffff", 1.4);
    sun.position.set(20, 40, 25);
    scene.add(sun);

    const anchor = bundle.venue.anchor;
    const toScene = ([x, y]: XY, h = 0) => new Vector3(x, h, -y);
    const units = (bundle.units ?? [])
      .filter((u) => u.levelId === levelId)
      .map((u) => ({
        unit: u,
        ring: (u.geometry.coordinates[0] ?? []).map((c) => toLocal(anchor, c as XY)),
      }));
    const panos = (bundle.panos ?? []).filter(
      (p) => p.levelId === levelId && p.status === "ready" && p.tiles,
    );
    // A room is textured by the panorama shot inside it.
    const panoOf = new Map<string, Pano>();
    for (const { unit, ring } of units) {
      const pano = panos.find((p) => insideRing(toLocal(anchor, p.position), ring));
      if (pano) panoOf.set(unit.id, pano);
    }

    const plain = (color: string, opacity = 1) =>
      new MeshStandardMaterial({ color, roughness: 0.85, transparent: opacity < 1, opacity });
    const wallPlain = plain(dark ? "#64748b" : "#ffffff", 0.92);
    const floorPlain = plain(dark ? "#1f2937" : "#e2e8f0");
    const byUnit = new Map<string, Mesh[]>();
    const add = (unitId: string, mesh: Mesh) => {
      scene.add(mesh);
      byUnit.set(unitId, [...(byUnit.get(unitId) ?? []), mesh]);
    };

    for (const { unit, ring } of units) {
      const shape = new Shape(ring.map(([x, y]) => new Vector2(x, y)));
      const floor = new Mesh(new ShapeGeometry(shape).rotateX(-Math.PI / 2), floorPlain);
      floor.userData = { unitId: unit.id };
      add(unit.id, floor);
    }
    const ringOf = new Map(units.map((u) => [u.unit.id, u.ring]));
    for (const { unitId, a, b } of wallSegments(bundle, levelId)) {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 0.05) continue;
      // Walls sit just inside their room: a wall shared by two rooms becomes two thin layers,
      // each showing its own room's photo.
      const wall = new Mesh(new BoxGeometry(length, WALL_H, WALL_T), wallPlain);
      const m: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const n: XY = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
      const ring = ringOf.get(unitId) ?? [];
      const inward = insideRing([m[0] + n[0] * 0.3, m[1] + n[1] * 0.3], ring) ? 1 : -1;
      const off = (WALL_T / 2 + 0.01) * inward;
      const mid = toScene([m[0] + n[0] * off, m[1] + n[1] * off], WALL_H / 2);
      wall.position.copy(mid);
      wall.rotation.y = Math.atan2(b[1] - a[1], b[0] - a[0]);
      wall.userData = { unitId };
      add(unitId, wall);
    }

    // Frame the floor.
    const xs = units.flatMap((u) => u.ring.map((p) => p[0]));
    const ys = units.flatMap((u) => u.ring.map((p) => p[1]));
    const center = toScene([
      (Math.min(...xs) + Math.max(...xs)) / 2,
      (Math.min(...ys) + Math.max(...ys)) / 2,
    ]);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 10);
    const camera = new PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.copy(center).add(new Vector3(span * 0.25, span * 0.9, span * 0.9));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.minDistance = 4;
    controls.maxDistance = span * 3;

    setTextured(0);
    setRooms(panoOf.size);
    // Photo textures, room by room as their tiles arrive.
    for (const [unitId, pano] of panoOf) {
      void equirect(pano).then((canvas) => {
        if (!canvas || disposed) return;
        const texture = new CanvasTexture(canvas);
        texture.colorSpace = SRGBColorSpace;
        const pose = panoPose(bundle, pano);
        const material = new ShaderMaterial({
          uniforms: {
            map: { value: texture },
            camera0: { value: toScene(pose.xy, pose.cameraHeightM) },
            heading: { value: (pose.headingDeg * Math.PI) / 180 },
          },
          vertexShader: VERTEX,
          fragmentShader: FRAGMENT,
        });
        for (const mesh of byUnit.get(unitId) ?? []) mesh.material = material;
        setTextured((n) => n + 1);
      });
    }

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    // Tap a photographed room: step into its panorama.
    const raycaster = new Raycaster();
    let downAt: [number, number] | null = null;
    const onDown = (e: PointerEvent) => {
      downAt = [e.clientX, e.clientY];
    };
    const onUp = (e: PointerEvent) => {
      if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
      const rect = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(
        new Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      const hit = raycaster.intersectObjects(scene.children)[0];
      const pano = hit ? panoOf.get(hit.object.userData.unitId as string) : undefined;
      if (pano) openRef.current(pano.id);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    let frame = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      scene.traverse((object) => {
        const mesh = object as Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as Material | undefined;
        material?.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [bundle, levelId, dark]);

  return (
    <div role="dialog" aria-modal aria-label="3D-макет этажа" className="fixed inset-0 z-30 bg-bg">
      <div ref={hostRef} className="absolute inset-0 touch-none" />
      <div className="safe-top pointer-events-none absolute inset-x-0 top-0 flex items-start gap-3 px-4">
        <div className="pointer-events-auto flex-1 rounded-2xl border border-border bg-bg/90 px-4 py-3 text-sm shadow-lg backdrop-blur">
          <p className="font-semibold">3D-макет этажа</p>
          <p className="text-muted">
            {rooms
              ? `Стены и пол комнат с панорамами — из фотографий (${plural(textured, ["комната", "комнаты", "комнат"])} из ${rooms}). Нажмите на такую комнату, чтобы войти в панораму.`
              : "На этом этаже ещё нет панорам: модель построена по плану."}
          </p>
        </div>
        <Button
          variant="secondary"
          className="pointer-events-auto shadow-lg"
          onClick={onClose}
          aria-label="Закрыть макет"
        >
          <X className="size-5" />
        </Button>
      </div>
      <p className="safe-bottom pointer-events-none absolute inset-x-0 bottom-0 pb-3 text-center text-xs text-muted">
        Вращайте одним пальцем, масштаб — двумя
      </p>
    </div>
  );
}

// Animated 3D hero for the sign-in page and the visitor landing: the demo venue assembles itself —
// floors slide in, walls grow, the organizer's tour is drawn through both floors and the yard,
// pins bob over the places and panorama bubbles glow. Loaded lazily (three.js stays out of the
// first bundle); static when the user prefers reduced motion; paused off-screen.

import { useEffect, useRef } from "react";
import {
  AdditiveBlending,
  BoxGeometry,
  type BufferGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  DirectionalLight,
  EdgesGeometry,
  Fog,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  SRGBColorSpace,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { DOORS, PANOS, POIS, TOUR_PATH, UNITS } from "./scene-data";

const FLOOR_GAP = 11;
const WALL_H = 2.4;
const WALL_T = 0.18;

const FLOOR_COLORS: Record<string, [string, string]> = {
  // [light, dark]
  hall: ["#dbe7ff", "#22345a"],
  room: ["#e8eef7", "#26324a"],
  corridor: ["#f4f5f7", "#2a2f3a"],
  lobby: ["#fdf0d2", "#4a3d22"],
  restroom: ["#dff3ec", "#20403a"],
  stairs: ["#ebe4fb", "#352c52"],
  elevator: ["#ebe4fb", "#352c52"],
  outdoor: ["#e3f1dc", "#23402a"],
};

/** Local plan meters -> scene: x east, z south, y up; centred on the venue. */
const CENTER = (() => {
  const xs = UNITS.flatMap((u) => u.r.map((p) => p[0]));
  const ys = UNITS.flatMap((u) => u.r.map((p) => p[1]));
  return [
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
  ] as const;
})();
const at = ([x, y]: [number, number], h = 0) => new Vector3(x - CENTER[0], h, -(y - CENTER[1]));

const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

function wallsOf(ring: [number, number][], l: number, material: Material): Mesh[] {
  const meshes: Mesh[] = [];
  const doors = DOORS.filter((d) => d.l === l);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as [number, number];
    const b = ring[(i + 1) % ring.length] as [number, number];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.2) continue;
    // Leave the door gaps open so the plan reads as rooms with passages.
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    const gaps = doors
      .filter((d) => {
        const off = (p: [number, number]) => Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux);
        return off(d.a) < 0.4 && off(d.b) < 0.4;
      })
      .map((d) => {
        const t = (p: [number, number]) => (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
        return [Math.min(t(d.a), t(d.b)), Math.max(t(d.a), t(d.b))] as const;
      })
      .sort((x, y) => x[0] - y[0]);
    let cursor = 0;
    for (const [s, e] of [...gaps, [len, len] as const]) {
      if (s - cursor > 0.15) {
        const mid = (cursor + s) / 2;
        const piece = new Mesh(new BoxGeometry(s - cursor, WALL_H, WALL_T), material);
        piece.position.copy(at([a[0] + ux * mid, a[1] + uy * mid], WALL_H / 2));
        piece.rotation.y = Math.atan2(uy, ux);
        meshes.push(piece);
      }
      cursor = Math.max(cursor, e);
    }
  }
  return meshes;
}

interface Props {
  dark?: boolean;
  className?: string;
  /**
   * Height the camera aims at, for narrow (portrait) and wide frames: higher puts the venue lower
   * in the picture. Defaults suit a hero with text above the scene.
   */
  aim?: { narrow: number; wide: number };
}

export default function Hero3D({ dark = true, className, aim = { narrow: 26, wide: -8 } }: Props) {
  const { narrow: aimNarrow, wide: aimWide } = aim;
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pick = (pair: [string, string]) => (dark ? pair[1] : pair[0]);
    const accent = new Color(dark ? "#60a5fa" : "#2563eb");

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    } catch {
      return; // no WebGL: the gradient behind stays, which is fine
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.domElement.style.display = "block";
    host.appendChild(renderer.domElement);

    const scene = new Scene();
    // Fog only softens the far side of the venue (the camera is ~110 m away).
    scene.fog = new Fog(dark ? "#0b1220" : "#eef2ff", 120, 230);
    const camera = new PerspectiveCamera(32, 1, 0.5, 400);
    scene.add(
      new HemisphereLight(
        dark ? "#c7d2fe" : "#ffffff",
        dark ? "#0b1220" : "#cbd5e1",
        dark ? 1.4 : 1.8,
      ),
    );
    const sun = new DirectionalLight("#ffffff", dark ? 1.8 : 2.2);
    sun.position.set(25, 50, 20);
    scene.add(sun);

    const wallMaterial = new MeshStandardMaterial({
      color: dark ? "#94a3b8" : "#ffffff",
      roughness: 0.6,
      transparent: true,
      opacity: dark ? 0.85 : 0.95,
    });
    const edgeMaterial = new LineBasicMaterial({ color: dark ? "#334155" : "#94a3b8" });

    // Floors: slabs + walls per level, animated in from below / above.
    // The upper floor is see-through, so the ground floor and the yard stay readable under it.
    const upperWalls = wallMaterial.clone();
    upperWalls.opacity = 0.45;
    const floors = [0, 1].map((l) => {
      const group = new Group();
      const walls: Mesh[] = [];
      for (const unit of UNITS.filter((u) => u.l === l)) {
        // Shapes live in the XY plane; rotated flat, (x, y) lands on (x, 0, -y).
        const shape = new Shape(unit.r.map((p) => at(p)).map((v) => new Vector2(v.x, -v.z)));
        const slab = new Mesh(
          new ShapeGeometry(shape).rotateX(-Math.PI / 2),
          new MeshStandardMaterial({
            color: pick(FLOOR_COLORS[unit.c] ?? ["#eeeeee", "#2a2f3a"]),
            roughness: 0.9,
            transparent: l === 1,
            opacity: l === 1 ? 0.6 : 1,
          }),
        );
        group.add(slab);
        if (unit.c === "outdoor") continue;
        for (const wall of wallsOf(unit.r, l, l === 1 ? upperWalls : wallMaterial)) {
          const edges = new LineSegments(new EdgesGeometry(wall.geometry), edgeMaterial);
          wall.add(edges);
          walls.push(wall);
          group.add(wall);
        }
      }
      scene.add(group);
      return { group, walls, level: l };
    });

    // The tour: a glowing tube through both floors, drawn progressively, and a walker on it.
    const points = TOUR_PATH.map((n) => at(n.p, n.l * FLOOR_GAP + 0.35));
    const curve = new CatmullRomCurve3(points, false, "centripetal", 0.2);
    const tubeGeometry = new TubeGeometry(curve, 600, 0.28, 10, false);
    const halo = new Mesh(
      new TubeGeometry(curve, 600, 0.75, 10, false),
      new MeshBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.18,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    const tube = new Mesh(tubeGeometry, new MeshBasicMaterial({ color: accent }));
    const indexCount = tubeGeometry.index?.count ?? 0;
    scene.add(tube, halo);
    const walker = new Mesh(
      new SphereGeometry(0.75, 24, 16),
      new MeshBasicMaterial({ color: "#ffffff" }),
    );
    const walkerGlow = new Mesh(
      new SphereGeometry(1.6, 24, 16),
      new MeshBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.3,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    walker.add(walkerGlow);
    scene.add(walker);

    // Pins over places, glowing bubbles at panoramas.
    const pinMaterial = new MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 0.35,
    });
    const pins = POIS.map((poi, i) => {
      const pin = new Group();
      const head = new Mesh(new SphereGeometry(0.55, 20, 14), pinMaterial);
      head.position.y = 1.15;
      const tip = new Mesh(new ConeGeometry(0.42, 1, 16), pinMaterial);
      tip.rotation.x = Math.PI;
      tip.position.y = 0.5;
      pin.add(head, tip);
      pin.position.copy(at(poi.p, WALL_H + 0.4));
      floors[poi.l]?.group.add(pin); // pins and bubbles ride with their floor
      return { pin, base: pin.position.y, phase: i * 0.7 };
    });
    const bubbles = PANOS.map((pano) => {
      const bubble = new Mesh(
        new SphereGeometry(1.1, 32, 20),
        new MeshStandardMaterial({
          color: "#5eead4",
          emissive: "#14b8a6",
          emissiveIntensity: 0.6,
          transparent: true,
          opacity: 0.55,
        }),
      );
      bubble.position.copy(at(pano.p, 1.4));
      floors[pano.l]?.group.add(bubble);
      return bubble;
    });

    let narrow = false;
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / h;
      // Narrow (phone) hero: pull back so the whole venue fits.
      camera.fov = w / h < 1 ? 50 : 30;
      narrow = w / h < 1;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const pointer = { x: 0, y: 0 };
    const onPointer = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      pointer.y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    };
    window.addEventListener("pointermove", onPointer);

    let visible = true;
    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    io.observe(host);

    const start = performance.now();
    let frame = 0;
    const render = (now: number) => {
      const t = still ? 8 : (now - start) / 1000;
      // Intro: floors arrive (0–1.6 s), walls grow (0.6–2.2 s), the route is drawn (2–5 s).
      for (const f of floors) {
        const k = ease((t - f.level * 0.35) / 1.6);
        const target = f.level * FLOOR_GAP + (f.level === 1 ? Math.sin(t * 0.8) * 0.35 : 0);
        f.group.position.y = target + (f.level === 0 ? -12 : 18) * (1 - k);
        f.walls.forEach((w, i) => {
          const g = ease((t - 0.6 - f.level * 0.3 - (i % 12) * 0.03) / 0.9);
          w.scale.y = Math.max(0.001, g);
          w.position.y = (WALL_H / 2) * g;
        });
      }
      const drawn = ease((t - 2) / 3);
      tubeGeometry.setDrawRange(0, Math.floor((indexCount * drawn) / 3) * 3);
      halo.geometry.setDrawRange(
        0,
        Math.floor(((halo.geometry.index?.count ?? 0) * drawn) / 3) * 3,
      );
      const walk = t < 5 ? drawn : ((t - 5) / 14) % 1;
      walker.position.copy(curve.getPointAt(walk));
      walker.position.y += 0.4;
      walkerGlow.scale.setScalar(1 + Math.sin(t * 4) * 0.15);
      for (const p of pins) p.pin.position.y = p.base + Math.sin(t * 1.8 + p.phase) * 0.3;
      bubbles.forEach((b, i) => {
        b.rotation.y = t * 0.6 + i;
        b.scale.setScalar(1 + Math.sin(t * 2 + i) * 0.06);
      });

      const angle = -0.9 + t * 0.06 + pointer.x * 0.12;
      // Look a little below the venue: it sits in the upper part of the frame, above the cards.
      const radius = narrow ? 100 : 108;
      camera.position.set(
        Math.cos(angle) * radius,
        (narrow ? 62 : 70) - pointer.y * 4,
        Math.sin(angle) * radius,
      );
      camera.lookAt(0, narrow ? aimNarrow : aimWide, 0);
      renderer.render(scene, camera);
      if (!still) frame = requestAnimationFrame(loop);
    };
    const loop = (now: number) => {
      if (!visible || document.hidden) {
        frame = requestAnimationFrame(loop);
        return;
      }
      render(now);
    };
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      io.disconnect();
      window.removeEventListener("pointermove", onPointer);
      scene.traverse((object: Object3D) => {
        const mesh = object as Mesh;
        (mesh.geometry as BufferGeometry | undefined)?.dispose();
        const material = mesh.material as Material | Material[] | undefined;
        for (const m of Array.isArray(material) ? material : material ? [material] : [])
          m.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [dark, aimNarrow, aimWide]);

  return <div ref={hostRef} className={className} aria-hidden />;
}

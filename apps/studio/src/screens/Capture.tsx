import type { PanoramaOut } from "@ttkpr/api-client";
import {
  angleBetween,
  assumedFocal,
  assumedFov,
  type CaptureTarget,
  cameraRotation,
  captureTargets,
  direction,
  forward,
  type Mat3,
  toCamera,
  toQuaternion,
  yawPitch,
} from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { captureFetch } from "../lib/api";
import { CaptureQueue, type CaptureSession, type QueueState } from "../lib/captureQueue";
import { captureFrames, captureSessions, captureTransport } from "../lib/captureStore";

type Phase = "intro" | "capturing" | "finishing" | "processing" | "done" | "error";

const ALIGN_DEG = 3.5; // how close the reticle must be to the target
const STEADY_DEG_PER_S = 8; // max rotation speed while shooting (motion blur)
const STEADY_MS = 250;
const MIN_FRAMES_TO_FINISH = 8;

interface OrientationLike {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  webkitCompassHeading?: number;
}

function useHashParams() {
  return useMemo(() => {
    const p = new URLSearchParams(location.hash.slice(1));
    const at = p.get("at")?.split(",").map(Number);
    return {
      token: p.get("t") ?? undefined,
      levelId: p.get("level") ?? undefined,
      position:
        at && at.length === 2 && at.every(Number.isFinite) ? (at as [number, number]) : undefined,
    };
  }, []);
}

export function CaptureScreen({ mapId }: { mapId: string }) {
  const { token, levelId, position } = useHashParams();
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>("intro");
  const [error, setError] = useState<string | null>(null);
  const [doneIds, setDoneIds] = useState<Set<number>>(new Set());
  const [pano, setPano] = useState<PanoramaOut | null>(null);
  const [queueState, setQueueState] = useState<QueueState | null>(null);
  const [unsent, setUnsent] = useState<{ session: CaptureSession; pendingFrames: number }[]>([]);
  const [portrait, setPortrait] = useState(true);
  const targets = useMemo(() => captureTargets(), []);

  // Mutable capture state lives in refs: the render loop runs outside React.
  const rotation = useRef<Mat3 | null>(null);
  const compass = useRef<number | null>(null);
  const startYaw = useRef<number | null>(null);
  const speed = useRef(0);
  const lastOrientationAt = useRef(0);
  const steadySince = useRef(0);
  const shooting = useRef(false);
  const done = useRef(new Set<number>());
  const shotCount = useRef(0);
  const queueRef = useRef<CaptureQueue | null>(null);
  const tokenRef = useRef(token);
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => {
    const check = () => setPortrait(window.innerHeight >= window.innerWidth);
    check();
    window.addEventListener("resize", check);
    // Back online: push queued frames right away instead of waiting for the next retry.
    const online = () => queueRef.current?.retryNow();
    window.addEventListener("online", online);
    void CaptureQueue.unfinished(captureSessions, captureFrames, mapId).then(setUnsent);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("online", online);
      stopRef.current();
    };
  }, [mapId]);

  // Queue -> screen: stitching started on the server, or a definitive upload error.
  useEffect(() => {
    if (!queueState) return;
    if (queueState.error) {
      stopRef.current();
      setError(queueState.error);
      setPhase("error");
    } else if (queueState.stitchingStarted && queueState.panoId) {
      setPhase((p) => (p === "finishing" ? "processing" : p));
    }
  }, [queueState]);

  // Poll the server while the panorama is being stitched.
  useEffect(() => {
    const id = queueState?.panoId;
    if (phase !== "processing" || !id) return;
    let alive = true;
    const poll = async () => {
      while (alive) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const current = await captureFetch<PanoramaOut>(
            `/api/panoramas/${id}`,
            {},
            tokenRef.current,
          );
          if (!alive) return;
          setPano(current);
          if (current.status === "ready") return setPhase("done");
          if (current.status === "failed") {
            setError(current.error ?? "Не удалось склеить панораму");
            return setPhase("error");
          }
        } catch {
          // Offline while waiting: keep polling, the stitching continues on the server.
        }
      }
    };
    void poll();
    return () => {
      alive = false;
    };
  }, [phase, queueState?.panoId]);

  const resumeFromAnywhere = async ({ session }: { session: CaptureSession }) => {
    tokenRef.current = session.token;
    const queue = new CaptureQueue(
      session,
      captureSessions,
      captureFrames,
      captureTransport,
      setQueueState,
    );
    queueRef.current = queue;
    setPhase("finishing");
    await queue.start();
    await queue.finish();
  };
  const discardFromAnywhere = async ({ session }: { session: CaptureSession }) => {
    await new CaptureQueue(session, captureSessions, captureFrames, captureTransport).discard();
    setUnsent(await CaptureQueue.unfinished(captureSessions, captureFrames, mapId));
  };

  if ((!levelId || !position) && phase === "intro") {
    return (
      <main className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 px-4 text-center">
        <h1 className="text-2xl font-semibold">Съёмка панорамы</h1>
        <p className="text-muted">
          Откройте эту страницу по QR-коду из редактора: там выбирается точка на плане, где вы
          будете снимать.
        </p>
        <UnsentCaptures
          items={unsent}
          onSend={resumeFromAnywhere}
          onDiscard={discardFromAnywhere}
        />
      </main>
    );
  }

  const queueFor = async (width: number, height: number): Promise<CaptureQueue> => {
    if (queueRef.current) return queueRef.current;
    if (!levelId || !position) throw new Error("Не выбрана точка съёмки");
    const session: CaptureSession = {
      key: crypto.randomUUID(),
      mapId,
      levelId,
      position,
      token,
      headingDeg: compass.current ?? undefined,
      fovDeg: assumedFov(width, height),
      frameCount: targets.length,
      device: navigator.userAgent.slice(0, 300),
      createdAt: Date.now(),
      finished: false,
      stitched: false,
    };
    const created = new CaptureQueue(
      session,
      captureSessions,
      captureFrames,
      captureTransport,
      setQueueState,
    );
    queueRef.current = created;
    await created.start();
    return created;
  };

  const shoot = async (target: CaptureTarget) => {
    const video = videoRef.current;
    const r = rotation.current;
    if (!video || !r || shooting.current) return;
    shooting.current = true;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.9),
      );
      if (!blob) return;
      done.current.add(target.id);
      setDoneIds(new Set(done.current));
      navigator.vibrate?.(25);
      // Saved on the phone first; uploaded when the network allows.
      const queue = await queueFor(canvas.width, canvas.height);
      await queue.add(shotCount.current++, blob, {
        quaternion: toQuaternion(r),
        width: canvas.width,
        height: canvas.height,
        timestampMs: performance.now(),
      });
      if (done.current.size === targets.length) void finish();
    } finally {
      shooting.current = false;
    }
  };

  const fail = (message: string) => {
    stopRef.current();
    setError(message);
    setPhase("error");
  };

  const start = async () => {
    setError(null);
    try {
      const DOE = DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<string>;
      };
      if (
        typeof DOE.requestPermission === "function" &&
        (await DOE.requestPermission()) !== "granted"
      ) {
        throw new Error("Нужен доступ к датчикам движения — разрешите его в настройках браузера");
      }
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Камера доступна только по HTTPS");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1440 },
          aspectRatio: { ideal: 4 / 3 },
        },
      });
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();

      const onOrientation = (e: Event) => {
        const o = e as unknown as OrientationLike;
        if (o.alpha === null || o.beta === null || o.gamma === null) return;
        const next = cameraRotation(o.alpha, o.beta, o.gamma);
        const now = performance.now();
        if (rotation.current) {
          const dt = Math.max(1, now - lastOrientationAt.current) / 1000;
          const deg = angleBetween(forward(rotation.current), forward(next));
          speed.current = speed.current * 0.7 + (deg / dt) * 0.3;
        }
        lastOrientationAt.current = now;
        rotation.current = next;
        if (startYaw.current === null) startYaw.current = yawPitch(forward(next)).yaw;
        if (typeof o.webkitCompassHeading === "number") compass.current = o.webkitCompassHeading;
      };
      const onAbsolute = (e: Event) => {
        const o = e as unknown as OrientationLike;
        if (o.alpha === null || o.beta === null || o.gamma === null) return;
        compass.current =
          (yawPitch(forward(cameraRotation(o.alpha, o.beta, o.gamma))).yaw + 360) % 360;
      };
      window.addEventListener("deviceorientation", onOrientation);
      window.addEventListener("deviceorientationabsolute", onAbsolute);
      const wakeLock = await navigator.wakeLock?.request("screen").catch(() => undefined);

      let frame = 0;
      stopRef.current = () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("deviceorientation", onOrientation);
        window.removeEventListener("deviceorientationabsolute", onAbsolute);
        for (const track of stream.getTracks()) track.stop();
        void wakeLock?.release();
      };

      const started = performance.now();
      const loop = () => {
        frame = requestAnimationFrame(loop);
        if (!rotation.current) {
          if (performance.now() - started > 3000)
            fail("Гироскоп не отвечает — на этом устройстве съёмка недоступна");
          return;
        }
        draw();
      };
      setPhase("capturing");
      frame = requestAnimationFrame(loop);
    } catch (e) {
      fail(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Нет доступа к камере — разрешите его и попробуйте снова"
          : e instanceof Error
            ? e.message
            : "Не удалось запустить камеру",
      );
    }
  };

  const draw = () => {
    const canvas = overlayRef.current;
    const video = videoRef.current;
    const r = rotation.current;
    if (!canvas || !video || !r || startYaw.current === null || !video.videoWidth) return;
    const w = canvas.clientWidth * devicePixelRatio;
    const h = canvas.clientHeight * devicePixelRatio;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cover = Math.max(w / video.videoWidth, h / video.videoHeight);
    const f = assumedFocal(video.videoWidth, video.videoHeight) * cover;
    const look = forward(r);

    let nearest: { target: CaptureTarget; angle: number; cam: [number, number, number] } | null =
      null;
    for (const target of targets) {
      const dir = direction(startYaw.current + target.yaw, target.pitch);
      const cam = toCamera(r, dir);
      const isDone = done.current.has(target.id);
      if (!isDone) {
        const angle = angleBetween(look, dir);
        if (!nearest || angle < nearest.angle) nearest = { target, angle, cam };
      }
      if (cam[2] <= 0.05) continue;
      const x = w / 2 + (f * cam[0]) / cam[2];
      const y = h / 2 + (f * cam[1]) / cam[2];
      ctx.beginPath();
      ctx.arc(x, y, (isDone ? 10 : 26) * devicePixelRatio, 0, Math.PI * 2);
      if (isDone) {
        ctx.fillStyle = "rgba(16,185,129,0.85)";
        ctx.fill();
      } else {
        ctx.lineWidth = 4 * devicePixelRatio;
        ctx.strokeStyle = nearest?.target.id === target.id ? "#facc15" : "rgba(255,255,255,0.9)";
        ctx.stroke();
      }
    }

    // Reticle.
    ctx.lineWidth = 3 * devicePixelRatio;
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 18 * devicePixelRatio, 0, Math.PI * 2);
    ctx.stroke();

    if (!nearest) return;
    const visible =
      nearest.cam[2] > 0.05 &&
      Math.abs((f * nearest.cam[0]) / nearest.cam[2]) < w / 2 &&
      Math.abs((f * nearest.cam[1]) / nearest.cam[2]) < h / 2;
    if (!visible) {
      // Arrow towards the next target.
      const len = Math.hypot(nearest.cam[0], nearest.cam[1]) || 1;
      const dx = nearest.cam[0] / len;
      const dy = nearest.cam[1] / len;
      const ax = w / 2 + dx * Math.min(w, h) * 0.3;
      const ay = h / 2 + dy * Math.min(w, h) * 0.3;
      ctx.fillStyle = "#facc15";
      ctx.beginPath();
      ctx.moveTo(ax + dx * 30 * devicePixelRatio, ay + dy * 30 * devicePixelRatio);
      ctx.lineTo(ax - dy * 16 * devicePixelRatio, ay + dx * 16 * devicePixelRatio);
      ctx.lineTo(ax + dy * 16 * devicePixelRatio, ay - dx * 16 * devicePixelRatio);
      ctx.fill();
    }

    const steady = speed.current < STEADY_DEG_PER_S;
    if (nearest.angle < ALIGN_DEG && steady && window.innerHeight >= window.innerWidth) {
      if (!steadySince.current) steadySince.current = performance.now();
      if (performance.now() - steadySince.current > STEADY_MS) {
        steadySince.current = 0;
        void shoot(nearest.target);
      }
    } else {
      steadySince.current = 0;
    }
  };

  const finish = async () => {
    stopRef.current();
    setPhase("finishing");
    if (!queueRef.current) return fail("Нет снятых кадров");
    await queueRef.current.finish();
  };

  const resume = resumeFromAnywhere;
  const discard = discardFromAnywhere;

  const shots = doneIds.size;

  return (
    <div className="fixed inset-0 overflow-hidden bg-black text-white">
      <video
        ref={videoRef}
        playsInline
        muted
        className="absolute inset-0 h-full w-full object-cover"
      />
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />

      {phase === "capturing" && (
        <>
          <div className="safe-top absolute inset-x-0 top-0 space-y-1 bg-gradient-to-b from-black/70 to-transparent px-4 pb-6 text-center">
            <p className="text-lg font-semibold">
              {shots} / {targets.length}
            </p>
            <p className="text-sm text-white/80">
              Наведите белый круг на жёлтую цель и замрите — кадр снимется сам. Вращайте телефон
              вокруг камеры, не сходя с места.
            </p>
            {queueState?.waitingForNetwork && (
              <p className="mx-auto w-fit rounded-lg bg-amber-300/90 px-3 py-1 text-sm text-amber-950">
                Нет сети — снимайте дальше, кадры сохраняются на телефоне
              </p>
            )}
          </div>
          <div className="safe-bottom absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-black/70 to-transparent px-4 pt-10">
            <CoverageMap targets={targets} done={doneIds} />
            <Button disabled={shots < MIN_FRAMES_TO_FINISH} onClick={() => void finish()}>
              Завершить
            </Button>
          </div>
          {!portrait && (
            <div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center text-lg">
              Поверните телефон вертикально
            </div>
          )}
        </>
      )}

      {phase !== "capturing" && (
        <div className="absolute inset-0 overflow-y-auto bg-black/85">
          <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-5 px-5 py-10">
            {phase === "intro" && (
              <>
                <h1 className="text-2xl font-semibold">Съёмка панорамы</h1>
                <ul className="list-disc space-y-2 pl-5 text-white/85">
                  <li>Встаньте в точку, отмеченную на плане.</li>
                  <li>Держите телефон вертикально на уровне глаз.</li>
                  <li>Поворачивайтесь на месте, вращая телефон вокруг камеры.</li>
                  <li>
                    Около 26 кадров, 1–2 минуты. Нет сети — не страшно: кадры сохранятся на телефоне
                    и отправятся сами.
                  </li>
                </ul>
                <UnsentCaptures items={unsent} onSend={resume} onDiscard={discard} />
                <Button className="h-12 w-full" onClick={() => void start()}>
                  Начать съёмку
                </Button>
                {!window.isSecureContext && (
                  <p className="rounded-xl bg-amber-200 p-3 text-sm text-amber-950">
                    Страница открыта без HTTPS — камера и гироскоп работать не будут.
                  </p>
                )}
              </>
            )}
            {phase === "finishing" && (
              <Status
                title={queueState?.waitingForNetwork ? "Ждём сеть…" : "Отправляем кадры…"}
                detail={
                  queueState?.waitingForNetwork
                    ? `Кадры в безопасности на телефоне (${queueState.pending} в очереди). Можно закрыть страницу — при следующем открытии по этой ссылке отправим.`
                    : `Отправлено ${queueState?.uploaded ?? 0}, осталось ${queueState?.pending ?? 0}`
                }
              />
            )}
            {phase === "processing" && (
              <Status
                title="Склеиваем панораму"
                detail={`${pano?.progress ?? 0}% · обычно до минуты`}
              />
            )}
            {phase === "done" && pano && (
              <>
                <h1 className="text-2xl font-semibold">Готово!</h1>
                {pano.tiles?.previewUrl && (
                  <img
                    src={pano.tiles.previewUrl}
                    alt="Превью панорамы"
                    className="w-full rounded-xl"
                  />
                )}
                <p className="text-white/85">
                  Панорама уже на плане в редакторе. Проверьте направление и опубликуйте карту.
                </p>
                <Button className="h-12 w-full" onClick={() => location.reload()}>
                  Снять ещё раз здесь
                </Button>
              </>
            )}
            {phase === "error" && (
              <>
                <h1 className="text-2xl font-semibold">Не получилось</h1>
                <p className="rounded-xl bg-red-500/20 p-3">{error}</p>
                <Button className="h-12 w-full" onClick={() => location.reload()}>
                  Попробовать снова
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Status({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="space-y-3 text-center" aria-live="polite">
      <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-white/80">{detail}</p>
    </div>
  );
}

/** Equirect-style overview of which directions are already shot. */
function CoverageMap({ targets, done }: { targets: CaptureTarget[]; done: Set<number> }) {
  return (
    <svg
      viewBox="0 0 360 180"
      className="h-16 w-32 rounded-lg bg-white/10"
      aria-label="Покрытие съёмки"
    >
      {targets.map((t) => (
        <circle
          key={t.id}
          cx={(t.yaw + 180) % 360}
          cy={90 - t.pitch}
          r={10}
          fill={done.has(t.id) ? "#10b981" : "rgba(255,255,255,0.35)"}
        />
      ))}
    </svg>
  );
}

function UnsentCaptures({
  items,
  onSend,
  onDiscard,
}: {
  items: { session: CaptureSession; pendingFrames: number }[];
  onSend: (item: { session: CaptureSession }) => void;
  onDiscard: (item: { session: CaptureSession }) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2 rounded-2xl bg-amber-300/15 p-4 text-left">
      <h2 className="font-semibold">Неотправленная съёмка</h2>
      {items.map((item) => (
        <div key={item.session.key} className="space-y-2">
          <p className="text-sm text-white/80">
            {new Date(item.session.createdAt).toLocaleString("ru-RU")} · кадров на телефоне:{" "}
            {item.pendingFrames}
          </p>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => onSend(item)}>
              Отправить
            </Button>
            <Button variant="secondary" onClick={() => onDiscard(item)}>
              Удалить
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

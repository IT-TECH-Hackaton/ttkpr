import type { PanoramaOut } from "@ttkpr/api-client";
import { createStore, del, entries, get, set } from "idb-keyval";
import { captureFetch } from "./api";
import type { CaptureSession, KV, QueuedFrame, Transport } from "./captureQueue";

// One IndexedDB database per store: idb-keyval opens each store with its own database.
function idbKV<T>(db: string): KV<T> {
  const store = createStore(db, "items");
  return {
    get: (key) => get<T>(key, store),
    set: (key, value) => set(key, value, store),
    del: (key) => del(key, store),
    entries: async () => (await entries<IDBValidKey, T>(store)).map(([k, v]) => [String(k), v]),
  };
}

export const captureSessions = idbKV<CaptureSession>("ttk-capture-sessions");
export const captureFrames = idbKV<QueuedFrame>("ttk-capture-frames");

export const captureTransport: Transport = {
  async createPano(session) {
    const created = await captureFetch<PanoramaOut>(
      `/api/maps/${session.mapId}/panoramas`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          levelId: session.levelId,
          position: session.position,
          headingDeg: session.headingDeg,
          fovDeg: session.fovDeg,
          frameCount: session.frameCount,
          device: session.device,
        }),
      },
      session.token,
    );
    return created.id;
  },
  async uploadFrame(session, panoId, frame) {
    const form = new FormData();
    form.append("file", frame.blob, `frame-${frame.index}.jpg`);
    form.append("meta", JSON.stringify(frame.meta));
    await captureFetch(
      `/api/panoramas/${panoId}/frames/${frame.index}`,
      { method: "PUT", body: form },
      session.token,
    );
  },
  async startStitching(session, panoId) {
    await captureFetch(`/api/panoramas/${panoId}/stitch`, { method: "POST" }, session.token);
  },
};

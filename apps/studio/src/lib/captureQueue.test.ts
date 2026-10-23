import { describe, expect, it } from "vitest";
import {
  CaptureQueue,
  type CaptureSession,
  type KV,
  type QueuedFrame,
  type Transport,
} from "./captureQueue";

function memoryKV<T>(): KV<T> & { data: Map<string, T> } {
  const data = new Map<string, T>();
  return {
    data,
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    del: async (k) => void data.delete(k),
    entries: async () => [...data.entries()],
  };
}

const session = (): CaptureSession => ({
  key: "s1",
  mapId: "m1",
  levelId: "l1",
  position: [37.6, 55.7],
  fovDeg: 50,
  frameCount: 3,
  device: "test",
  createdAt: 0,
  finished: false,
  stitched: false,
});

const offline = Object.assign(new Error("offline"), { status: 0 });
const meta = { quaternion: [1, 0, 0, 0], width: 4, height: 3, timestampMs: 0 };
const blob = new Blob(["jpeg"]);

async function settle(queue: CaptureQueue, until: () => boolean) {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 1));
  return queue.state;
}

describe("CaptureQueue", () => {
  it("keeps shooting offline and uploads everything in order once the network is back", async () => {
    const sessions = memoryKV<CaptureSession>();
    const frames = memoryKV<QueuedFrame>();
    let online = false;
    const sent: number[] = [];
    let stitched = false;
    const transport: Transport = {
      createPano: async () => {
        if (!online) throw offline;
        return "pano-1";
      },
      uploadFrame: async (_s, _p, frame) => {
        if (!online) throw offline;
        sent.push(frame.index);
      },
      startStitching: async () => {
        stitched = true;
      },
    };
    const queue = new CaptureQueue(session(), sessions, frames, transport, undefined, () => 2);
    await queue.start();
    for (const i of [0, 1, 2]) await queue.add(i, blob, meta);
    await queue.finish();

    const waiting = await settle(queue, () => queue.state.waitingForNetwork);
    expect(waiting.waitingForNetwork).toBe(true);
    expect(frames.data.size).toBe(3); // nothing lost while offline

    online = true;
    queue.retryNow();
    await settle(queue, () => stitched);
    expect(sent).toEqual([0, 1, 2]);
    expect(stitched).toBe(true);
    expect(frames.data.size).toBe(0);
    expect(sessions.data.size).toBe(0);
  });

  it("finds a capture interrupted by closing the page", async () => {
    const sessions = memoryKV<CaptureSession>();
    const frames = memoryKV<QueuedFrame>();
    await sessions.set("s1", { ...session(), panoId: "pano-1" });
    await frames.set("s1:000", { sessionKey: "s1", index: 0, blob, meta });
    await sessions.set("other", { ...session(), key: "other", mapId: "m2" });

    const found = await CaptureQueue.unfinished(sessions, frames, "m1");
    expect(found).toHaveLength(1);
    expect(found[0]?.pendingFrames).toBe(1);
  });

  it("stops on a definitive server answer instead of retrying forever", async () => {
    const expired = Object.assign(new Error("Ссылка для съёмки устарела"), { status: 401 });
    const transport: Transport = {
      createPano: async () => {
        throw expired;
      },
      uploadFrame: async () => {},
      startStitching: async () => {},
    };
    const queue = new CaptureQueue(
      session(),
      memoryKV(),
      memoryKV(),
      transport,
      undefined,
      () => 1,
    );
    await queue.start();
    await queue.add(0, blob, meta);
    const state = await settle(queue, () => queue.state.error !== null);
    expect(state.error).toBe("Ссылка для съёмки устарела");
  });
});

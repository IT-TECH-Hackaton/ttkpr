// Phone capture survives bad connectivity: every frame is written to the device first
// (IndexedDB) and uploaded from there. Without network the shooting continues; frames go out
// when the connection returns, even after the page was closed and reopened.

export interface FrameMeta {
  quaternion: number[];
  width: number;
  height: number;
  timestampMs: number;
}

export interface CaptureSession {
  key: string;
  mapId: string;
  levelId: string;
  position: [number, number];
  token?: string;
  headingDeg?: number;
  fovDeg: number;
  frameCount: number;
  device: string;
  createdAt: number;
  /** Server panorama, once created. */
  panoId?: string;
  /** The user pressed "Завершить": stitch after the last upload. */
  finished: boolean;
  stitched: boolean;
}

export interface QueuedFrame {
  sessionKey: string;
  index: number;
  blob: Blob;
  meta: FrameMeta;
}

/** Minimal async key-value store (IndexedDB in the app, a Map in tests). */
export interface KV<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
  entries(): Promise<[string, T][]>;
}

export interface Transport {
  createPano(session: CaptureSession): Promise<string>;
  uploadFrame(session: CaptureSession, panoId: string, frame: QueuedFrame): Promise<void>;
  startStitching(session: CaptureSession, panoId: string): Promise<void>;
}

export interface QueueState {
  pending: number;
  uploaded: number;
  waitingForNetwork: boolean;
  error: string | null;
  stitchingStarted: boolean;
  panoId: string | null;
}

/** Network trouble (retry later) vs a definitive answer from the server (stop). */
export const isRetryable = (error: unknown) =>
  (error as { status?: number } | null)?.status === 0 ||
  (error as { status?: number } | null)?.status === 503 ||
  error instanceof TypeError;

const frameKey = (sessionKey: string, index: number) =>
  `${sessionKey}:${String(index).padStart(3, "0")}`;

export class CaptureQueue {
  private running = false;
  private uploaded = 0;
  private wake: (() => void) | null = null;
  state: QueueState = {
    pending: 0,
    uploaded: 0,
    waitingForNetwork: false,
    error: null,
    stitchingStarted: false,
    panoId: null,
  };

  constructor(
    private session: CaptureSession,
    private readonly sessions: KV<CaptureSession>,
    private readonly frames: KV<QueuedFrame>,
    private readonly transport: Transport,
    private readonly onChange: (state: QueueState) => void = () => {},
    private readonly retryDelayMs = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt),
  ) {
    this.state.panoId = session.panoId ?? null;
  }

  static async unfinished(sessions: KV<CaptureSession>, frames: KV<QueuedFrame>, mapId: string) {
    const all = (await sessions.entries())
      .map(([, s]) => s)
      .filter((s) => s.mapId === mapId && !s.stitched);
    const counts = new Map<string, number>();
    for (const [, f] of await frames.entries())
      counts.set(f.sessionKey, (counts.get(f.sessionKey) ?? 0) + 1);
    return all
      .map((session) => ({ session, pendingFrames: counts.get(session.key) ?? 0 }))
      .filter(({ session, pendingFrames }) => pendingFrames > 0 || session.finished);
  }

  async start() {
    await this.sessions.set(this.session.key, this.session);
    await this.refreshPending();
    void this.run();
  }

  async add(index: number, blob: Blob, meta: FrameMeta) {
    await this.frames.set(frameKey(this.session.key, index), {
      sessionKey: this.session.key,
      index,
      blob,
      meta,
    });
    await this.refreshPending();
    void this.run();
  }

  async finish() {
    this.session = { ...this.session, finished: true };
    await this.sessions.set(this.session.key, this.session);
    void this.run();
  }

  /** Call when the browser reports the network is back. */
  retryNow() {
    this.wake?.();
  }

  async discard() {
    for (const [key, frame] of await this.frames.entries()) {
      if (frame.sessionKey === this.session.key) await this.frames.del(key);
    }
    await this.sessions.del(this.session.key);
  }

  private emit(patch: Partial<QueueState>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  private async pendingFrames(): Promise<[string, QueuedFrame][]> {
    return (await this.frames.entries())
      .filter(([, f]) => f.sessionKey === this.session.key)
      .sort(([a], [b]) => a.localeCompare(b));
  }

  private async refreshPending() {
    this.emit({ pending: (await this.pendingFrames()).length, uploaded: this.uploaded });
  }

  private async withRetry<T>(step: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await step();
        if (this.state.waitingForNetwork) this.emit({ waitingForNetwork: false });
        return result;
      } catch (error) {
        if (!isRetryable(error)) throw error;
        this.emit({ waitingForNetwork: true });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.retryDelayMs(attempt));
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = null;
      }
    }
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const next = (await this.pendingFrames())[0];
        if (!next) break;
        const panoId = await this.ensurePano();
        const [key, frame] = next;
        await this.withRetry(() => this.transport.uploadFrame(this.session, panoId, frame));
        await this.frames.del(key);
        this.uploaded++;
        await this.refreshPending();
      }
      if (this.session.finished && !this.session.stitched && this.session.panoId) {
        const panoId = this.session.panoId;
        await this.withRetry(() => this.transport.startStitching(this.session, panoId));
        this.session = { ...this.session, stitched: true };
        await this.sessions.set(this.session.key, this.session);
        this.emit({ stitchingStarted: true });
        await this.sessions.del(this.session.key);
      }
    } catch (error) {
      this.emit({ error: error instanceof Error ? error.message : "Не удалось отправить съёмку" });
    } finally {
      this.running = false;
    }
    // Frames added while the last upload was in flight.
    if (!this.state.error && (await this.pendingFrames()).length > 0) void this.run();
  }

  private async ensurePano(): Promise<string> {
    if (this.session.panoId) return this.session.panoId;
    const panoId = await this.withRetry(() => this.transport.createPano(this.session));
    this.session = { ...this.session, panoId };
    await this.sessions.set(this.session.key, this.session);
    this.emit({ panoId });
    return panoId;
  }
}

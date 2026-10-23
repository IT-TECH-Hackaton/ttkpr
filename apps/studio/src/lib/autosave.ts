import { type MapDocument, saveDraft } from "@ttkpr/api-client";
import { useEffect, useRef, useState } from "react";
import { useDraft } from "../store";
import { ApiError, unwrap } from "./api";

const DEBOUNCE_MS = 1200;
const RETRY_MS = 5000;

// --- local backup: unsaved edits survive no network, a closed tab or a crash ------------------

export interface DraftBackup {
  doc: MapDocument;
  /** Server version the edits were made on. */
  baseVersion: number;
  savedAt: number;
}

const backupKey = (mapId: string) => `ttk-draft-backup:${mapId}`;

export function readBackup(mapId: string): DraftBackup | null {
  try {
    const raw = localStorage.getItem(backupKey(mapId));
    return raw ? (JSON.parse(raw) as DraftBackup) : null;
  } catch {
    return null;
  }
}

function writeBackup(mapId: string, backup: DraftBackup) {
  try {
    localStorage.setItem(backupKey(mapId), JSON.stringify(backup));
  } catch {
    // Quota or private mode: the server copy remains the source of truth.
  }
}

export function clearBackup(mapId: string) {
  try {
    localStorage.removeItem(backupKey(mapId));
  } catch {
    // ignore
  }
}

/** Saves the draft shortly after each edit; offline it keeps a local copy and retries. */
export function useAutosave() {
  const doc = useDraft((s) => s.doc);
  const mapId = useDraft((s) => s.mapId);
  const saveState = useDraft((s) => s.saveState);
  const saved = useRef<MapDocument | null>(null);
  const inFlight = useRef(false);
  const [retryTick, setRetryTick] = useState(0);

  // A freshly loaded server document is the saved one; a restored local backup is not.
  useEffect(() => {
    const baseline = (state: ReturnType<typeof useDraft.getState>) =>
      state.saveState === "saved" ? state.doc : null;
    const unsubscribe = useDraft.subscribe((state, prev) => {
      if (state.mapId !== prev.mapId || state.loadedAt !== prev.loadedAt) {
        saved.current = baseline(state);
      }
    });
    saved.current = baseline(useDraft.getState());
    return unsubscribe;
  }, []);

  // Offline: retry periodically and as soon as the browser reports the network is back.
  useEffect(() => {
    if (saveState !== "offline") return;
    const retry = () => setRetryTick((n) => n + 1);
    const timer = window.setInterval(retry, RETRY_MS);
    window.addEventListener("online", retry);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", retry);
    };
  }, [saveState]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryTick re-runs the save
  useEffect(() => {
    const state = useDraft.getState();
    if (!mapId || doc === saved.current || state.saveState === "conflict") return;
    writeBackup(mapId, { doc, baseVersion: state.version, savedAt: Date.now() });
    if (state.saveState !== "offline") state.setSaveState("dirty");
    const timer = window.setTimeout(
      async function save() {
        if (inFlight.current) {
          window.setTimeout(save, 300);
          return;
        }
        const { doc: current, version, markSaved, setSaveState } = useDraft.getState();
        inFlight.current = true;
        setSaveState("saving");
        try {
          const result = await unwrap(
            saveDraft({ path: { map_id: mapId }, body: { document: current, version } }),
          );
          saved.current = current;
          markSaved(result.version);
          if (useDraft.getState().doc === current) clearBackup(mapId);
          else useDraft.getState().setSaveState("dirty");
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            setSaveState("conflict", "Карту изменили в другой вкладке или на другом устройстве");
          } else if (e instanceof ApiError && (e.status === 0 || e.status >= 502)) {
            setSaveState(
              "offline",
              "Нет связи с сервером — изменения сохранены на этом устройстве",
            );
          } else {
            setSaveState("error", e instanceof Error ? e.message : "Не удалось сохранить");
          }
        } finally {
          inFlight.current = false;
        }
      },
      state.saveState === "offline" ? 0 : DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [doc, mapId, retryTick]);
}

/** Keeps the browser from closing the tab while edits are only in memory. */
export function useUnsavedGuard() {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = useDraft.getState().saveState;
      if (s === "dirty" || s === "saving") e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
}

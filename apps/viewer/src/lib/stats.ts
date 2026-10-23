// Anonymous usage counters for organizers ("Статистика" in the studio): what was opened,
// searched and routed. No ids, no cookies of our own; batched and sent with sendBeacon so the
// visitor's map never waits for it. The built-in demo (/m/demo) is static and not counted.

export type StatKind = "view" | "poi" | "route" | "pano" | "tour" | "search" | "miss";

const FLUSH_MS = 15_000;
let slug: string | null = null;
const queue: { kind: StatKind; key?: string }[] = [];
let timer: number | undefined;
const seen = new Set<string>();

function flush() {
  window.clearTimeout(timer);
  timer = undefined;
  if (!slug || queue.length === 0) return;
  const body = JSON.stringify({ events: queue.splice(0, 50) });
  const url = `/api/public/maps/${encodeURIComponent(slug)}/events`;
  // text/plain keeps it a "simple" request; offline it is simply lost — counters, not data.
  if (!navigator.sendBeacon?.(url, new Blob([body], { type: "text/plain" }))) {
    void fetch(url, { method: "POST", body, keepalive: true }).catch(() => {});
  }
  if (queue.length) timer = window.setTimeout(flush, 1000);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  document.addEventListener(
    "visibilitychange",
    () => document.visibilityState === "hidden" && flush(),
  );
}

/** Counts an event once per page view and key (re-renders and back-and-forth do not inflate it). */
export function track(mapSlug: string, kind: StatKind, key = "") {
  if (mapSlug === "demo") return;
  const id = `${mapSlug}|${kind}|${key}`;
  if (seen.has(id)) return;
  seen.add(id);
  if (slug !== mapSlug) {
    flush();
    slug = mapSlug;
  }
  queue.push(key ? { kind, key } : { kind });
  timer ??= window.setTimeout(flush, FLUSH_MS);
}

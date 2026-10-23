// Links that leave this browser (share, QR) must work on a phone: when the desktop runs on
// localhost, swap in the machine's LAN address. Production sets explicit public origins.

const LAN_HOST: string = import.meta.env.VITE_LAN_HOST ?? "";

function reachableHost(): string {
  const host = location.hostname;
  return (host === "localhost" || host === "127.0.0.1") && LAN_HOST ? LAN_HOST : host;
}

export function viewerOrigin(): string {
  return import.meta.env.VITE_VIEWER_URL ?? `${location.protocol}//${reachableHost()}:5173`;
}

export function studioOrigin(): string {
  if (import.meta.env.VITE_STUDIO_URL) return import.meta.env.VITE_STUDIO_URL;
  return `${location.protocol}//${reachableHost()}${location.port ? `:${location.port}` : ""}`;
}

export const mapLink = (slug: string) => `${viewerOrigin()}/m/${slug}`;
/** For "Вы здесь" signs at the venue: the viewer starts routes from this point. */
export const hereLink = (slug: string, poiId: string) =>
  `${mapLink(slug)}?here=${encodeURIComponent(poiId)}`;

export interface CaptureLinkParams {
  mapId: string;
  token: string;
  levelId: string;
  position: [number, number];
}

/** Token in the fragment: it never reaches server logs or Referer headers. */
export function captureLink({ mapId, token, levelId, position }: CaptureLinkParams): string {
  const hash = new URLSearchParams({
    t: token,
    level: levelId,
    at: position.map((n) => n.toFixed(7)).join(","),
  });
  return `${studioOrigin()}/capture/${mapId}#${hash}`;
}

/** Phones need HTTPS for the camera and motion sensors. */
export const isSecureForCapture = () => window.isSecureContext;

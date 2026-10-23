// The studio and the visitor map share one origin (studio under /studio/), so links are built
// from a single public origin. Links that leave this browser (share, QR, invites) must also work
// on a phone: when the desktop runs on localhost, the machine's LAN address is swapped in.
// A tunnel or production sets VITE_PUBLIC_URL explicitly.

const LAN_HOST: string = import.meta.env.VITE_LAN_HOST ?? "";
/** "/studio" — the router's basepath and the prefix of every studio page. */
export const STUDIO_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function publicOrigin(): string {
  const configured = import.meta.env.VITE_PUBLIC_URL;
  if (configured) return configured.replace(/\/$/, "");
  const { protocol, hostname, port } = location;
  const host = LOOPBACK.has(hostname) && LAN_HOST ? LAN_HOST : hostname;
  return `${protocol}//${host}${port ? `:${port}` : ""}`;
}

/** A studio page as an absolute link for another device. */
export const studioLink = (path: string) => `${publicOrigin()}${STUDIO_BASE}${path}`;

/** The visitor map, to copy, share or encode in a QR code. */
export const mapLink = (slug: string) => `${publicOrigin()}/m/${slug}`;

/** The visitor map in this browser: same origin, so no second certificate prompt. */
export const localMapLink = (slug: string) => `/m/${slug}`;

/** For "Вы здесь" signs at the venue: the viewer starts routes from this point. */
export const hereLink = (slug: string, poiId: string) =>
  `${mapLink(slug)}?here=${encodeURIComponent(poiId)}`;

/** Token in the fragment: it never reaches server logs or Referer headers. */
export const inviteLink = (token: string) => studioLink(`/invite#t=${token}`);

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
  return studioLink(`/capture/${mapId}#${hash}`);
}

/** Share links point to this machine's LAN address: only devices on the same network open them. */
export const isLanOnly = () => {
  const host = new URL(publicOrigin()).hostname;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || LOOPBACK.has(host);
};

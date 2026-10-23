import { networkInterfaces } from "node:os";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The studio lives under /studio/ on the same origin as the visitor map: in dev the viewer's
// server (5173, HTTPS with HTTPS=1) proxies /studio to this one, in production Caddy serves both.
// One origin means one certificate to accept on a phone, same-origin cookies, and share links
// that always match the page they were made on. This server is internal: open
// https://localhost:5173/studio/, not :5174.

/** LAN address for links and QR codes opened on a phone while the desktop uses localhost. */
function lanHost(): string {
  const candidates = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i?.address ?? "");
  const rank = (ip: string) =>
    ip.startsWith("192.168.")
      ? 0
      : ip.startsWith("10.")
        ? 1
        : /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
          ? 3
          : 2;
  // Docker/WSL bridges (172.17-19.x) are never reachable from a phone.
  return (
    candidates.filter((ip) => !/^172\.1[7-9]\./.test(ip)).sort((a, b) => rank(a) - rank(b))[0] ?? ""
  );
}

const api = { target: "http://127.0.0.1:8000", xfwd: true };

export default defineConfig({
  base: "/studio/",
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.VITE_LAN_HOST": JSON.stringify(process.env.VITE_LAN_HOST ?? lanHost()),
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    // Only for opening this server directly (http://localhost:5174/studio/) without the viewer.
    proxy: { "/api": api, "/media": api },
  },
  // The lazily loaded panorama stack is pre-bundled together, so three.js exists once.
  optimizeDeps: {
    include: [
      "three",
      "@photo-sphere-viewer/core",
      "@photo-sphere-viewer/markers-plugin",
      "@photo-sphere-viewer/equirectangular-tiles-adapter",
    ],
  },
  // MapLibre's worker is a module worker (see src/lib/maplibre.ts).
  worker: { format: "es" },
  build: {
    target: "es2022",
  },
});

import { networkInterfaces } from "node:os";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// HTTPS=1 pnpm dev — needed for camera/gyroscope (panorama capture) from a phone on the LAN.
const https = process.env.HTTPS === "1";

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

const api = { target: "http://localhost:8000", xfwd: true };

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(https ? [basicSsl()] : [])],
  define: {
    "import.meta.env.VITE_LAN_HOST": JSON.stringify(process.env.VITE_LAN_HOST ?? lanHost()),
  },
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    proxy: { "/api": api, "/media": api },
  },
  // MapLibre's worker is a module worker (see src/lib/maplibre.ts).
  worker: { format: "es" },
  build: {
    target: "es2022",
  },
});

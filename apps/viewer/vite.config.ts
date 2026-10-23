import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// HTTPS=1 pnpm dev — needed to test camera/gyroscope from a phone on the LAN.
const https = process.env.HTTPS === "1";

// This server is the single entry point in dev: the visitor map at /, the studio at /studio/
// (proxied to its own Vite server, see apps/studio/vite.config.ts), the API at /api and /media.
const api = { target: "http://127.0.0.1:8000", xfwd: true };

// A tunnel or another public name for the dev server (VITE_PUBLIC_URL=https://….example).
const publicHost = process.env.VITE_PUBLIC_URL
  ? new URL(process.env.VITE_PUBLIC_URL).hostname
  : null;

/** "/studio" -> "/studio/": the studio's base needs the trailing slash. */
const studioSlash = (): Plugin => ({
  name: "studio-trailing-slash",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== "/studio") return next();
      res.writeHead(301, { Location: "/studio/" });
      res.end();
    });
  },
});

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    studioSlash(),
    ...(https ? [basicSsl()] : []),
    VitePWA({
      // Own service worker (src/sw.ts): saved maps are served offline before anything else.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,webp,json,webmanifest}"],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      manifest: {
        name: "Карта пространства",
        short_name: "Карта",
        lang: "ru",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#2563eb",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    ...(publicHost ? { allowedHosts: [publicHost] } : {}),
    proxy: {
      "/api": api,
      "/media": api,
      // changeOrigin: the studio server only answers to its own host; ws: its hot reload.
      "/studio/": { target: "http://127.0.0.1:5174", changeOrigin: true, ws: true },
    },
  },
  // Pre-bundle the lazily loaded panorama stack together, so three.js exists once.
  optimizeDeps: {
    include: [
      "three",
      "@photo-sphere-viewer/core",
      "@photo-sphere-viewer/markers-plugin",
      "@photo-sphere-viewer/gyroscope-plugin",
      "@photo-sphere-viewer/equirectangular-tiles-adapter",
    ],
  },
  // MapLibre's worker is a module worker (see src/lib/maplibre.ts).
  worker: { format: "es" },
  build: {
    target: "es2022",
  },
});

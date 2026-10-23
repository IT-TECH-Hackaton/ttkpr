import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// HTTPS=1 pnpm dev — needed to test camera/gyroscope from a phone on the LAN.
const https = process.env.HTTPS === "1";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
    proxy: {
      "/api": { target: "http://localhost:8000", xfwd: true },
      "/media": { target: "http://localhost:8000", xfwd: true },
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

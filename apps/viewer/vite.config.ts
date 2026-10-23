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
      registerType: "autoUpdate",
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
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "/index.html",
        runtimeCaching: [
          {
            // The only mutable file of a published map: always try the network first.
            urlPattern: ({ url }) => url.pathname.endsWith("/manifest.json"),
            handler: "NetworkFirst",
            options: { cacheName: "map-manifests", networkTimeoutSeconds: 3 },
          },
          {
            // Versioned bundles and pano tiles are immutable.
            urlPattern: ({ url }) => /\/(v\d+|pano-[^/]+)\//.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "map-immutable",
              expiration: { maxEntries: 2000, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.endsWith(".pbf"),
            handler: "StaleWhileRevalidate",
            options: { cacheName: "map-glyphs" },
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: { "/api": "http://localhost:8000" },
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

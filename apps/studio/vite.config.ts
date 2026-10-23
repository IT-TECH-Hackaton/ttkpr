import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// HTTPS=1 pnpm dev — needed for camera/gyroscope (panorama capture) from a phone on the LAN.
const https = process.env.HTTPS === "1";

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(https ? [basicSsl()] : [])],
  server: {
    host: true,
    port: 5174,
    proxy: { "/api": "http://localhost:8000" },
  },
  // MapLibre's worker is a module worker (see src/lib/maplibre.ts).
  worker: { format: "es" },
  build: {
    target: "es2022",
  },
});

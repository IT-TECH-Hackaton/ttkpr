import { defineConfig, devices } from "@playwright/test";

// End-to-end checks of the built PWA (service worker only runs in a production build).
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: "http://localhost:4174", ...devices["Pixel 7"] },
  webServer: {
    command: "pnpm build && pnpm exec vite preview --port 4174 --strictPort",
    url: "http://localhost:4174",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});

import { defineConfig } from "@hey-api/openapi-ts";

// Input is exported from FastAPI: `pnpm gen:api` at the repo root.
export default defineConfig({
  input: "./openapi.json",
  output: "src/gen",
  plugins: ["@hey-api/typescript", "@hey-api/client-fetch", "@hey-api/sdk", "zod"],
});

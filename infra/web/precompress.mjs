// Writes .br (brotli 11) and .gz (gzip 9) copies next to every compressible file of the built
// apps, for Caddy's `file_server { precompressed br gzip }`: the best compression, done once
// at build time instead of on every request.
//
//   node infra/web/precompress.mjs apps/viewer/dist apps/studio/dist
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".html",
  ".json",
  ".svg",
  ".webmanifest",
  ".txt",
  ".xml",
  ".wasm",
]);
// Below Caddy's own `encode` threshold the headers outweigh the savings.
const MIN_BYTES = 512;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: node precompress.mjs <dist dir>...");
  process.exit(2);
}

let written = 0;
let saved = 0;
for (const root of roots) {
  for (const file of walk(root)) {
    if (!EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const data = readFileSync(file);
    if (data.length < MIN_BYTES) continue;
    const variants = [
      [
        ".br",
        brotliCompressSync(data, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
          },
        }),
      ],
      [".gz", gzipSync(data, { level: 9 })],
    ];
    for (const [suffix, packed] of variants) {
      // Only when it really helps; otherwise Caddy serves the plain file.
      if (packed.length > data.length * 0.95) continue;
      writeFileSync(file + suffix, packed);
      written += 1;
      saved += data.length - packed.length;
    }
  }
}
console.log(`precompressed ${written} files, ${Math.round(saved / 1024)} KiB less to send`);

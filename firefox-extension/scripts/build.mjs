import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const outdir = process.env.KOKORO_EXTENSION_OUT_DIR ?? "dist";
const testFallback = process.env.KOKORO_TEST_HIGHLIGHT_FALLBACK === "1";
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
    options: "src/ui/options.ts",
  },
  bundle: true,
  loader: { ".css": "text" },
  alias: { "@mozilla/readability": "./src/reading/readability-vendor.ts" },
  outdir,
  target: "firefox142",
  format: "iife",
  // Only the isolated fallback E2E build simulates an unavailable browser API.
  define: testFallback ? { Highlight: "undefined" } : {},
});
await Promise.all(
  [
    "manifest.json",
    "src/ui/options.html",
    "src/ui/options.css",
    "src/assets/icon.svg",
  ].map((path) => copyFile(path, join(outdir, path.split("/").at(-1)))),
);
await copyFile("../LICENSE", join(outdir, "LICENSE.txt"));
await copyFile(
  "node_modules/@mozilla/readability/LICENSE.md",
  join(outdir, "Readability-LICENSE.txt"),
);
await copyFile(
  "node_modules/@mozilla/readability/Readability.js",
  join(outdir, "Readability.js"),
);

await copyFile(
  "node_modules/lucide/LICENSE",
  join(outdir, "Lucide-LICENSE.txt"),
);

import { build } from "esbuild";
import { compile } from "svelte/compiler";
import { mkdir, copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const safari = process.argv.includes("--safari");
const outdir =
  process.env.KOKORO_EXTENSION_OUT_DIR ?? (safari ? "dist-safari" : "dist");
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
  plugins: [
    {
      name: "svelte",
      setup(build) {
        build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => ({
          contents: compile(await readFile(path, "utf8"), {
            filename: path,
            fragments: "tree",
          }).js.code,
          loader: "js",
        }));
      },
    },
  ],
  alias: { "@mozilla/readability": "./src/reading/readability-vendor.ts" },
  outdir,
  target: safari ? "safari16.4" : "firefox142",
  format: "iife",
  // Only the isolated fallback E2E build simulates an unavailable browser API.
  define: {
    __SAFARI__: String(safari),
    ...(testFallback ? { Highlight: "undefined" } : {}),
  },
});
await Promise.all(
  [
    "src/ui/options.html",
    "src/ui/options.css",
    "src/ui/theme.css",
    "src/assets/icon.svg",
  ].map((path) => copyFile(path, join(outdir, path.split("/").at(-1)))),
);
if (safari) await copyFile("src/assets/icon.png", join(outdir, "icon.png"));
await copyFile(
  safari ? "manifest.safari.json" : "manifest.json",
  join(outdir, "manifest.json"),
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
await copyFile(
  "node_modules/svelte/LICENSE.md",
  join(outdir, "Svelte-LICENSE.txt"),
);
await copyFile(
  "node_modules/esm-env/LICENSE",
  join(outdir, "esm-env-LICENSE.txt"),
);

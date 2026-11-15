import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/background.ts", "src/content.ts", "src/options.ts"],
  bundle: true,
  outdir: "dist",
  target: "firefox142",
  format: "iife",
});
await Promise.all(
  ["manifest.json", "src/options.html"].map((path) =>
    copyFile(path, `dist/${path.split("/").at(-1)}`),
  ),
);

import { defineConfig } from "vitest/config";
import { compile } from "svelte/compiler";
import { readFile } from "node:fs/promises";

export default defineConfig({
  resolve: { conditions: ["browser"] },
  plugins: [
    {
      name: "svelte",
      async transform(_code, id) {
        if (!id.endsWith(".svelte")) return;
        return compile(await readFile(id, "utf8"), {
          filename: id,
          fragments: "tree",
        }).js.code;
      },
    },
  ],
  test: { environment: "jsdom", include: ["tests/unit/**/*.test.ts"] },
});

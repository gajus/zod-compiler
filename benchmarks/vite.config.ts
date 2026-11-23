import * as path from "node:path";
import { fileURLToPath } from "node:url";
import UnpluginTypia from "@typia/unplugin/vite";
import { defineConfig } from "vite-plus";
import zodCompiler from "zod-compiler/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [UnpluginTypia({ cache: false }), zodCompiler({ schemas: "explicit" })],
  resolve: {
    conditions: ["source"],
  },
  test: {
    root: __dirname,
    benchmark: {
      include: ["suites/**/*.bench.ts"],
    },
    // One file at a time: files measured side by side compete for cores, and
    // some land on the slower efficiency cores.
    fileParallelism: false,
    // zod and zod v3 are left to Node's own loader (no `server.deps.inline`):
    // through Vite's module runner every one of zod's own imports is read
    // through a getter on each use, which made zod v4 up to 73% slower than it
    // runs in an application.
  },
});

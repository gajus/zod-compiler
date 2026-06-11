import * as path from "node:path";
import { fileURLToPath } from "node:url";
import UnpluginTypia from "@typia/unplugin/vite";
import { defineConfig } from "vitest/config";
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
    server: {
      deps: {
        inline: ["zod", "zod3"],
      },
    },
  },
});

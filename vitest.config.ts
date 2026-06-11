import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ["source"],
    // Explicit alias: vitest's SSR pipeline does not reliably honor custom
    // conditions for `#`-subpath imports, and the package-imports fallback
    // would resolve #src through a (possibly stale) dist build.
    alias: {
      "#src": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    server: {
      deps: {
        inline: ["zod"],
      },
    },
  },
});

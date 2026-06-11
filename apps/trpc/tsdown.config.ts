import { defineConfig } from "tsdown";
import zodCompiler from "zod-compiler/rolldown";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  external: ["zod", /^@trpc\//],
  plugins: [zodCompiler({ verbose: true })],
  outDir: "dist",
});

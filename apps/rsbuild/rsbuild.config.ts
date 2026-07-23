import { defineConfig } from "@rsbuild/core";
import zodCompiler from "zod-compiler/rsbuild";

export default defineConfig({
  plugins: [zodCompiler({ verbose: true })],
  source: {
    entry: {
      index: "./src/main.ts",
    },
  },
  output: {
    target: "node",
    distPath: {
      root: "dist",
    },
    filename: {
      js: "[name].mjs",
    },
  },
});

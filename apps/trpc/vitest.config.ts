import { defineConfig } from "vitest/config";
import zodCompiler from "zod-compiler/vite";

export default defineConfig({
  plugins: [zodCompiler()],
  test: {
    include: ["tests/**/*.test.ts"],
  },
});

import zodCompiler from "zod-compiler/bun";

await Bun.build({
  entrypoints: ["src/server.ts"],
  outdir: "dist",
  target: "bun",
  external: ["zod", "hono", "@hono/zod-validator"],
  plugins: [zodCompiler()],
});

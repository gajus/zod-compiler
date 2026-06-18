import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { UnpluginContextMeta, UnpluginOptions } from "unplugin";
import { describe, expect, it } from "vitest";
import { unplugin } from "#src/unplugin/index.js";

const meta = { framework: "vite" } as UnpluginContextMeta;

describe("unplugin factory", () => {
  it("creates a plugin with correct name", () => {
    const plugin = unplugin.raw({}, meta) as UnpluginOptions;
    expect(plugin.name).toBe("zod-compiler");
  });

  it("creates a plugin with enforce: pre", () => {
    const plugin = unplugin.raw({}, meta) as UnpluginOptions;
    expect(plugin.enforce).toBe("pre");
  });

  it("default apply compiles builds and vitest, skips plain dev servers", () => {
    const plugin = unplugin.raw({}, meta) as UnpluginOptions;
    const apply = plugin.vite?.apply as (
      config: unknown,
      env: { command: string; mode: string },
    ) => boolean;
    expect(typeof apply).toBe("function");

    expect(apply({}, { command: "build", mode: "production" })).toBe(true);
    // This test itself runs under Vitest, so VITEST is set — temporarily
    // remove it to simulate a plain dev server.
    const saved = process.env["VITEST"];
    delete process.env["VITEST"];
    try {
      expect(apply({}, { command: "serve", mode: "development" })).toBe(false);
      expect(apply({}, { command: "serve", mode: "test" })).toBe(true);
    } finally {
      if (saved !== undefined) process.env["VITEST"] = saved;
    }
    // With VITEST set (the real vitest environment), serve mode compiles.
    expect(apply({}, { command: "serve", mode: "development" })).toBe(true);
  });

  it("respects apply: build (skip dev and tests)", () => {
    const plugin = unplugin.raw({ apply: "build" }, meta) as UnpluginOptions;
    expect(plugin.vite?.apply).toBe("build");
  });

  it("respects apply: serve", () => {
    const plugin = unplugin.raw({ apply: "serve" }, meta) as UnpluginOptions;
    expect(plugin.vite?.apply).toBe("serve");
  });

  it("apply: all leaves vite apply unset (runs in every mode)", () => {
    const plugin = unplugin.raw({ apply: "all" }, meta) as UnpluginOptions;
    expect(plugin.vite?.apply).toBeUndefined();
  });

  it("transformInclude delegates to shouldTransform", () => {
    const plugin = unplugin.raw({}, meta) as UnpluginOptions;
    const transformInclude = plugin.transformInclude as (id: string) => boolean;

    expect(transformInclude("/src/schemas.ts")).toBe(true);
    expect(transformInclude("/node_modules/zod/index.ts")).toBe(false);
    expect(transformInclude("/src/types.d.ts")).toBe(false);
    expect(transformInclude("/src/schemas.compiled.ts")).toBe(false);
  });

  it("transformInclude respects plugin options", () => {
    const plugin = unplugin.raw({ exclude: ["generated"] }, meta) as UnpluginOptions;
    const transformInclude = plugin.transformInclude as (id: string) => boolean;

    expect(transformInclude("/src/schemas.ts")).toBe(true);
    expect(transformInclude("/src/generated/schemas.ts")).toBe(false);
  });

  it("transform bails out when code lacks zod-compiler reference", async () => {
    const plugin = unplugin.raw({}, meta) as UnpluginOptions;
    const transform = plugin.transform as (code: string, id: string) => Promise<unknown>;

    const result = await transform("export const x = 1;", "/src/test.ts");
    expect(result).toBeUndefined();
  });

  it("transform bails out when code lacks compile reference", async () => {
    const plugin = unplugin.raw({}, meta) as UnpluginOptions;
    const transform = plugin.transform as (code: string, id: string) => Promise<unknown>;

    const result = await transform('import { z } from "zod-compiler";', "/src/test.ts");
    expect(result).toBeUndefined();
  });

  it("transform processes valid compile() file", async () => {
    const plugin = unplugin.raw({}, meta) as UnpluginOptions;
    const transform = plugin.transform as (
      code: string,
      id: string,
    ) => Promise<{ code: string; map: unknown } | undefined>;

    const fixturesDir = path.resolve(import.meta.dirname, "../fixtures");
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");

    const code = [
      'import { z } from "zod";',
      'import { compile } from "zod-compiler";',
      "const UserSchema = z.object({ name: z.string().min(1), age: z.number().int().positive() });",
      "export const validateUser = compile(UserSchema);",
    ].join("\n");

    const result = await transform(code, fixturePath);

    expect(result).toBeDefined();
    expect(result?.code).toContain("safeParse_validateUser");
    // Transforms ship a composed sourcemap (original -> output) so stack
    // traces in transformed files keep pointing at the right lines.
    const map = result?.map as { mappings: string; sources: string[] } | null;
    expect(map).not.toBeNull();
    expect(map?.mappings.length).toBeGreaterThan(0);
    expect(String(map?.sources[0])).toContain("simple-schema");
  });

  it('output: "compact" delegates the cold path to zod and drops the slow walk', async () => {
    const plugin = unplugin.raw({ output: "compact" }, meta) as UnpluginOptions;
    const transform = plugin.transform as (
      code: string,
      id: string,
    ) => Promise<{ code: string; map: unknown } | undefined>;

    const fixturesDir = path.resolve(import.meta.dirname, "../fixtures");
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");

    const code = [
      'import { z } from "zod";',
      'import { compile } from "zod-compiler";',
      "const UserSchema = z.object({ name: z.string().min(1), age: z.number().int().positive() });",
      "export const validateUser = compile(UserSchema);",
    ].join("\n");

    const result = await transform(code, fixturePath);

    expect(result).toBeDefined();
    const out = result?.code ?? "";
    // Schema identity is preserved (zod-compatible, like "schema") and wired via __zcMkv.
    expect(out).toContain("__zcMkv");
    // Cold errors delegate to the retained zod schema via __zcFinZ, imported in lean mode.
    expect(out).toContain("__zcFinZ");
    expect(out).toMatch(/import\s*\{[^}]*__zcFinZ[^}]*\}\s*from\s*"virtual:zod-compiler\/runtime"/);
    // The compiled slow walk and its inline issue construction are gone.
    expect(out).not.toContain("__sw_");
    expect(out).not.toContain("__zcFinD");
  });

  it("transform returns cached result for the same file id", async () => {
    const plugin = unplugin.raw({}, meta) as UnpluginOptions;
    const transform = plugin.transform as (
      code: string,
      id: string,
    ) => Promise<{ code: string; map: unknown } | undefined>;

    const fixturesDir = path.resolve(import.meta.dirname, "../fixtures");
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");

    const code = [
      'import { z } from "zod";',
      'import { compile } from "zod-compiler";',
      "const UserSchema = z.object({ name: z.string().min(1), age: z.number().int().positive() });",
      "export const validateUser = compile(UserSchema);",
    ].join("\n");

    const first = await transform(code, fixturePath);
    const second = await transform(code, fixturePath);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.code).toBe(first?.code);
  });

  it("serves cached results across build cycles for unchanged content", async () => {
    const plugin = unplugin.raw({ verbose: true }, meta) as UnpluginOptions;
    const transform = plugin.transform as (
      code: string,
      id: string,
    ) => Promise<{ code: string; map: unknown } | undefined>;
    const buildEnd = plugin.buildEnd as () => void;

    const fixturesDir = path.resolve(import.meta.dirname, "../fixtures");
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");

    const code = [
      'import { z } from "zod";',
      'import { compile } from "zod-compiler";',
      "const UserSchema = z.object({ name: z.string().min(1), age: z.number().int().positive() });",
      "export const validateUser = compile(UserSchema);",
    ].join("\n");

    // First build cycle
    await transform(code, fixturePath);
    buildEnd();

    // Unchanged content keeps producing a valid result on the next cycle
    const result = await transform(code, fixturePath);
    expect(result).toBeDefined();
    expect(result?.code).toContain("safeParse_validateUser");
  });

  it("recomputes when content changes for the same file id (no stale cache)", async () => {
    const plugin = unplugin.raw({}, meta) as UnpluginOptions;
    const transform = plugin.transform as (
      code: string,
      id: string,
    ) => Promise<{ code: string; map: unknown } | undefined>;

    const fixturesDir = path.resolve(import.meta.dirname, "../fixtures");
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");

    const codeA = [
      'import { z } from "zod";',
      'import { compile } from "zod-compiler";',
      "const UserSchema = z.object({ name: z.string().min(1), age: z.number().int().positive() });",
      "export const validateUser = compile(UserSchema);",
    ].join("\n");
    const codeB = `// edited\n${codeA}`;

    const first = await transform(codeA, fixturePath);
    const second = await transform(codeB, fixturePath);

    expect(first?.code).toContain("safeParse_validateUser");
    // The edited marker survives only if the transform was recomputed from codeB
    expect(second?.code).toContain("// edited");
  });

  it("watchChange invalidates the transform cache", async () => {
    const plugin = unplugin.raw({}, meta) as UnpluginOptions;
    const transform = plugin.transform as (
      code: string,
      id: string,
    ) => Promise<{ code: string; map: unknown } | undefined>;
    const watchChange = plugin.watchChange as (id: string, change: { event: string }) => void;

    const fixturesDir = path.resolve(import.meta.dirname, "../fixtures");
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");

    const code = [
      'import { z } from "zod";',
      'import { compile } from "zod-compiler";',
      "const UserSchema = z.object({ name: z.string().min(1), age: z.number().int().positive() });",
      "export const validateUser = compile(UserSchema);",
    ].join("\n");

    await transform(code, fixturePath);
    expect(() => watchChange(fixturePath, { event: "update" })).not.toThrow();

    const result = await transform(code, fixturePath);
    expect(result?.code).toContain("safeParse_validateUser");
  });

  it("verbose stats count each file only once despite duplicate transforms", async () => {
    const logs: string[] = [];
    // oxlint-disable-next-line no-console -- intercept console.log to verify verbose output
    const originalLog = console.log;
    // oxlint-disable-next-line no-console -- install the interception
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const plugin = unplugin.raw({ verbose: true }, meta) as UnpluginOptions;
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => Promise<{ code: string; map: unknown } | undefined>;
      const buildEnd = plugin.buildEnd as () => void;

      const fixturesDir = path.resolve(import.meta.dirname, "../fixtures");
      const fixturePath = path.join(fixturesDir, "simple-schema.ts");

      const code = [
        'import { z } from "zod";',
        'import { compile } from "zod-compiler";',
        "const UserSchema = z.object({ name: z.string().min(1), age: z.number().int().positive() });",
        "export const validateUser = compile(UserSchema);",
      ].join("\n");

      // Simulate webpack calling transform twice for the same file (different layers)
      await transform(code, fixturePath);
      await transform(code, fixturePath);
      buildEnd();

      const summaryLog = logs.find((l) => l.includes("Build summary"));
      expect(summaryLog).toContain("1/1 schemas optimized across 1 file(s)");
    } finally {
      // oxlint-disable-next-line no-console -- restore the intercepted logger
      console.log = originalLog;
    }
  });
});

describe("schemas / output option resolution", () => {
  const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/auto-discover-simple.ts");
  const CODE = readFileSync(FIXTURE, "utf8");
  type Tx = (code: string, id: string) => Promise<{ code: string } | undefined>;
  const tx = (options: Record<string, unknown>): Tx =>
    (unplugin.raw({ cache: false, ...options }, meta) as UnpluginOptions)
      .transform as unknown as Tx;

  it('defaults to schemas: "auto" — plain exports compile with no config', async () => {
    const result = await tx({})(CODE, FIXTURE);
    expect(result?.code).toContain("__zcMkv(");
  });

  it('schemas: "explicit" compiles only compile()-wrapped schemas', async () => {
    const result = await tx({ schemas: "explicit" })(CODE, FIXTURE);
    expect(result).toBeUndefined();
  });

  it('output: "bag" emits a method bag (null schema arg)', async () => {
    const result = await tx({ output: "bag" })(CODE, FIXTURE);
    expect(result?.code).toMatch(/__zcMkv\([\w$]+,null,/);
  });

  it('default output: "schema" keeps the original schema as the __zcMkv target', async () => {
    const result = await tx({})(CODE, FIXTURE);
    expect(result?.code).not.toMatch(/__zcMkv\([\w$]+,null,/);
  });
});

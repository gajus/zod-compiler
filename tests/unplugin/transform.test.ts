import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import { extractSchema, type RefEntry } from "#src/core/extract/index.js";
import { moduleHeadOffset } from "#src/unplugin/edits.js";
import { SCHEMA_NAME_PATTERN, ZOD_MODULES } from "#src/unplugin/hoist.js";
import {
  findExpressionEnd,
  HAS_RUNTIME_ZOD_IMPORT,
  removeCompileImport,
  rewriteSource,
  rewriteSourceAutoDiscover,
  shouldTransform,
  TRANSFORM_ID_FILTER,
  transformCode,
  transformCodeFilter,
} from "#src/unplugin/transform.js";
import type { BuildStats } from "#src/unplugin/types.js";

const fixturesDir = path.resolve(import.meta.dirname, "../fixtures");

describe("shouldTransform()", () => {
  it("includes .ts files", () => {
    expect(shouldTransform("/src/schemas.ts")).toBe(true);
  });

  it("includes .tsx files", () => {
    expect(shouldTransform("/src/component.tsx")).toBe(true);
  });

  it("includes .mts files", () => {
    expect(shouldTransform("/src/schemas.mts")).toBe(true);
  });

  it("includes .js files", () => {
    expect(shouldTransform("/src/schemas.js")).toBe(true);
  });

  it("excludes node_modules", () => {
    expect(shouldTransform("/node_modules/zod/index.ts")).toBe(false);
  });

  it("excludes .d.ts files", () => {
    expect(shouldTransform("/src/types.d.ts")).toBe(false);
  });

  it("excludes .compiled.ts files", () => {
    expect(shouldTransform("/src/schemas.compiled.ts")).toBe(false);
  });

  it("excludes .compiled.js files", () => {
    expect(shouldTransform("/src/schemas.compiled.js")).toBe(false);
  });

  it("excludes non-script files", () => {
    expect(shouldTransform("/src/styles.css")).toBe(false);
    expect(shouldTransform("/src/data.json")).toBe(false);
  });

  it("includes .cjs and .cts files", () => {
    expect(shouldTransform("/src/schemas.cjs")).toBe(true);
    expect(shouldTransform("/src/schemas.cts")).toBe(true);
  });

  it("includes .jsx files", () => {
    expect(shouldTransform("/src/component.jsx")).toBe(true);
  });

  it("handles include and exclude together", () => {
    const options = { include: ["src/"], exclude: ["src/generated"] };
    expect(shouldTransform("/src/schemas.ts", options)).toBe(true);
    expect(shouldTransform("/src/generated/schemas.ts", options)).toBe(false);
    expect(shouldTransform("/lib/schemas.ts", options)).toBe(false);
  });

  it("respects exclude option", () => {
    expect(shouldTransform("/src/generated/schemas.ts", { exclude: ["generated"] })).toBe(false);
  });

  it("respects include option", () => {
    expect(shouldTransform("/src/other.ts", { include: ["schemas"] })).toBe(false);
    expect(shouldTransform("/src/schemas.ts", { include: ["schemas"] })).toBe(true);
  });

  it("supports glob patterns in exclude", () => {
    expect(shouldTransform("/src/lib/env.ts", { exclude: ["**/lib/env.ts"] })).toBe(false);
    expect(shouldTransform("/src/schemas.ts", { exclude: ["**/lib/env.ts"] })).toBe(true);
  });

  it("supports glob patterns in include", () => {
    expect(shouldTransform("/src/schemas.ts", { include: ["**/schemas/**"] })).toBe(false);
    expect(shouldTransform("/src/schemas/user.ts", { include: ["**/schemas/**"] })).toBe(true);
  });
});

describe("transform hook filters", () => {
  /** unplugin's id-filter semantics: exclude wins, then an include must match. */
  const matchesId = (id: string): boolean =>
    !TRANSFORM_ID_FILTER.exclude.some((pattern) => pattern.test(id)) &&
    TRANSFORM_ID_FILTER.include.some((pattern) => pattern.test(id));

  it("id filter agrees with shouldTransform on every option-independent case", () => {
    // The filter is what bundlers with native hook-filter support evaluate;
    // shouldTransform() is what the handler applies. They must not drift.
    const ids = [
      "/src/schemas.ts",
      "/src/schemas.mts",
      "/src/schemas.cts",
      "/src/schemas.js",
      "/src/schemas.mjs",
      "/src/schemas.cjs",
      "/src/component.tsx",
      "/src/component.jsx",
      "/src/types.d.ts",
      "/src/schemas.compiled.ts",
      "/src/schemas.compiled.js",
      "/node_modules/zod/index.ts",
      "/src/styles.css",
      "/src/data.json",
      "/src/schemas.ts?v=1",
      "\0zod-compiler-runtime",
    ];
    for (const id of ids) {
      expect(matchesId(id), id).toBe(shouldTransform(id));
    }
  });

  it("code filter matches every source shape the transform can rewrite", () => {
    const filter = transformCodeFilter();
    expect(filter).toBeDefined();
    const sources = [
      // autoDiscover: a runtime zod import
      'import { z } from "zod";\nexport const S = z.object({});',
      'import { z } from "zod/v4";\nexport const S = z.object({});',
      // schemas: "explicit": compile() from zod-compiler
      'import { compile } from "zod-compiler";\nexport const v = compile(S);',
      // hoisting: an imported identifier matching the default name pattern
      'import { UserZodSchema } from "./shapes";\nconst f = () => UserZodSchema.partial();',
    ];
    for (const source of sources) {
      expect(filter?.test(source), source).toBe(true);
    }
    // A file that never mentions zod cannot produce output — the bundler skips
    // the hook call, the content hash and the import scan entirely.
    expect(filter?.test('import { useState } from "react";\nexport const x = useState;')).toBe(
      false,
    );
  });

  it("code filter is dropped when a custom hoist schemaNamePattern is configured", () => {
    expect(transformCodeFilter({ hoist: { schemaNamePattern: /Model$/ } })).toBeUndefined();
    // Name-based matching disabled or left at the default: zod imports (or a
    // "ZodSchema" identifier) are the only way in, so the filter is sound.
    expect(transformCodeFilter({ hoist: { schemaNamePattern: null } })).toBeDefined();
    expect(transformCodeFilter({ hoist: {} })).toBeDefined();
    expect(transformCodeFilter({ hoist: false, schemas: "explicit" })).toBeDefined();
  });
});

/**
 * The `code` filter is the one part of the hook filters whose failure is
 * silent: a file it wrongly rejects is never handed to the plugin, so schemas
 * quietly stay uncompiled instead of erroring. These tests pin it to the
 * triggers it claims to cover — each assertion fails the moment a trigger is
 * widened past a "zod" mention, which is exactly when the filter must change.
 */
describe("code filter soundness", () => {
  // oxlint-disable-next-line typescript/no-non-null-assertion -- default options always yield a filter
  const filter = transformCodeFilter()!;

  it("trigger 1: every zod module specifier the plugin recognizes mentions zod", () => {
    // Widening ZOD_MODULES to a non-"zod" specifier (a re-export package, an
    // alias) breaks the filter: hoisting would fire on files it rejects.
    for (const specifier of ZOD_MODULES) {
      const source = `import { z } from "${specifier}";\nexport const S = z.string();`;
      expect(filter.test(source), specifier).toBe(true);
    }
  });

  it("trigger 1: the discovery gate matches zod imports and nothing else", () => {
    for (const specifier of ["zod", "zod/v3", "zod/v4"]) {
      const source = `import { z } from "${specifier}";\nexport const S = z.string();`;
      expect(HAS_RUNTIME_ZOD_IMPORT.test(source), specifier).toBe(true);
      expect(filter.test(source), specifier).toBe(true);
    }
    // The mirror image: if the gate ever matched another validator's imports,
    // the filter would have to grow with it.
    for (const specifier of ["valibot", "yup", "@sinclair/typebox", "./schemas"]) {
      const source = `import { v } from "${specifier}";\nexport const S = v.string();`;
      expect(HAS_RUNTIME_ZOD_IMPORT.test(source), specifier).toBe(false);
      expect(filter.test(source), specifier).toBe(false);
    }
  });

  it("the discovery gate covers every zod/mini spelling", () => {
    // zod/mini shares `_zod.def` with classic zod, so extract → codegen treats
    // both identically; only this gate decides whether a mini file is ever
    // looked at. All three mini specifiers in zod's export map must match, or
    // those files are silently skipped with no error.
    for (const specifier of ["zod/mini", "zod/v4/mini", "zod/v4-mini"]) {
      const source = `import { object } from "${specifier}";\nexport const S = object({});`;
      expect(HAS_RUNTIME_ZOD_IMPORT.test(source), specifier).toBe(true);
      expect(filter.test(source), specifier).toBe(true);
    }
    // The widened `[/-]mini` suffix must not open the gate to a foreign package.
    for (const specifier of ["not-zod/mini", "zodiac/mini", "valibot/mini"]) {
      const source = `import { object } from "${specifier}";\nexport const S = object({});`;
      expect(HAS_RUNTIME_ZOD_IMPORT.test(source), specifier).toBe(false);
    }
  });

  it("trigger 2: explicit mode keys off the package name, which mentions zod", () => {
    expect(filter.test('import { compile } from "zod-compiler";')).toBe(true);
  });

  it("trigger 3: the default hoist name pattern implies a Zod mention", () => {
    // A default of /Schema$/ would match "UserSchema" — a hoistable root in a
    // file with no "zod" anywhere — and the filter would skip it.
    expect(SCHEMA_NAME_PATTERN.test("UserZodSchema")).toBe(true);
    expect(SCHEMA_NAME_PATTERN.test("UserSchema")).toBe(false);
    expect(filter.test("UserZodSchema")).toBe(true);
  });

  it("rewritten output stays matchable (re-transform of an already-hoisted file)", () => {
    // Transformed files are fed back through the hook by some hosts; the
    // filter must not reject the plugin's own output before its idempotency
    // guard gets to run.
    const hoisted = [
      'import { z } from "zod";',
      "const _zh_1a2b3c4d = z.object({ name: z.string() });",
      "export const make = () => _zh_1a2b3c4d;",
    ].join("\n");
    expect(filter.test(hoisted)).toBe(true);
  });
});

describe("removeCompileImport()", () => {
  it("removes sole compile import", () => {
    const code = `import { compile } from "zod-compiler";`;
    expect(removeCompileImport(code)).toBe("");
  });

  it("removes compile from mixed imports", () => {
    const code = `import { compile, createFallback } from "zod-compiler";`;
    expect(removeCompileImport(code)).toBe(`import { createFallback } from "zod-compiler";`);
  });

  it("preserves type imports on separate lines", () => {
    const code = [
      `import { compile } from "zod-compiler";`,
      `import type { CompiledSchema } from "zod-compiler";`,
    ].join("\n");
    const result = removeCompileImport(code);
    // \bcompile\b: the package name "zod-compiler" legitimately contains the
    // substring — only the standalone import specifier must be gone.
    expect(result).not.toMatch(/\bcompile\b/);
    expect(result).toContain("CompiledSchema");
  });

  it("handles single quotes", () => {
    const code = `import { compile } from 'zod-compiler';`;
    expect(removeCompileImport(code)).toBe("");
  });

  it("does not affect other module imports", () => {
    const code = `import { z } from "zod";`;
    expect(removeCompileImport(code)).toBe(code);
  });

  // H4: Should handle multi-line import statements
  it("removes compile from multi-line import", () => {
    const code = ["import {", "  compile,", "  createFallback", '} from "zod-compiler";'].join(
      "\n",
    );
    const result = removeCompileImport(code);
    expect(result).not.toMatch(/\bcompile\b/);
    expect(result).toContain("createFallback");
  });

  it("removes sole compile from multi-line import", () => {
    const code = ["import {", "  compile", '} from "zod-compiler";'].join("\n");
    const result = removeCompileImport(code);
    expect(result).toBe("");
  });
});

describe("rewriteSource()", () => {
  const simpleSchema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive(),
  });

  function makeCompiledInfo(exportName: string, schema: z.ZodType) {
    const ir = extractSchema(schema);
    const codegenResult = generateValidator(ir, exportName);
    return { exportName, codegenResult, refEntries: [] };
  }

  it("replaces a single compile() call with a __zcMkv IIFE", () => {
    const code = [
      `import { z } from "zod";`,
      `import { compile } from "zod-compiler";`,
      `const UserSchema = z.object({ name: z.string() });`,
      `export const validateUser = compile(UserSchema);`,
    ].join("\n");

    const schemas = [makeCompiledInfo("validateUser", simpleSchema)];
    const result = rewriteSource(code, schemas);

    expect(result).toContain("/* @__PURE__ */");
    expect(result).toContain("(() => {");
    expect(result).toContain("safeParse_validateUser");
    expect(result).toMatch(
      /__zcMkv\(safeParse_validateUser,UserSchema,(?:__fc_\d+|null),(?:__fc_\d+|null)\)/,
    );
    expect(result).not.toContain("__w.schema=");
    expect(result).not.toContain("compile(UserSchema)");
    // compile import should be removed
    expect(result).not.toContain(`import { compile } from "zod-compiler"`);
  });

  it("replaces multiple compile() calls", () => {
    const code = [
      `import { compile } from "zod-compiler";`,
      `export const validateUser = compile(UserSchema);`,
      `export const validateProduct = compile(ProductSchema);`,
    ].join("\n");

    const productSchema = z.object({ id: z.number(), title: z.string() });
    const schemas = [
      makeCompiledInfo("validateUser", simpleSchema),
      makeCompiledInfo("validateProduct", productSchema),
    ];
    const result = rewriteSource(code, schemas);

    expect(result).toContain("safeParse_validateUser");
    expect(result).toContain("safeParse_validateProduct");
    expect(result).not.toContain("compile(UserSchema)");
    expect(result).not.toContain("compile(ProductSchema)");
  });

  it("handles generic type parameter: compile<Type>(Schema)", () => {
    const code = [
      `import { compile } from "zod-compiler";`,
      `export const validateUser = compile<User>(UserSchema);`,
    ].join("\n");

    const schemas = [makeCompiledInfo("validateUser", simpleSchema)];
    const result = rewriteSource(code, schemas);

    expect(result).toContain("safeParse_validateUser");
    expect(result).not.toContain("compile<User>(UserSchema)");
  });

  it("handles nested generic: compile<z.infer<typeof Schema>>(Schema)", () => {
    const code = [
      `import { compile } from "zod-compiler";`,
      `export const validateUser = compile<z.infer<typeof UserSchema>>(UserSchema);`,
    ].join("\n");

    const schemas = [makeCompiledInfo("validateUser", simpleSchema)];
    const result = rewriteSource(code, schemas);

    expect(result).toContain("safeParse_validateUser");
    expect(result).not.toContain("compile<z.infer");
  });

  it("IIFE references __zcMsg (injection handled by transformCode)", () => {
    const code = [
      `import { z } from "zod";`,
      `import { compile } from "zod-compiler";`,
      `export const validateUser = compile(UserSchema);`,
    ].join("\n");

    const schemas = [makeCompiledInfo("validateUser", simpleSchema)];
    const result = rewriteSource(code, schemas);

    // rewriteSource itself no longer injects the config import
    // (that's done by injectZodConfigImport in transformCode).
    // The IIFE calls __zcFin (which internally uses __zcMsg injected at file level).
    expect(result).toContain("__zcFin");
  });

  it("preserves schema variable reference in generated code", () => {
    const code = [
      `import { compile } from "zod-compiler";`,
      `export const validateUser = compile(MyUserSchema);`,
    ].join("\n");

    const schemas = [makeCompiledInfo("validateUser", simpleSchema)];
    const result = rewriteSource(code, schemas);

    expect(result).toMatch(
      /__zcMkv\(safeParse_validateUser,MyUserSchema,(?:__fc_\d+|null),(?:__fc_\d+|null)\)/,
    );
    expect(result).not.toContain("__w.schema=");
  });

  it("handles inline schema expressions with nested parentheses", () => {
    const code = [
      `import { compile } from "zod-compiler";`,
      `export const validateUser = compile(z.object({ name: z.string() }));`,
    ].join("\n");

    const schemas = [makeCompiledInfo("validateUser", simpleSchema)];
    const result = rewriteSource(code, schemas);

    expect(result).toContain("safeParse_validateUser");
    expect(result).not.toContain("compile(z.object");
    // The schema arg should be passed to __zcMkv
    expect(result).toMatch(
      /__zcMkv\(safeParse_validateUser,z\.object\(\{ name: z\.string\(\) \}\),(?:__fc_\d+|null),(?:__fc_\d+|null)\)/,
    );
  });

  it("handles inline schema with trailing comma", () => {
    const code = [
      `import { compile } from "zod-compiler";`,
      `export const validateUser = compile(`,
      `  z.object({ name: z.string() }),`,
      `);`,
    ].join("\n");

    const schemas = [makeCompiledInfo("validateUser", simpleSchema)];
    const result = rewriteSource(code, schemas);

    expect(result).toContain("safeParse_validateUser");
    expect(result).not.toContain("compile(");
    // Trailing comma should be stripped; schema arg passed to __zcMkv followed
    // by the fast-check arg (a doubled comma would mean the strip failed)
    expect(result).toMatch(
      /__zcMkv\(safeParse_validateUser,z\.object\(\{ name: z\.string\(\) \}\),(?:__fc_\d+|null),(?:__fc_\d+|null)\)/,
    );
    expect(result).not.toContain(",,");
  });

  // C1 (from review): findMatchingParen should handle parens inside string literals
  it("handles parentheses inside string literal default values", () => {
    const code = [
      `import { compile } from "zod-compiler";`,
      `export const validateUser = compile(z.object({ msg: z.string().default("balance: (100)") }));`,
    ].join("\n");

    const schemas = [makeCompiledInfo("validateUser", simpleSchema)];
    const result = rewriteSource(code, schemas);

    expect(result).toContain("safeParse_validateUser");
    // The compile(...) call should be fully replaced
    expect(result).not.toContain("compile(z.object");
  });

  it("skips replacement when closing paren is not found (unmatched parens)", () => {
    const code = [
      `import { compile } from "zod-compiler";`,
      `export const validateUser = compile(UserSchema;`,
    ].join("\n");

    const schemas = [makeCompiledInfo("validateUser", simpleSchema)];
    const result = rewriteSource(code, schemas);

    // Code should be unchanged except compile import removal
    expect(result).not.toContain("safeParse_validateUser");
    expect(result).toContain("compile(UserSchema;");
  });

  it("skips schema when export name does not match code (no regex match)", () => {
    const code = [
      `import { compile } from "zod-compiler";`,
      `export const validateProduct = compile(ProductSchema);`,
    ].join("\n");

    // Schema name "validateUser" does not exist in the code
    const schemas = [makeCompiledInfo("validateUser", simpleSchema)];
    const result = rewriteSource(code, schemas);

    // Code should be unchanged (except compile import removal)
    expect(result).not.toContain("safeParse_validateUser");
    expect(result).toContain("validateProduct = compile(ProductSchema)");
  });

  it("does not match export name as substring (word boundary)", () => {
    const code = [
      `import { compile } from "zod-compiler";`,
      `export const revalidateUser = compile(OtherSchema);`,
      `export const validateUser = compile(UserSchema);`,
    ].join("\n");

    // Only "validateUser" is in the schemas list
    const schemas = [makeCompiledInfo("validateUser", simpleSchema)];
    const result = rewriteSource(code, schemas);

    // "validateUser" should be replaced
    expect(result).toContain("safeParse_validateUser");
    // "revalidateUser" should NOT be replaced (still has compile())
    expect(result).toContain("revalidateUser = compile(OtherSchema)");
  });
});

/**
 * Fixture files use relative imports (../../../src/index.js) for discoverSchemas to work,
 * but transformCode checks for "zod-compiler" in the source. We pass the code with "zod-compiler"
 * import so the quick check passes, while discoverSchemas loads the actual fixture file.
 */
function readFixtureAsUserCode(fixturePath: string): string {
  const fs = require("node:fs") as typeof import("node:fs");
  return fs
    .readFileSync(fixturePath, "utf-8")
    .replace(/from\s*["'](?:\.\.\/.*?|#src\/.*?)["']/g, 'from "zod-compiler"');
}

describe("transformCode() E2E", () => {
  it("transforms a simple compile() file and produces working validation", async () => {
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");
    const code = readFixtureAsUserCode(fixturePath);

    const result = await transformCode(code, fixturePath, { mode: "lean" });

    expect(result).not.toBeNull();
    expect(result).toContain("safeParse_validateUser");
    expect(result).toContain("/* @__PURE__ */");
    expect(result).not.toContain("compile(UserSchema)");
  });

  it("transforms multiple compile() calls in one file", async () => {
    const fixturePath = path.join(fixturesDir, "multi-schema.ts");
    const code = readFixtureAsUserCode(fixturePath);

    const result = await transformCode(code, fixturePath, { mode: "lean" });

    expect(result).not.toBeNull();
    expect(result).toContain("safeParse_validateUser");
    expect(result).toContain("safeParse_validateProduct");
  });

  it("returns null for files without compile()", async () => {
    const fixturePath = path.join(fixturesDir, "no-compile.ts");
    const code = readFixtureAsUserCode(fixturePath);

    const result = await transformCode(code, fixturePath, { mode: "lean" });

    expect(result).toBeNull();
  });

  it("hoists a shared nested shape into one module-scope __zcSw walk", async () => {
    const fixturePath = path.join(fixturesDir, "dedup-schema.ts");
    const code = readFixtureAsUserCode(fixturePath);

    const result = await transformCode(code, fixturePath, { mode: "lean" });

    expect(result).not.toBeNull();
    const out = result ?? "";
    // The repeated shape's error walk is emitted ONCE at module scope and called
    // from both exports. Stripping objects included: the shared walk returns its
    // rebuilt value, so the call site receives what an inlined walk would have
    // written (see createSharedSchemaPlan).
    expect((out.match(/function __zcSw_\d+\(input,path,_e\)/g) ?? []).length).toBe(1);
    expect(out).toMatch(/=__zcSw_0\(/);
    // Both exports still compile, each with its own build pass.
    expect(out).toContain("safeParse_validateUser");
    expect(out).toContain("safeParse_validateCompany");
  });

  it("returns null when code does not reference zod-compiler", async () => {
    const code = `export const x = 1;`;
    const result = await transformCode(code, "/fake/path.ts", { mode: "lean" });

    expect(result).toBeNull();
  });

  it("returns null when code has compile import but no exported compiled schemas", async () => {
    const fixturePath = path.join(fixturesDir, "no-compile.ts");
    // Inject "zod-compiler" and "compile" strings to pass bail-out, but the file has no compile() calls
    const code = `import { compile } from "zod-compiler";\nimport { z } from "zod";\nconst Schema = z.object({ name: z.string() });\n`;
    const result = await transformCode(code, fixturePath, { mode: "lean" });
    expect(result).toBeNull();
  });

  it("returns null when code contains compile but not zod-compiler", async () => {
    const code = `import { compile } from "other-lib";\nexport const x = compile(foo);`;
    const result = await transformCode(code, "/fake/path.ts", { mode: "lean" });

    expect(result).toBeNull();
  });

  it("calls onBuildStats callback when schemas are compiled", async () => {
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");
    const code = readFixtureAsUserCode(fixturePath);
    const stats: BuildStats[] = [];

    await transformCode(code, fixturePath, {
      mode: "lean",
      onBuildStats: (s) => stats.push(s),
    });

    expect(stats).toHaveLength(1);
    expect(stats[0]?.files).toBe(1);
    expect(stats[0]?.schemas).toBeGreaterThanOrEqual(1);
    expect(stats[0]?.optimized).toBeGreaterThanOrEqual(1);
    expect(stats[0]?.failed).toBe(0);
  });

  it("verbose mode logs per-schema compilation status", async () => {
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");
    const code = readFixtureAsUserCode(fixturePath);
    const logSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await transformCode(code, fixturePath, { mode: "lean", verbose: true });
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("[zod-compiler]");
      expect(output).toContain("✓");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("does not inject duplicate __zodCompilerConfig import", async () => {
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");
    const baseCode = readFixtureAsUserCode(fixturePath);
    // Pre-inject the __zodCompilerConfig import to simulate already present
    const code = `import { config as __zodCompilerConfig } from "zod";\n${baseCode}`;

    const result = await transformCode(code, fixturePath, { mode: "lean" });

    expect(result).not.toBeNull();
    // Should NOT add a second config import line
    const importLines = result
      ?.split("\n")
      .filter((l) => l.includes("import { config as __zodCompilerConfig }"));
    expect(importLines).toHaveLength(1);
  });

  it("verbose mode logs fallback count (singular)", async () => {
    const fixturePath = path.join(fixturesDir, "with-fallback.ts");
    const code = readFixtureAsUserCode(fixturePath);
    const logSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await transformCode(code, fixturePath, { mode: "lean", verbose: true });
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("1 ref)");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("verbose mode logs ref count (plural)", async () => {
    const fixturePath = path.join(fixturesDir, "with-multi-fallback.ts");
    const code = readFixtureAsUserCode(fixturePath);
    const logSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await transformCode(code, fixturePath, { mode: "lean", verbose: true });
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("refs)");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("throws when discoverSchemas fails", async () => {
    const code = `import { compile } from "zod-compiler";\nexport const v = compile(S);`;
    await expect(transformCode(code, "/nonexistent/bad-file.ts", { mode: "lean" })).rejects.toThrow(
      "[zod-compiler]",
    );
  });

  // Issue #4: a schema file transitively imports an env module that calls
  // process.exit() when secrets are missing. In a secret-less CI build the
  // build must survive (the file falls back to runtime Zod) rather than have
  // the bundler terminated.
  it("survives a schema file whose import calls process.exit during discovery", async () => {
    const envPath = path.join(fixturesDir, "__test_env_exit.ts");
    const schemaPath = path.join(fixturesDir, "__test_schema_env_exit.ts");
    await fs.promises.writeFile(
      envPath,
      "process.exit(1);\nexport const env: Record<string, string> = {};\n",
    );
    await fs.promises.writeFile(
      schemaPath,
      'import { z } from "zod";\nimport "./__test_env_exit";\n' +
        "export const UserSchema = z.object({ name: z.string() });\n",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
    try {
      const code = await fs.promises.readFile(schemaPath, "utf-8");
      // Must not reject — the build-time exit is caught, not propagated.
      const result = await transformCode(code, schemaPath, { mode: "lean", autoDiscover: true });
      // Discovery never saw the schema, so nothing was compiled into an IIFE.
      expect(result == null || !result.includes("safeParse_")).toBe(true);
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).toContain("process.exit");
      expect(warned).toContain("ZOD_COMPILER");
    } finally {
      warnSpy.mockRestore();
      await fs.promises.unlink(envPath).catch(() => undefined);
      await fs.promises.unlink(schemaPath).catch(() => undefined);
    }
  });
});

describe('transformCode() — mode: "inline"', () => {
  it("prepends file-level __zcMkv and __zcFin declarations instead of virtual import", async () => {
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");
    const code = readFixtureAsUserCode(fixturePath);

    const result = await transformCode(code, fixturePath, { mode: "inline" });

    expect(result).not.toBeNull();
    // Inline mode emits self-contained file-level helpers, no virtual import
    expect(result).not.toContain("virtual:zod-compiler/runtime");
    expect(result).toContain("function __zcMkv(");
    expect(result).toContain("function __zcFin(");
    // __zodCompilerConfig import is prepended once for __zcMsg
    expect(result).toContain("__zodCompilerConfig");
    expect(result).toContain("safeParse_validateUser");
  });

  it("does not emit __zc* helper imports in inline mode", async () => {
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");
    const code = readFixtureAsUserCode(fixturePath);

    const result = await transformCode(code, fixturePath, { mode: "inline" });

    expect(result).not.toBeNull();
    // Inline mode emits issue object literals at each check site, not factory calls
    expect(result).not.toContain("__zcTS(");
    expect(result).not.toContain("__zcTB(");
    expect(result).not.toContain("__zcIT(");
    // No import of well-known regexes in inline mode (they're declared per-IIFE)
    expect(result).not.toContain("__zcReEmail");
  });

  it("declares __zcMkv and __zcFin only once when multiple schemas exist", async () => {
    const fixturePath = path.join(fixturesDir, "multi-schema.ts");
    const code = readFixtureAsUserCode(fixturePath);

    const result = await transformCode(code, fixturePath, { mode: "inline" });

    expect(result).not.toBeNull();
    // File-level helpers must be declared exactly once even with multiple validators
    const mkvDecls = result?.match(/function __zcMkv\(/g) ?? [];
    const finDecls = result?.match(/function __zcFin\(/g) ?? [];
    expect(mkvDecls.length).toBe(1);
    expect(finDecls.length).toBe(1);
    // Both validators reference the shared factory
    expect(result).toContain("safeParse_validateUser");
    expect(result).toContain("safeParse_validateProduct");
  });

  it("produces functionally equivalent output to lean mode (modulo helper layout)", async () => {
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");
    const code = readFixtureAsUserCode(fixturePath);

    const leanResult = await transformCode(code, fixturePath, { mode: "lean" });
    const inlineResult = await transformCode(code, fixturePath, { mode: "inline" });

    expect(leanResult).not.toBeNull();
    expect(inlineResult).not.toBeNull();
    // Both modes generate the same compiled validator function name
    expect(leanResult).toContain("safeParse_validateUser");
    expect(inlineResult).toContain("safeParse_validateUser");
    // Lean mode imports from virtual module; inline mode embeds helpers
    expect(leanResult).toContain("virtual:zod-compiler/runtime");
    expect(inlineResult).not.toContain("virtual:zod-compiler/runtime");
  });

  it("uses WP_RUNTIME_ID when runtimeId option is set (rspack/webpack path)", async () => {
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");
    const code = readFixtureAsUserCode(fixturePath);

    const result = await transformCode(code, fixturePath, {
      mode: "lean",
      runtimeId: "__zod-compiler-runtime__",
    });

    expect(result).not.toBeNull();
    expect(result).toContain('from "__zod-compiler-runtime__"');
    expect(result).not.toContain("virtual:zod-compiler/runtime");
  });

  it("supports autoDiscover with inline mode", async () => {
    const fixturePath = path.join(fixturesDir, "auto-discover-simple.ts");
    const code = readFixtureAsUserCode(fixturePath);

    const result = await transformCode(code, fixturePath, {
      mode: "inline",
      autoDiscover: true,
    });

    expect(result).not.toBeNull();
    expect(result).not.toContain("virtual:zod-compiler/runtime");
    expect(result).toContain("function __zcMkv(");
    expect(result).toContain("/* @__PURE__ */");
  });
});

describe("findExpressionEnd()", () => {
  it("finds end of simple expression", () => {
    const code = "const x = z.string();";
    const end = findExpressionEnd(code, 10); // starts at z.string()
    expect(code.slice(10, end)).toBe("z.string()");
  });

  it("finds end of nested object expression", () => {
    const code = "const x = z.object({ a: z.string() });";
    const end = findExpressionEnd(code, 10);
    expect(code.slice(10, end)).toBe("z.object({ a: z.string() })");
  });

  it("finds end of multi-line expression", () => {
    const code = "const x = z.object({\n  a: z.string(),\n  b: z.number(),\n});";
    const end = findExpressionEnd(code, 10);
    expect(code.slice(10, end)).toContain("z.object(");
    expect(code.slice(10, end)).toContain("b: z.number()");
  });

  it("finds end of expression with regex literal", () => {
    const code = "const x = z.string().regex(/[a-z]+/);";
    const end = findExpressionEnd(code, 10);
    expect(code.slice(10, end)).toBe("z.string().regex(/[a-z]+/)");
  });

  it("returns -1 for unparseable expression", () => {
    const code = "const x = @@@invalid;";
    const end = findExpressionEnd(code, 10);
    expect(end).toBe(-1);
  });
});

describe("rewriteSourceAutoDiscover()", () => {
  const simpleSchema = z.object({ name: z.string() });

  function makeCompiledInfo(exportName: string, schema: z.ZodType) {
    const ir = extractSchema(schema);
    const codegenResult = generateValidator(ir, exportName);
    return { exportName, codegenResult, refEntries: [] };
  }

  it("skips schema when export pattern does not match code", () => {
    const code = `import { z } from "zod";\nexport const OtherSchema = z.string();`;
    const schemas = [makeCompiledInfo("UserSchema", simpleSchema)];
    const result = rewriteSourceAutoDiscover(code, schemas);

    // Code should be unchanged
    expect(result).toBe(code);
  });

  it("skips schema when expression is unparseable", () => {
    const code = `import { z } from "zod";\nexport const UserSchema = @@@invalid;`;
    const schemas = [makeCompiledInfo("UserSchema", simpleSchema)];
    const result = rewriteSourceAutoDiscover(code, schemas);

    // Code should be unchanged
    expect(result).toBe(code);
  });

  it("replaces a single schema export with IIFE", () => {
    const code = `import { z } from "zod";\nexport const UserSchema = z.object({ name: z.string() });`;
    const schemas = [makeCompiledInfo("UserSchema", simpleSchema)];
    const result = rewriteSourceAutoDiscover(code, schemas);

    expect(result).toContain("/* @__PURE__ */");
    expect(result).toContain("safeParse_UserSchema");
    expect(result).toContain("__zcMkv(safeParse_UserSchema,z.object({ name: z.string() })");
  });

  it("replaces multiple schema exports", () => {
    const code = [
      `import { z } from "zod";`,
      `export const A = z.object({ x: z.string() });`,
      `export const B = z.object({ y: z.number() });`,
    ].join("\n");
    const schemas = [
      makeCompiledInfo("A", z.object({ x: z.string() })),
      makeCompiledInfo("B", z.object({ y: z.number() })),
    ];
    const result = rewriteSourceAutoDiscover(code, schemas);

    expect(result).toContain("safeParse_A");
    expect(result).toContain("safeParse_B");
  });

  it("handles schema with type annotation", () => {
    const code = `import { z } from "zod";\nexport const UserSchema: z.ZodObject<{ name: z.ZodString }> = z.object({ name: z.string() });`;
    const schemas = [makeCompiledInfo("UserSchema", simpleSchema)];
    const result = rewriteSourceAutoDiscover(code, schemas);

    expect(result).toContain("safeParse_UserSchema");
    expect(result).toContain("/* @__PURE__ */");
  });

  it("uses plain object when zodCompat is false", () => {
    const code = `import { z } from "zod";\nexport const UserSchema = z.object({ name: z.string() });`;
    const schemas = [makeCompiledInfo("UserSchema", simpleSchema)];
    const result = rewriteSourceAutoDiscover(code, schemas, { zodCompat: false });

    expect(result).toMatch(
      /__zcMkv\(safeParse_UserSchema,null,(?:__fc_\d+|null),(?:__fc_\d+|null)\)/,
    );
    expect(result).not.toContain("Object.create");
  });

  // A self-referential schema's deferred callback closes over the binding being
  // declared, so the IIFE's `__rf` deref cannot run inside its initializer.
  describe("self-referential exports", () => {
    const recursive: z.ZodType = z.lazy(() =>
      z.union([z.custom<string>((v) => typeof v === "string"), z.array(recursive)]),
    );

    function makeRefInfo(exportName: string, schema: z.ZodType) {
      const refEntries: RefEntry[] = [];
      const ir = extractSchema(schema, refEntries);
      const codegenResult = generateValidator(ir, exportName, { refCount: refEntries.length });
      return { exportName, codegenResult, refEntries };
    }

    const decl = `export const NodeZodSchema: z.ZodType = z.lazy(() => z.union([z.custom(), z.array(NodeZodSchema)]))`;

    it("leaves the initializer intact and follows it with an init statement", () => {
      const code = `import { z } from "zod";\n${decl};`;
      const result = rewriteSourceAutoDiscover(code, [makeRefInfo("NodeZodSchema", recursive)]);

      // The declaration is byte-identical, so the lazy stays unforced until the
      // statement below it runs — by which point the binding is assigned.
      expect(result).toContain(`${decl};\n`);
      expect(result).toContain("var __zs=NodeZodSchema;");
      expect(result).toContain("__zcMkv(safeParse_NodeZodSchema,__zs,");
      // The statement's whole point is __zcMkv's mutation; annotating it pure
      // would let a bundler drop the compilation.
      expect(result).not.toContain("/* @__PURE__ */");
      expect(result.indexOf("var __zs=NodeZodSchema;")).toBeGreaterThan(result.indexOf(decl));
    });

    it("keeps the in-place pure IIFE when no ref is dereferenced", () => {
      const code = `import { z } from "zod";\n${decl};`;
      const plain: z.ZodType = z.lazy(() => z.union([z.string(), z.array(plain)]));
      const result = rewriteSourceAutoDiscover(code, [makeRefInfo("NodeZodSchema", plain)]);

      expect(result).toContain("/* @__PURE__ */");
      expect(result).not.toContain("var __zs=NodeZodSchema;");
    });

    it("skips the export when zodCompat is false", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const code = `import { z } from "zod";\n${decl};`;
      const result = rewriteSourceAutoDiscover(code, [makeRefInfo("NodeZodSchema", recursive)], {
        zodCompat: false,
      });

      expect(result).toBe(code);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("NodeZodSchema"));
      warnSpy.mockRestore();
    });

    it("keeps sibling declarators inside the declaration", () => {
      const code = `import { z } from "zod";\n${decl}, Other = 1;`;
      const result = rewriteSourceAutoDiscover(code, [makeRefInfo("NodeZodSchema", recursive)]);

      // The split writes the declarator list back verbatim and puts the
      // statement AFTER it, so `Other` is neither dropped nor orphaned.
      expect(result).toContain(`${decl}, Other = 1;\n`);
      expect(result.indexOf("var __zs=NodeZodSchema;")).toBeGreaterThan(
        result.indexOf("Other = 1;"),
      );
    });
  });

  it("IIFE references __zcMsg (injection handled by transformCode)", () => {
    const code = `import { z } from "zod";\nexport const UserSchema = z.object({ name: z.string() });`;
    const schemas = [makeCompiledInfo("UserSchema", simpleSchema)];
    const result = rewriteSourceAutoDiscover(code, schemas);

    // rewriteSourceAutoDiscover itself no longer injects the config import
    // (that's done by injectZodConfigImport in transformCode).
    // The IIFE calls __zcFin (which internally uses __zcMsg injected at file level).
    expect(result).toContain("__zcFin");
  });
});

describe("transformCode() — autoDiscover", () => {
  it("transforms a simple Zod file with autoDiscover", async () => {
    const fixturePath = path.join(fixturesDir, "auto-discover-simple.ts");
    const code = readFixtureAsUserCode(fixturePath);

    const result = await transformCode(code, fixturePath, { mode: "lean", autoDiscover: true });

    expect(result).not.toBeNull();
    expect(result).toContain("safeParse_UserSchema");
    expect(result).toContain("/* @__PURE__ */");
  });

  it("transforms multiple Zod exports with autoDiscover", async () => {
    const fixturePath = path.join(fixturesDir, "auto-discover-multi.ts");
    const code = readFixtureAsUserCode(fixturePath);

    const result = await transformCode(code, fixturePath, { mode: "lean", autoDiscover: true });

    expect(result).not.toBeNull();
    expect(result).toContain("safeParse_UserSchema");
    expect(result).toContain("safeParse_ProductSchema");
  });

  it("handles mixed compile() + autoDiscover with two-pass rewrite", async () => {
    const fixturePath = path.join(fixturesDir, "auto-discover-mixed.ts");
    const code = readFixtureAsUserCode(fixturePath);

    const result = await transformCode(code, fixturePath, { mode: "lean", autoDiscover: true });

    expect(result).not.toBeNull();
    // compile() schema should be rewritten
    expect(result).toContain("safeParse_validateUser");
    // autoDiscover schema should also be rewritten
    expect(result).toContain("safeParse_ProductSchema");
    // compile import should be removed by rewriteSource pass
    expect(result).not.toContain('from "zod-compiler"');
  });

  it("autoDiscover with only compile() schemas (no plain Zod exports)", async () => {
    const fixturePath = path.join(fixturesDir, "simple-schema.ts");
    const code = readFixtureAsUserCode(fixturePath);

    const result = await transformCode(code, fixturePath, { mode: "lean", autoDiscover: true });

    expect(result).not.toBeNull();
    expect(result).toContain("safeParse_validateUser");
    // compile import should be removed
    expect(result).not.toContain('from "zod-compiler"');
  });

  it("returns null when no runtime Zod import in autoDiscover mode", async () => {
    const code = `export const x = 1;`;
    const result = await transformCode(code, "/fake/path.ts", { mode: "lean", autoDiscover: true });

    expect(result).toBeNull();
  });

  it("returns null for type-only Zod import in autoDiscover mode", async () => {
    const code = `import type { z } from "zod";\nexport const x = 1;`;
    const result = await transformCode(code, "/fake/path.ts", { mode: "lean", autoDiscover: true });

    expect(result).toBeNull();
  });

  it("returns null for type-only zod/v4 subpath import in autoDiscover mode", async () => {
    const code = `import type { z } from "zod/v4";\nexport const x = 1;`;
    const result = await transformCode(code, "/fake/path.ts", { mode: "lean", autoDiscover: true });

    expect(result).toBeNull();
  });

  it("recognizes runtime zod/v4 subpath import as a candidate in autoDiscover mode", async () => {
    // Before the regex fix, `import { z } from "zod/v4"` would fail HAS_RUNTIME_ZOD_IMPORT
    // and bail out early — the file-load step was never reached.
    // After the fix it passes the check, so with verbose mode and a bad path we
    // see the "Skipping" warning emitted at the file-load failure point, not silence.
    const code = `import { z } from "zod/v4";\nexport const v = z.string();`;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());

    try {
      const result = await transformCode(code, "/nonexistent/bad-file.ts", {
        mode: "lean",
        autoDiscover: true,
        verbose: true,
      });

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Skipping /nonexistent/bad-file.ts"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns null (does not throw) when file loading fails in autoDiscover mode", async () => {
    const code = `import { z } from "zod";\nexport const v = z.string();`;
    const result = await transformCode(code, "/nonexistent/bad-file.ts", {
      mode: "lean",
      autoDiscover: true,
    });

    expect(result).toBeNull();
  });

  it("logs warning when file loading fails in autoDiscover verbose mode", async () => {
    const code = `import { z } from "zod";\nexport const v = z.string();`;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());

    try {
      const result = await transformCode(code, "/nonexistent/bad-file.ts", {
        mode: "lean",
        autoDiscover: true,
        verbose: true,
      });

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Skipping /nonexistent/bad-file.ts"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("calls onBuildStats in autoDiscover mode", async () => {
    const fixturePath = path.join(fixturesDir, "auto-discover-simple.ts");
    const code = readFixtureAsUserCode(fixturePath);
    const stats: BuildStats[] = [];

    await transformCode(code, fixturePath, {
      mode: "lean",
      autoDiscover: true,
      onBuildStats: (s) => stats.push(s),
    });

    expect(stats).toHaveLength(1);
    expect(stats[0]?.optimized).toBeGreaterThanOrEqual(1);
  });

  it("verbose mode logs auto-discovering status (single export)", async () => {
    const fixturePath = path.join(fixturesDir, "auto-discover-simple.ts");
    const code = readFixtureAsUserCode(fixturePath);
    const logSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await transformCode(code, fixturePath, { mode: "lean", autoDiscover: true, verbose: true });
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Auto-discovering");
      expect(output).toContain("1 Zod export found");
      expect(output).toContain("✓");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("verbose mode logs auto-discovering status (multiple exports)", async () => {
    const fixturePath = path.join(fixturesDir, "auto-discover-multi.ts");
    const code = readFixtureAsUserCode(fixturePath);
    const logSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await transformCode(code, fixturePath, { mode: "lean", autoDiscover: true, verbose: true });
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Auto-discovering");
      expect(output).toContain("exports found");
      expect(output).toContain("✓");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("transformCode() — compilation failure paths", () => {
  it("warns and continues when a schema fails to compile", async () => {
    const fixturePath = path.join(fixturesDir, "with-broken-schema.ts");
    const code = readFixtureAsUserCode(fixturePath);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());

    try {
      const result = await transformCode(code, fixturePath, { mode: "lean" });
      // goodValidator should be compiled, brokenValidator should fail
      expect(result).not.toBeNull();
      expect(result).toContain("safeParse_goodValidator");
      // warn() should have been called for brokenValidator
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to compile "brokenValidator"'),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("compile()"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns without 'compile()' mention in autoDiscover mode", async () => {
    const fixturePath = path.join(fixturesDir, "with-broken-schema.ts");
    const code = readFixtureAsUserCode(fixturePath);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());

    try {
      await transformCode(code, fixturePath, { mode: "lean", autoDiscover: true });
      const warnMsg = warnSpy.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("brokenValidator"),
      )?.[0] as string;
      expect(warnMsg).toContain("Keeping original");
      expect(warnMsg).not.toContain("compile()");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("verbose mode logs failed schema count", async () => {
    const fixturePath = path.join(fixturesDir, "with-broken-schema.ts");
    const code = readFixtureAsUserCode(fixturePath);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const logSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());

    try {
      await transformCode(code, fixturePath, { mode: "lean", verbose: true });
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("1 schema(s) failed");
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("returns null when all schemas fail to compile", async () => {
    const fixturePath = path.join(fixturesDir, "all-broken-schemas.ts");
    const code = readFixtureAsUserCode(fixturePath);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());

    try {
      const result = await transformCode(code, fixturePath, { mode: "lean" });
      expect(result).toBeNull();
      // Both schemas should have triggered warnings
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("rewriteSource() — zodCompat option", () => {
  const simpleSchema = z.object({ name: z.string() });

  function makeCompiledInfo(exportName: string, schema: z.ZodType) {
    const ir = extractSchema(schema);
    const codegenResult = generateValidator(ir, exportName);
    return { exportName, codegenResult, refEntries: [] };
  }

  it("uses plain object when zodCompat is false", () => {
    const code = [
      `import { compile } from "zod-compiler";`,
      `export const validateUser = compile(UserSchema);`,
    ].join("\n");

    const schemas = [makeCompiledInfo("validateUser", simpleSchema)];
    const result = rewriteSource(code, schemas, { zodCompat: false });

    expect(result).toMatch(
      /__zcMkv\(safeParse_validateUser,null,(?:__fc_\d+|null),(?:__fc_\d+|null)\)/,
    );
    expect(result).not.toContain("Object.create");
  });

  it("passes the original schema to __zcMkv when zodCompat is true (default)", () => {
    const code = [
      `import { compile } from "zod-compiler";`,
      `export const validateUser = compile(UserSchema);`,
    ].join("\n");

    const schemas = [makeCompiledInfo("validateUser", simpleSchema)];
    const result = rewriteSource(code, schemas, { zodCompat: true });

    expect(result).toMatch(
      /__zcMkv\(safeParse_validateUser,UserSchema,(?:__fc_\d+|null),(?:__fc_\d+|null)\)/,
    );
  });
});

describe("transform output — root schema evaluation (field incident)", () => {
  // A root-fallback autoDiscover rewrite used to splice the schema expression
  // once for __rf[0] and again for __zcMkv. Besides constructing two schemas,
  // downstream content-hashing dedup could merge them and expose recursion if
  // the pristine delegate was not captured before mutation.
  it("evaluates a root-fallback expression once and still parses", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    // The original incident schema was z.strictObject; strict objects compile
    // now, and so does a value-validating .catchall(). A ctx-taking transform
    // is what keeps this a ROOT fallback — it collects issues through zod's
    // payload, so there is no call generated code can make.
    const expr = "z.strictObject({ id: z.string(), createdAt: z.date() }).transform((v, ctx) => v)";
    const source = [
      'import { z } from "zod";',
      `export const ProfessionalRoleShape = ${expr};`,
      "",
    ].join("\n");

    const dir = mkdtempSync(path.join(fixturesDir, ".dedup-"));
    try {
      const id = path.join(dir, "types.ts");
      writeFileSync(id, source);
      const transformed = await transformCode(source, id, {
        mode: "inline",
        autoDiscover: true,
      });
      expect(transformed).not.toBeNull();
      const out = transformed as string;

      expect(out.split(expr).length - 1).toBe(1);

      const outPath = path.join(dir, "types.compiled.ts");
      writeFileSync(outPath, out);
      const mod = (await import("#src/loader.js")).loadSourceFile;
      const exported = (await mod(outPath))["ProfessionalRoleShape"] as {
        safeParse: (input: unknown) => { success: boolean; error?: { issues: unknown[] } };
        parse: (input: unknown) => unknown;
      };

      const valid = { id: "role_1", createdAt: new Date() };
      expect(exported.safeParse(valid).success).toBe(true);
      expect(exported.parse(valid)).toEqual(valid);

      const invalid = exported.safeParse({ id: 1, createdAt: "nope" });
      expect(invalid.success).toBe(false);
      expect(invalid.error?.issues.length).toBeGreaterThan(0);

      const unknownKey = exported.safeParse({ ...valid, extra: true });
      expect(unknownKey.success).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("directive prologue", () => {
  /**
   * A directive is only a directive while it is still part of the prologue.
   * Anything the transform prepends at offset 0 demotes it to a plain string
   * expression, and RSC bundlers reject that outright ("The \"use client\"
   * directive must be placed before other expressions") — which broke every
   * Next.js file that exported a schema.
   */
  it("keeps 'use client' first when injecting the runtime prologue", async () => {
    const fixturePath = path.join(fixturesDir, "directive-use-client.ts");
    const code = fs.readFileSync(fixturePath, "utf8");

    const result = await transformCode(code, fixturePath, {
      mode: "inline",
      autoDiscover: true,
      zodCompat: true,
    });

    expect(result).not.toBeNull();
    expect(result).toContain("safeParse_SignupSchema");
    expect(result).toContain("function __zcMkv(");
    expect((result as string).startsWith('"use client";')).toBe(true);
  });

  it("keeps 'use server' first on the hoist-only path", async () => {
    const fixturePath = path.join(fixturesDir, "directive-hoist-only.ts");
    const code = fs.readFileSync(fixturePath, "utf8");

    const result = await transformCode(code, fixturePath, {
      mode: "inline",
      autoDiscover: true,
      zodCompat: true,
    });

    expect(result).not.toBeNull();
    // Hoisted out of the function body and compiled, so the runtime helpers
    // are injected even though the file exports no schema.
    expect(result).toContain("function __zcMkv(");
    expect((result as string).startsWith('"use server";')).toBe(true);
  });

  it("preserves a shebang, comments and a multi-directive prologue", async () => {
    const fixturePath = path.join(fixturesDir, "directive-prologue-edges.ts");
    const code = fs.readFileSync(fixturePath, "utf8");

    const result = await transformCode(code, fixturePath, {
      mode: "inline",
      autoDiscover: true,
      zodCompat: true,
    });

    expect(result).not.toBeNull();
    expect(result).toContain("safeParse_TaskSchema");
    const out = result as string;
    expect(out.startsWith("#!/usr/bin/env node\n")).toBe(true);
    // Both directives stay ahead of everything the transform emitted.
    expect(out.indexOf('"use strict";')).toBeLessThan(out.indexOf("function __zcMkv("));
    expect(out.indexOf('"use server";')).toBeLessThan(out.indexOf("function __zcMkv("));
    expect(out.indexOf('"use strict";')).toBeLessThan(out.indexOf('"use server";'));
  });
});

describe("moduleHeadOffset()", () => {
  it("returns 0 when there is no prologue", () => {
    expect(moduleHeadOffset('import { z } from "zod";')).toBe(0);
  });

  it("skips a shebang", () => {
    const code = "#!/usr/bin/env node\nconst a = 1;";
    expect(moduleHeadOffset(code)).toBe("#!/usr/bin/env node\n".length);
  });

  it("skips consecutive directives and the comments between them", () => {
    const code = '"use strict";\n// between\n"use client";\nconst a = 1;';
    expect(code.slice(moduleHeadOffset(code))).toBe("const a = 1;");
  });

  it("stops at the first statement, so a later string literal is not a directive", () => {
    const code = 'const a = 1;\n"use client";';
    expect(moduleHeadOffset(code)).toBe(0);
  });

  it.each([
    ["single quotes", "'use strict';\nconst a = 1;", "const a = 1;"],
    ["directives sharing a line", '"use strict"; "use client";\nconst a = 1;', "const a = 1;"],
    ["no semicolon (ASI)", '"use client"\nconst a = 1;', "const a = 1;"],
    ["CRLF", '"use client";\r\nconst a = 1;', "const a = 1;"],
    ["a leading block comment", '/* license */\n"use client";\nconst a = 1;', "const a = 1;"],
    ["an unrecognized directive", '"use cache";\nconst a = 1;', "const a = 1;"],
    ["a template literal", "`use client`;\nconst a = 1;", "`use client`;\nconst a = 1;"],
    ["a non-directive string", '"hello";\nconst a = 1;', '"hello";\nconst a = 1;'],
    // Only LOOKS like a directive: an expression statement whose first operand
    // is a "use " string. Treating it as one would insert on the `+`.
    ["a concatenation", '"use " + mode;\nconst a = 1;', '"use " + mode;\nconst a = 1;'],
    // Escaped quotes end the match early, which would insert mid-literal.
    ["an escaped quote", '"use \\"strict\\"";\nconst a = 1;', '"use \\"strict\\"";\nconst a = 1;'],
  ])("handles %s", (_label, code, rest) => {
    expect(code.slice(moduleHeadOffset(code))).toBe(rest);
  });

  it("returns the full length for a file that is only a prologue", () => {
    const code = '"use client";\n';
    expect(moduleHeadOffset(code)).toBe(code.length);
  });

  it("returns 0 for an empty file", () => {
    expect(moduleHeadOffset("")).toBe(0);
  });
});

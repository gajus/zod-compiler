import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadSourceFile } from "#src/loader.js";
import { hoistZodSchemas } from "#src/unplugin/hoist.js";
import { compileHoistedSchemas } from "#src/unplugin/hoist-compile.js";
import { transformCode } from "#src/unplugin/transform.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "hoist-compile");
const FIXTURE_ID = path.join(FIXTURE_DIR, "get-user.ts");

const ZOD_IMPORT = `import { z } from "zod";`;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Write transformed output next to real node_modules and import it. */
async function execute(code: string): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(path.join(tmpdir(), "zc-hoist-compile-"));
  tempDirs.push(dir);
  const file = path.join(dir, "out.ts");
  // Resolve zod from the repo (the temp dir has no node_modules).
  const zodDir = path.dirname(require.resolve("zod/package.json"));
  const rewritten = code.replace(/from "zod"/g, `from ${JSON.stringify(zodDir)}`);
  writeFileSync(file, rewritten);
  return loadSourceFile(file);
}

describe("compileHoistedSchemas()", () => {
  it("compiles a deterministic zod-only hoisted schema", async () => {
    const compiled = await compileHoistedSchemas(
      [{ name: "_zh_test1", text: "z.object({ id: z.number(), name: z.string() })" }],
      ZOD_IMPORT,
      FIXTURE_ID,
      "lean",
    );
    expect(compiled).toHaveLength(1);
    expect(compiled[0]?.info.codegenResult.fastFnName).toBeTruthy();
  });

  it("skips schemas with eager non-zod references (non-deterministic construction)", async () => {
    const compiled = await compileHoistedSchemas(
      [{ name: "_zh_test2", text: "z.date().min(new Date())" }],
      ZOD_IMPORT,
      FIXTURE_ID,
      "lean",
    );
    expect(compiled).toHaveLength(0);
  });

  it("skips schemas whose extraction needs unavailable deferred imports", async () => {
    const compiled = await compileHoistedSchemas(
      [{ name: "_zh_test3", text: "z.lazy(() => ChildSchema)" }],
      [ZOD_IMPORT, `import { ChildSchema } from "./child";`].join("\n"),
      FIXTURE_ID,
      "lean",
    );
    expect(compiled).toHaveLength(0);
  });

  it("compiles schemas with zero-capture refines", async () => {
    const compiled = await compileHoistedSchemas(
      [{ name: "_zh_test4", text: "z.string().refine((v) => v.length > 2)" }],
      ZOD_IMPORT,
      FIXTURE_ID,
      "lean",
    );
    expect(compiled).toHaveLength(1);
  });
});

describe("transformCode() — hoisted schema compilation", () => {
  it("replaces the hoisted decl with a compiled IIFE (slonik sql.type pattern)", async () => {
    const code = [
      ZOD_IMPORT,
      `const fakeSql = { type: (s: unknown) => s };`,
      `export const getRowSchema = (id: number) => {`,
      `  return fakeSql.type(`,
      `    z.object({`,
      `      id: z.number(),`,
      `      name: z.string(),`,
      `    }),`,
      `  );`,
      `};`,
    ].join("\n");

    const result = await transformCode(code, FIXTURE_ID, { mode: "inline", autoDiscover: true });
    expect(result).not.toBeNull();
    const out = result as string;
    expect(out).toMatch(/const _zh_[0-9a-f]{8} = \/\* @__PURE__ \*\/ \(\(\) => \{/);
    expect(out).toContain("return __zcMkv(");
    expect(out).toMatch(/fakeSql\.type\(\s*_zh_[0-9a-f]{8},?\s*\)/);

    // Execute the transformed module: the compiled validator must behave
    // like the zod schema (parse + safeParse parity on valid and invalid).
    const mod = await execute(out);
    const getRowSchema = mod["getRowSchema"] as (id: number) => {
      parse: (v: unknown) => unknown;
      safeParse: (v: unknown) => { success: boolean };
      _zod?: unknown;
    };
    const schema = getRowSchema(1);
    const valid = { id: 7, name: "alice" };
    expect(schema.parse(valid)).toBe(valid);
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ id: "x", name: 3 }).success).toBe(false);
    // zodCompat: the wrapper's prototype is the real zod schema
    expect(schema._zod).toBeTruthy();
  });

  it("leaves ineligible hoisted schemas as plain hoists", async () => {
    const code = [
      ZOD_IMPORT,
      `export function getSchema() { return z.date().min(new Date()); }`,
    ].join("\n");

    const result = await transformCode(code, FIXTURE_ID, { mode: "lean", autoDiscover: true });
    expect(result).not.toBeNull();
    expect(result).toMatch(/const _zh_[0-9a-f]{8} = z\.date\(\)\.min\(new Date\(\)\);/);
    expect(result).not.toContain("__zcMkv");
  });

  it("does not compile hoisted schemas outside autoDiscover mode", async () => {
    const code = [
      ZOD_IMPORT,
      `export function getSchema() { return z.object({ a: z.string() }); }`,
    ].join("\n");

    const result = await transformCode(code, FIXTURE_ID, { mode: "lean" });
    expect(result).not.toBeNull();
    expect(result).toMatch(/const _zh_[0-9a-f]{8} = z\.object\(\{ a: z\.string\(\) \}\);/);
    expect(result).not.toContain("__zcMkv");
  });

  it("compiled output is inert on re-hoisting (idempotent)", async () => {
    const code = [
      ZOD_IMPORT,
      `const api = { type: (s: unknown) => s };`,
      `export const f = () => api.type(z.object({ a: z.string() }));`,
    ].join("\n");
    const result = await transformCode(code, FIXTURE_ID, { mode: "inline", autoDiscover: true });
    expect(result).toContain("__zcMkv");
    expect(hoistZodSchemas(result as string)).toBeNull();
  });
});

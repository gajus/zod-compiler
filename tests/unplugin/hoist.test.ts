import { describe, expect, it } from "vitest";
import { hoistZodSchemas } from "#src/unplugin/hoist.js";
import { transformCode } from "#src/unplugin/transform.js";

const ZOD_IMPORT = `import { z } from "zod";`;

describe("hoistZodSchemas()", () => {
  describe("hoists", () => {
    it("schema returned from a function body (README example)", () => {
      const code = [
        ZOD_IMPORT,
        `export function getSchema() {`,
        `  return z.object({ name: z.string() });`,
        `}`,
      ].join("\n");

      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      expect(result).toMatch(/^const _zh_[0-9a-f]{8} = z\.object\(\{ name: z\.string\(\) \}\);/);
      expect(result).toMatch(/return _zh_[0-9a-f]{8};/);
      expect(result).not.toMatch(/return z\.object/);
    });

    it("schema inside an arrow function body", () => {
      const code = [
        ZOD_IMPORT,
        `export const useLoginSchema = () => {`,
        `  return z.object({ email: z.email(), password: z.string().min(8) });`,
        `};`,
      ].join("\n");

      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      expect(result).toMatch(/return _zh_[0-9a-f]{8};/);
    });

    it("dedupes identical schemas to a single declaration", () => {
      const code = [
        ZOD_IMPORT,
        `export function a() { return z.object({ id: z.number() }); }`,
        `export function b() { return z.object({ id: z.number() }); }`,
      ].join("\n");

      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      const decls = result?.match(/const _zh_[0-9a-f]{8} =/g) ?? [];
      expect(decls).toHaveLength(1);
      const refs = result?.match(/return _zh_[0-9a-f]{8};/g) ?? [];
      expect(refs).toHaveLength(2);
    });

    it("whole combinator chains", () => {
      const code = [
        ZOD_IMPORT,
        `export function f() {`,
        `  return z.object({ a: z.string() }).extend({ b: z.number() }).partial();`,
        `}`,
      ].join("\n");

      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      expect(result).toContain(
        `= z.object({ a: z.string() }).extend({ b: z.number() }).partial();`,
      );
      expect(result).toMatch(/return _zh_[0-9a-f]{8};/);
    });

    it("schemas with refine arrows (params are not captures)", () => {
      const code = [
        ZOD_IMPORT,
        `export function f() {`,
        `  return z.string().refine((v) => v.length > 0 && /^[a-z]+$/.test(v));`,
        `}`,
      ].join("\n");

      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      expect(result).toMatch(/return _zh_[0-9a-f]{8};/);
    });

    it("schemas referencing other imported bindings", () => {
      const code = [
        ZOD_IMPORT,
        `import { RoleEnum } from "./roles";`,
        `export function f() { return z.object({ role: RoleEnum }); }`,
      ].join("\n");

      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      expect(result).toMatch(/return _zh_[0-9a-f]{8};/);
    });

    it("combinator chains rooted at imports matching /ZodSchema$/", () => {
      const code = [
        `import { UserZodSchema } from "./schemas";`,
        `export function f() { return UserZodSchema.partial(); }`,
      ].join("\n");

      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      expect(result).toContain(`const _zh_`);
      expect(result).toContain(`= UserZodSchema.partial();`);
    });

    it("combinator chains on imported bases with inline z", () => {
      const code = [
        ZOD_IMPORT,
        `import { Base } from "./schemas";`,
        `export function f() { return Base.extend({ extra: z.string() }); }`,
      ].join("\n");

      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      expect(result).toContain(`= Base.extend({ extra: z.string() });`);
    });

    it("aliased zod imports", () => {
      const code = [
        `import { z as zod } from "zod";`,
        `export function f() { return zod.object({ a: zod.boolean() }); }`,
      ].join("\n");

      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      expect(result).toMatch(/return _zh_[0-9a-f]{8};/);
    });

    it("schemas in JSX attributes", () => {
      const code = [
        ZOD_IMPORT,
        `import { Form } from "./form";`,
        `export const Page = () => {`,
        `  return <Form schema={z.object({ q: z.string() })} />;`,
        `};`,
      ].join("\n");

      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      expect(result).toMatch(/schema=\{_zh_[0-9a-f]{8}\}/);
    });

    it("peels parse calls — construction hoists, evaluation stays put", () => {
      const code = [ZOD_IMPORT, `export function f() { return z.string().parse("x"); }`].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      expect(result).toMatch(/const _zh_[0-9a-f]{8} = z\.string\(\);/);
      expect(result).toMatch(/return _zh_[0-9a-f]{8}\.parse\("x"\);/);
    });

    it("peels safeParseAsync the same way", () => {
      const code = [
        ZOD_IMPORT,
        `export async function validate(input: unknown) { return z.string().safeParseAsync(input); }`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      expect(result).toMatch(/return _zh_[0-9a-f]{8}\.safeParseAsync\(input\);/);
    });

    it("peels parse with an await argument", () => {
      const code = [
        ZOD_IMPORT,
        `import { fetchData } from "./api";`,
        `export async function getData() {`,
        `  return z.object({ data: z.string() }).parse(await fetchData());`,
        `}`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      expect(result).toMatch(/const _zh_[0-9a-f]{8} = z\.object\(\{ data: z\.string\(\) \}\);/);
      expect(result).toMatch(/return _zh_[0-9a-f]{8}\.parse\(await fetchData\(\)\);/);
    });

    it("top-level concise arrow bodies (re-evaluated per call)", () => {
      const code = [ZOD_IMPORT, `export const make = () => z.object({ a: z.string() });`].join(
        "\n",
      );
      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      expect(result).toMatch(/=> _zh_[0-9a-f]{8};/);
    });

    it("chained scalar schemas", () => {
      const code = [
        ZOD_IMPORT,
        `export function f() { return z.string().min(1).max(100).optional(); }`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toContain(`= z.string().min(1).max(100).optional();`);
    });

    it("multiple different schemas get separate declarations", () => {
      const code = [
        ZOD_IMPORT,
        `export function a() { return z.string(); }`,
        `export function b() { return z.number(); }`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      const decls = result?.match(/const _zh_[0-9a-f]{8} =/g) ?? [];
      expect(decls).toHaveLength(2);
    });

    it("deeply nested functions", () => {
      const code = [
        ZOD_IMPORT,
        `export function outer() {`,
        `  function inner() { return z.string(); }`,
        `  return inner;`,
        `}`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toMatch(/function inner\(\) \{ return _zh_[0-9a-f]{8}; \}/);
    });

    it("both branches of ternary returns", () => {
      const code = [
        ZOD_IMPORT,
        `export function f(condition: boolean) { return condition ? z.string() : z.number(); }`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toMatch(/condition \? _zh_[0-9a-f]{8} : _zh_[0-9a-f]{8};/);
    });

    it("schemas assigned to locals inside a function", () => {
      const code = [ZOD_IMPORT, `export function f() { const s = z.string(); return s; }`].join(
        "\n",
      );
      const result = hoistZodSchemas(code);
      expect(result).toMatch(/const s = _zh_[0-9a-f]{8};/);
    });

    it("namespace zod imports", () => {
      const code = [`import * as z from "zod";`, `export function f() { return z.string(); }`].join(
        "\n",
      );
      const result = hoistZodSchemas(code);
      expect(result).toMatch(/return _zh_[0-9a-f]{8};/);
    });

    it("schemas passed as call arguments", () => {
      const code = [
        ZOD_IMPORT,
        `import { someValidator } from "./v";`,
        `export function validate() { return someValidator(z.string()); }`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toMatch(/someValidator\(_zh_[0-9a-f]{8}\)/);
    });

    it("multiline arguments with trailing commas (assignment-level parse)", () => {
      // A trailing comma after the schema argument must not start a
      // sequence-expression parse that throws on the surrounding `)`.
      const code = [
        ZOD_IMPORT,
        `import { sql } from "slonik";`,
        `import { pool } from "./pool";`,
        `const getUser = (id: number) => {`,
        `  return pool.one(`,
        `    sql.type(`,
        `      z.object({`,
        `        id: z.number(),`,
        `        name: z.string(),`,
        `      }),`,
        "    )`SELECT id, name FROM users WHERE id = ${id}`,",
        `  );`,
        `};`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toMatch(/const _zh_[0-9a-f]{8} = z\.object\(\{/);
      expect(result).toMatch(/sql\.type\(\s*_zh_[0-9a-f]{8},\s*\)`SELECT/);
      // the whole construction was hoisted — no stray inner z.* hoists
      expect(result).not.toMatch(/= z\.number\(\);/);
    });

    it("schemas inside member-call arguments (slonik sql.type pattern)", () => {
      const code = [
        ZOD_IMPORT,
        `import { sql } from "slonik";`,
        `import { pool } from "./pool";`,
        "const getUser = (id: number) => pool.one(sql.type(z.object({ id: z.number(), name: z.string() }))`SELECT id, name FROM users WHERE id = ${id}`);",
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toMatch(
        /const _zh_[0-9a-f]{8} = z\.object\(\{ id: z\.number\(\), name: z\.string\(\) \}\);/,
      );
      expect(result).toMatch(/sql\.type\(_zh_[0-9a-f]{8}\)`SELECT/);
    });

    it("combinator chains on imported bases inside member-call arguments", () => {
      // babel-plugin-zod-hoist: `pool.any(sql.type(CategoryShape.extend({...})))`
      // hoists the extend chain as one unit.
      const code = [
        ZOD_IMPORT,
        `import { CategoryShape } from "./shapes";`,
        `import { sql } from "slonik";`,
        `import { pool } from "./pool";`,
        "export function resolve() { return pool.any(sql.type(CategoryShape.extend({ dataLoaderKey: z.number() }))`SELECT 1`); }",
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toMatch(
        /const _zh_[0-9a-f]{8} = CategoryShape\.extend\(\{ dataLoaderKey: z\.number\(\) \}\);/,
      );
      expect(result).toMatch(/sql\.type\(_zh_[0-9a-f]{8}\)`SELECT 1`/);
    });

    it("eager globals and new expressions (babel canSafelyHoist allows them)", () => {
      // The babel plugin only rejects file-bound identifiers and `this`;
      // unbound globals and `new` are permitted even in eager positions.
      const newDate = [
        ZOD_IMPORT,
        `export function f() { return z.date().default(new Date()); }`,
      ].join("\n");
      expect(hoistZodSchemas(newDate)).toMatch(
        /const _zh_[0-9a-f]{8} = z\.date\(\)\.default\(new Date\(\)\);/,
      );

      const mathRandom = [
        ZOD_IMPORT,
        `export function f() { return z.number().default(Math.random()); }`,
      ].join("\n");
      expect(hoistZodSchemas(mathRandom)).toMatch(
        /const _zh_[0-9a-f]{8} = z\.number\(\)\.default\(Math\.random\(\)\);/,
      );
    });

    it("combinator methods from the full babel set (e.g. .optional() on a ZodSchema base)", () => {
      const code = [
        ZOD_IMPORT,
        `import { UserZodSchema } from "./schemas";`,
        `export function f() { return UserZodSchema.optional(); }`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toMatch(/const _zh_[0-9a-f]{8} = UserZodSchema\.optional\(\);/);
    });

    it("schemas inside returned object literals", () => {
      const code = [
        ZOD_IMPORT,
        `export function getSchemas() { return { name: z.string(), age: z.number() }; }`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toMatch(/name: _zh_[0-9a-f]{8}, age: _zh_[0-9a-f]{8}/);
    });

    it("z.coerce schemas", () => {
      const code = [ZOD_IMPORT, `export function f() { return z.coerce.number(); }`].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toMatch(/return _zh_[0-9a-f]{8};/);
    });

    it("class methods", () => {
      const code = [
        ZOD_IMPORT,
        `export class Validator { getSchema() { return z.object({ value: z.number() }); } }`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toMatch(/getSchema\(\) \{ return _zh_[0-9a-f]{8}; \}/);
    });

    it("only the inner z.* when the chain base is a module-level const (TDZ)", () => {
      const code = [
        ZOD_IMPORT,
        `const baseSchema = z.object({ id: z.string() });`,
        `export function f() { return baseSchema.extend({ name: z.string() }); }`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      // The outer chain stays (baseSchema is a module binding) but the inner
      // z.string() is hoisted.
      expect(result).toMatch(/return baseSchema\.extend\(\{ name: _zh_[0-9a-f]{8} \}\);/);
    });

    it("imported-base combinator chains with non-combinator tails as one unit", () => {
      const code = [
        ZOD_IMPORT,
        `import { CategoryShape } from "./shapes";`,
        `export function f() { return CategoryShape.extend({ key: z.number() }).optional(); }`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toContain(`= CategoryShape.extend({ key: z.number() }).optional();`);
      expect(result).toMatch(/return _zh_[0-9a-f]{8};/);
    });

    it("z.lazy chains with deferred imported references", () => {
      const code = [
        ZOD_IMPORT,
        `import { ChildSchema } from "./child";`,
        `export function f() { return z.lazy(() => z.object({ child: ChildSchema })); }`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toMatch(/return _zh_[0-9a-f]{8};/);
    });

    it("safe globals inside deferred callbacks", () => {
      const code = [
        ZOD_IMPORT,
        `export function f() { return z.string().refine((v) => Number.isFinite(Number(v))); }`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toMatch(/return _zh_[0-9a-f]{8};/);
    });

    it("new expressions inside deferred callbacks (run per parse)", () => {
      const code = [
        ZOD_IMPORT,
        `export function f() { return z.date().refine((d) => d < new Date()); }`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toMatch(/return _zh_[0-9a-f]{8};/);
    });

    it("keeps directive prologues first", () => {
      const code = [
        `"use client";`,
        ZOD_IMPORT,
        `export function f() { return z.object({ a: z.string() }); }`,
      ].join("\n");

      const result = hoistZodSchemas(code);
      expect(result).not.toBeNull();
      expect(result?.startsWith(`"use client";`)).toBe(true);
      expect(result).toMatch(/"use client";\s*\nconst _zh_/);
    });
  });

  describe("does not hoist", () => {
    it("top-level schema declarations (already module scope)", () => {
      const code = [ZOD_IMPORT, `export const UserSchema = z.object({ name: z.string() });`].join(
        "\n",
      );
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("nested z calls inside a top-level schema", () => {
      const code = [
        ZOD_IMPORT,
        `export const A = z.object({`,
        `  name: z.string(),`,
        `  tags: z.array(z.string()),`,
        `});`,
      ].join("\n");
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("nested z calls in top-level chains with comment/optional/non-null segment gaps", () => {
      // Depth-0 extents are computed by the cheap chain scanner (no acorn);
      // these segment separators must not end the mask early — an early end
      // would hoist the interior of a module-scope expression.
      const code = [
        ZOD_IMPORT,
        `export const A = z.object({ a: z.array(z.string()) }) /* strict! */ .strict();`,
        `export const B = z.object({ b: z.string() })?.shape;`,
        `export const C = z.object({ c: z.string() })!.shape;`,
        `export const D = z`,
        `  .object({ d: z.array(z.number()) })`,
        `  .strict();`,
      ].join("\n");
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("nested z calls inside a top-level tagged-template chain (slonik at module scope)", () => {
      const code = [
        ZOD_IMPORT,
        `import { sql } from "slonik";`,
        "export const q = sql.type(z.object({ id: z.number() }))`SELECT ${1} AS id`;",
      ].join("\n");
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("expressions capturing function locals", () => {
      const code = [
        ZOD_IMPORT,
        `export function f(min: number) { return z.string().min(min); }`,
      ].join("\n");
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("expressions referencing module-level bindings (imports-only rule)", () => {
      const code = [
        ZOD_IMPORT,
        `const MAX = 100;`,
        `export function f() { return z.string().max(MAX); }`,
      ].join("\n");
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("expressions referencing let variables (mutable)", () => {
      const code = [
        ZOD_IMPORT,
        `let limit = 10;`,
        `export function f() { return z.string().max(limit); }`,
      ].join("\n");
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("expressions using this", () => {
      const code = [ZOD_IMPORT, `export class V { f() { return z.literal(this.kind); } }`].join(
        "\n",
      );
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("TS generic calls acorn cannot parse", () => {
      const code = [
        ZOD_IMPORT,
        `export function f() { return z.custom<{ a: 1 }>(() => true); }`,
      ].join("\n");
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("non-combinator chains on imported bases as a unit (inner z.* hoists alone)", () => {
      // babel-plugin-zod-hoist parity: `api.get(...)` itself is never a
      // hoist (root isn't zod, `get` isn't a combinator), but its argument
      // is an independent schema construction and hoists on its own.
      const code = [
        ZOD_IMPORT,
        `import { api } from "./api";`,
        `export function f() { return api.get(z.string()); }`,
      ].join("\n");
      const result = hoistZodSchemas(code);
      expect(result).toMatch(/const _zh_[0-9a-f]{8} = z\.string\(\);/);
      expect(result).toMatch(/return api\.get\(_zh_[0-9a-f]{8}\);/);
    });

    it("files without runtime zod imports", () => {
      const code = `export function f() { return z.object({}); }`;
      expect(hoistZodSchemas(code)).toBeNull();

      const typeOnly = [
        `import type { z } from "zod";`,
        `export function f(s: z.ZodType) { return s; }`,
      ].join("\n");
      expect(hoistZodSchemas(typeOnly)).toBeNull();
    });

    it("z tokens inside strings and comments", () => {
      const code = [
        ZOD_IMPORT,
        `export function f() {`,
        `  // builds z.object({ a: z.string() }) lazily`,
        `  const example = "z.object({ b: z.number() })";`,
        `  return example;`,
        `}`,
      ].join("\n");
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("when the root is shadowed by a function parameter", () => {
      const code = [ZOD_IMPORT, `export function makeSchema(z) { return z.string(); }`].join("\n");
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("when the root is shadowed by a local variable", () => {
      const code = [
        ZOD_IMPORT,
        `export function getSchema() {`,
        `  const z = { string: () => "fake" };`,
        `  return z.string();`,
        `}`,
      ].join("\n");
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("when a referenced import is shadowed by a parameter", () => {
      const code = [
        ZOD_IMPORT,
        `import { RoleEnum } from "./roles";`,
        `export function f(RoleEnum) { return z.object({ role: RoleEnum }); }`,
      ].join("\n");
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("when z comes from a non-zod package", () => {
      const code = [
        `import { z } from "not-zod";`,
        `export function f() { return z.string(); }`,
      ].join("\n");
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("imported-base combinator chains without any z reference (dayjs)", () => {
      const code = [
        ZOD_IMPORT,
        `import dayjs from "dayjs";`,
        `import utc from "dayjs/plugin/utc";`,
        `export function setup() { return dayjs.extend(utc); }`,
      ].join("\n");
      expect(hoistZodSchemas(code)).toBeNull();
    });

    it("its own output (idempotent)", () => {
      const code = [
        ZOD_IMPORT,
        `export function getSchema() { return z.object({ name: z.string() }); }`,
      ].join("\n");
      const once = hoistZodSchemas(code);
      expect(once).not.toBeNull();
      expect(hoistZodSchemas(once as string)).toBeNull();
    });
  });

  describe("schemaNamePattern option", () => {
    it("custom RegExp pattern enables non-default roots", () => {
      const code = [
        `import { PaymentShape } from "./shapes";`,
        `export function f() { return PaymentShape.pick({ id: true }); }`,
      ].join("\n");
      expect(hoistZodSchemas(code)).toBeNull();
      const result = hoistZodSchemas(code, { schemaNamePattern: /Shape$/ });
      expect(result).toContain(`= PaymentShape.pick({ id: true });`);
    });

    it("string patterns are compiled as RegExp source", () => {
      const code = [
        `import { BaseShape } from "./shapes";`,
        `export function f() { return BaseShape.partial(); }`,
      ].join("\n");
      const result = hoistZodSchemas(code, { schemaNamePattern: "Shape$" });
      expect(result).toContain(`= BaseShape.partial();`);
    });

    it("null disables name-based matching", () => {
      const code = [
        `import { UserZodSchema } from "./schemas";`,
        `export function f() { return UserZodSchema.pick({ id: true }); }`,
      ].join("\n");
      expect(hoistZodSchemas(code, { schemaNamePattern: null })).toBeNull();
    });
  });
});

describe("transformCode() — hoist integration", () => {
  it("returns hoisted code for files with no compilable exports", async () => {
    const code = [
      ZOD_IMPORT,
      `export function validate(input: unknown) {`,
      `  return z.object({ name: z.string() }).safeParse(input);`,
      `}`,
    ].join("\n");

    const result = await transformCode(code, "/src/validate.ts", {
      mode: "lean",
      autoDiscover: true,
    });

    expect(result).not.toBeNull();
    expect(result).toContain("const _zh_");
    expect(result).toMatch(/return _zh_[0-9a-f]{8}\.safeParse\(input\);/);
  });

  it("hoists in compile mode files without compile() calls", async () => {
    const code = [
      ZOD_IMPORT,
      `export function getSchema() { return z.object({ a: z.string() }); }`,
    ].join("\n");

    const result = await transformCode(code, "/src/util.ts", { mode: "lean" });

    expect(result).not.toBeNull();
    expect(result).toContain("const _zh_");
  });

  it("respects hoist: false", async () => {
    const code = [
      ZOD_IMPORT,
      `export function getSchema() { return z.object({ a: z.string() }); }`,
    ].join("\n");

    const result = await transformCode(code, "/src/util.ts", { mode: "lean", hoist: false });

    expect(result).toBeNull();
  });

  it("returns null when hoisting finds nothing and no schemas compile", async () => {
    const code = [ZOD_IMPORT, `export function f(s: string) { return s; }`].join("\n");

    const result = await transformCode(code, "/src/util.ts", { mode: "lean", autoDiscover: true });

    expect(result).toBeNull();
  });
});

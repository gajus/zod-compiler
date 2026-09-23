import { describe, expect, it } from "vite-plus/test";
import { ZodRealError, z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import {
  FAIL_CLASS_DECL,
  FIN_DECL,
  FIN_DEFERRED_DECL,
  generateIIFE,
  MK_VALIDATOR_DECL,
} from "#src/core/iife.js";
import type { CompiledSchemaInfo } from "#src/core/pipeline.js";
import { zcMsg } from "../parity-harness.js";

type MkvFn = (
  fn: (input: unknown) => { success: true; data: unknown } | { success: false; error: unknown },
  schema: object | null,
) => Record<string, unknown>;

const __zcMkv = new Function(`${MK_VALIDATOR_DECL}; return __zcMkv;`)() as MkvFn;
// __zcFin needs __zcMsg and __zcZodError in scope; both are passed per-execution
type FinFn = (e: unknown[], d: unknown) => { success: boolean; data?: unknown; error?: unknown };
function makeFinFn(msg: unknown, ZodError: unknown): FinFn {
  return new Function("__zcMsg", "__zcZodError", `${FAIL_CLASS_DECL}${FIN_DECL}; return __zcFin;`)(
    msg,
    ZodError,
  ) as FinFn;
}

function makeInfo(exportName: string, schema: z.ZodType): CompiledSchemaInfo {
  const ir = extractSchema(schema);
  const codegenResult = generateValidator(ir, exportName);
  return { exportName, codegenResult, refEntries: [] };
}

function makeInfoWithFallback(exportName: string, schema: z.ZodType): CompiledSchemaInfo {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const codegenResult = generateValidator(ir, exportName, {
    refCount: refEntries.length,
  });
  return { exportName, codegenResult, refEntries };
}

describe("generateIIFE()", () => {
  const simpleSchema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive(),
  });

  it("includes preamble declarations", () => {
    const info = makeInfo(
      "validateRole",
      z.enum(["admin", "user", "editor", "viewer", "owner", "bot"]),
    );
    const iife = generateIIFE("RoleSchema", info);

    expect(iife).toContain('new Set(["admin","user","editor","viewer","owner","bot"])');
    expect(iife).toContain("/* @__PURE__ */");
  });

  it("delegates parse() throw to __zcMkv factory", () => {
    const info = makeInfo("validateNum", z.number());
    const iife = generateIIFE("NumSchema", info);

    // throw/parse logic lives in __zcMkv now; IIFE just calls __zcMkv
    expect(iife).toMatch(/return __zcMkv\(safeParse_validateNum,NumSchema,__fc_\d+,__fc_\d+\);/);
    expect(iife).not.toContain("throw r.error");
  });

  it("includes __rf when schema has fallbacks (captured-variable transform)", () => {
    // Use a captured variable to ensure fallback (zero-capture transforms are now compiled)
    const prefix = "prefix_";
    const schema = z.object({
      name: z.string(),
      slug: z.string().transform((v) => prefix + v),
    });
    const info = makeInfoWithFallback("validateUser", schema);
    const iife = generateIIFE("UserSchema", info);

    expect(iife).toContain("var __rf=");
    expect(iife).toContain("var __zs=UserSchema");
    expect(iife).toContain('__zs.shape["slug"]');
  });

  it("evaluates a schema expression once when multiple refs use it", () => {
    const prefix = "prefix_";
    const schema = z.object({
      first: z.string().transform((v) => prefix + v),
      second: z.string().transform((v) => prefix + v),
    });
    const info = makeInfoWithFallback("validateUser", schema);
    const iife = generateIIFE("makeSchema()", info);

    expect(iife.split("makeSchema()")).toHaveLength(2);
    expect(iife).toContain('__zs.shape["first"]');
    expect(iife).toContain('__zs.shape["second"]');
    expect(iife).toContain("__zcMkv(safeParse_validateUser,__zs,");
  });

  it("binds the retained schema without an __rf array (compact delegation)", () => {
    // The delegate needs the schema itself, nothing else. Routing that through
    // `__rf` cost every compact validator a one-element array whose only reads
    // were `__rf[0]` — an allocation per compiled schema at module init.
    const refEntries: RefEntry[] = [];
    const ir = extractSchema(z.object({ name: z.string().min(1) }), refEntries);
    const codegenResult = generateValidator(ir, "validateUser", {
      refCount: refEntries.length,
      compact: true,
    });
    const iife = generateIIFE("UserSchema", {
      exportName: "validateUser",
      codegenResult,
      refEntries,
    });

    expect(iife).toContain("var __zs=UserSchema;");
    expect(iife).toContain("__zcFinZ(__rfm_z,__zs,input)");
    expect(iife).not.toContain("__rf=");
    expect(iife).not.toContain("__rf[");
  });

  it("still binds the retained schema for compact under zodCompat: false", () => {
    // `__zcMkv` gets `null`, but the delegate still reads `__zs` — the binding
    // is owed to the generated code, not to the identity-preserving install.
    const refEntries: RefEntry[] = [];
    const ir = extractSchema(z.object({ name: z.string().min(1) }), refEntries);
    const codegenResult = generateValidator(ir, "validateUser", {
      refCount: refEntries.length,
      compact: true,
    });
    const iife = generateIIFE(
      "UserSchema",
      { exportName: "validateUser", codegenResult, refEntries },
      { zodCompat: false },
    );

    expect(iife).toContain("var __zs=UserSchema;");
    expect(iife).toMatch(/return __zcMkv\(safeParse_validateUser,null,/);
  });

  it("has no __rf when schema has zero-capture transform (compiled as effect)", () => {
    const schema = z.object({
      name: z.string(),
      slug: z.string().transform((v) => v.toLowerCase()),
    });
    const info = makeInfoWithFallback("validateUser", schema);
    const iife = generateIIFE("UserSchema", info);

    // Zero-capture transforms are compiled, so no fallback needed
    expect(iife).not.toContain("__rf");
  });

  it("has no __rf when schema has no fallbacks", () => {
    const info = makeInfo("validateUser", z.object({ name: z.string() }));
    const iife = generateIIFE("UserSchema", info);

    expect(iife).not.toContain("__rf");
  });

  it("uses __zcMkv factory with schema arg (zodCompat: true)", () => {
    const info = makeInfo("validateUser", simpleSchema);
    const iife = generateIIFE("UserSchema", info);

    // A stripping object rebuilds its output, so there is no by-reference
    // parse shortcut (fc is null) — but `.is()` still gets the exact predicate.
    expect(iife).toMatch(/return __zcMkv\(safeParse_validateUser,UserSchema,null,__fc_\d+\);/);
    expect(iife).not.toContain("var __w=");
    expect(iife).not.toContain("__w.schema=");
  });

  describe("zodCompat: false", () => {
    it("uses __zcMkv factory with null schema arg", () => {
      const info = makeInfo("validateUser", simpleSchema);
      const iife = generateIIFE("UserSchema", info, { zodCompat: false });

      expect(iife).toContain("/* @__PURE__ */");
      expect(iife).toMatch(/return __zcMkv\(safeParse_validateUser,null,null,__fc_\d+\);/);
      expect(iife).not.toContain("Object.create");
      expect(iife).not.toContain("var __w=");
    });
  });
});

describe("generateIIFE() — error handling", () => {
  it("throws when functionDef is malformed", () => {
    const info: CompiledSchemaInfo = {
      exportName: "test",
      codegenResult: {
        code: "/* zod-compiler */",
        functionDef: "const x = 1;",
        refCount: 0,
        usedHelpers: new Set(),
      },
      refEntries: [],
    };
    expect(() => generateIIFE("Schema", info)).toThrow(
      "Cannot extract function name from generated code",
    );
  });

  it("throws when functionDef is empty", () => {
    const info: CompiledSchemaInfo = {
      exportName: "test",
      codegenResult: {
        code: "/* zod-compiler */",
        functionDef: "",
        refCount: 0,
        usedHelpers: new Set(),
      },
      refEntries: [],
    };
    expect(() => generateIIFE("Schema", info)).toThrow(
      "Cannot extract function name from generated code",
    );
  });
});

describe("generateIIFE() — runtime execution", () => {
  const simpleSchema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive(),
  });

  function executeIIFE(schema: CompiledSchemaInfo, options?: { zodCompat?: boolean }) {
    const iife = generateIIFE("Schema", schema, options);
    const __zcFin = makeFinFn(zcMsg, ZodRealError);
    const fn = new Function(
      "Schema",
      "__zcMsg",
      "__zcZodError",
      "__zcMkv",
      "__zcFin",
      `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}\nreturn ${iife};`,
    );
    return fn({}, zcMsg, ZodRealError, __zcMkv, __zcFin) as {
      parse: (input: unknown) => unknown;
      safeParse: (input: unknown) => {
        success: boolean;
        data?: unknown;
        error?: { issues: unknown[] };
      };
      safeParseAsync: (
        input: unknown,
      ) => Promise<{ success: boolean; data?: unknown; error?: unknown }>;
      parseAsync: (input: unknown) => Promise<unknown>;
      is: (input: unknown) => boolean;
    };
  }

  it("safeParse returns success for valid input", () => {
    const validator = executeIIFE(makeInfo("validateUser", simpleSchema));
    const result = validator.safeParse({ name: "Alice", age: 30 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "Alice", age: 30 });
  });

  it("safeParse returns failure for invalid input", () => {
    const validator = executeIIFE(makeInfo("validateUser", simpleSchema));
    const result = validator.safeParse({ name: "", age: -5 });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("parse throws on invalid input", () => {
    const validator = executeIIFE(makeInfo("validateUser", simpleSchema));

    expect(() => validator.parse({ name: 123 })).toThrow();
    expect(validator.parse({ name: "Alice", age: 30 })).toEqual({ name: "Alice", age: 30 });
  });

  it("safeParseAsync returns Promise", async () => {
    const validator = executeIIFE(makeInfo("validateUser", simpleSchema));
    const result = await validator.safeParseAsync({ name: "Alice", age: 30 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "Alice", age: 30 });
  });

  it("parseAsync resolves for valid input", async () => {
    const validator = executeIIFE(makeInfo("validateUser", simpleSchema));
    const data = await validator.parseAsync({ name: "Alice", age: 30 });

    expect(data).toEqual({ name: "Alice", age: 30 });
  });

  it("parseAsync rejects for invalid input", async () => {
    const validator = executeIIFE(makeInfo("validateUser", simpleSchema));

    await expect(validator.parseAsync({ name: 123 })).rejects.toThrow();
  });

  it("produces error messages when __zcMsg is provided", () => {
    const validator = executeIIFE(makeInfo("validateUser", simpleSchema));

    const result = validator.safeParse("not an object");
    expect(result.success).toBe(false);
    const issues = result.error?.issues as Record<string, unknown>[];
    expect(issues?.[0]).toHaveProperty("message");
    expect(typeof issues?.[0]?.["message"]).toBe("string");
  });

  it("matches Zod behavior", () => {
    const validator = executeIIFE(makeInfo("validateUser", simpleSchema));

    const inputs = [
      { name: "Alice", age: 30 },
      { name: "", age: 30 },
      { name: "Bob", age: -1 },
      { name: "Carol", age: 1.5 },
      { name: 123, age: 30 },
      "not an object",
      null,
    ];

    for (const input of inputs) {
      const zodResult = simpleSchema.safeParse(input);
      const aotResult = validator.safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("works with zodCompat: false", () => {
    const validator = executeIIFE(makeInfo("validateUser", simpleSchema), { zodCompat: false });

    expect(validator.safeParse({ name: "Alice", age: 30 }).success).toBe(true);
    expect(validator.safeParse({ name: "", age: -1 }).success).toBe(false);
  });

  describe("is() — boolean type guard", () => {
    it("returns a bare boolean matching safeParse().success (total fast path)", () => {
      const validator = executeIIFE(makeInfo("validateUser", simpleSchema));
      const inputs = [
        { name: "Alice", age: 30 },
        { name: "", age: 30 },
        { name: "Bob", age: -1 },
        { name: 123, age: 30 },
        "not an object",
        null,
        undefined,
        [],
      ];
      for (const input of inputs) {
        const got = validator.is(input);
        expect(typeof got).toBe("boolean");
        expect(got).toBe(simpleSchema.safeParse(input).success);
      }
    });

    it("is the compiled fast-check itself for total schemas (zero allocation)", () => {
      const info = makeInfo("validateUser", simpleSchema);
      const validator = executeIIFE(info);
      // The IIFE passes the predicate as the 4th __zcMkv arg, so `.is` IS that
      // function — not a closure over safeParse. A stripping object rebuilds
      // its output, so it has no by-reference `fc` (3rd arg null) while the
      // predicate stays exact: stripping reshapes the payload, not the verdict.
      const iife = generateIIFE("Schema", info);
      const isName = /,null,(__fc_\d+)\)/.exec(iife)?.[1];
      expect(isName, "total schema should pass its predicate as the is arg").toBeTruthy();
      expect(validator.is({ name: "Alice", age: 30 })).toBe(true);
      expect(validator.is({ name: "Alice" })).toBe(false);
    });

    it("is the compiled fast-check for records and loose/catchall objects too", () => {
      // These hand their input back with any own `__proto__` scrubbed, so `fc`
      // is withheld from parse() (3rd arg null) — but the verdict is exact, so
      // `.is` is still the predicate rather than a closure over safeParse.
      const cases: [string, z.ZodType][] = [
        ["record", z.record(z.string(), z.number())],
        ["loose", z.looseObject({ a: z.string() })],
        ["catchall", z.object({ a: z.string() }).catchall(z.number())],
      ];
      for (const [name, schema] of cases) {
        const info = makeInfo(name, schema);
        expect(generateIIFE("Schema", info), name).toMatch(/,null,__fc_\d+\)/);
        const validator = executeIIFE(info);
        for (const input of [
          { a: "x", n: 1 },
          { a: 1 },
          JSON.parse('{"__proto__": 1, "a": "x"}'),
          [],
          null,
        ]) {
          expect(validator.is(input), `${name} ${JSON.stringify(input)}`).toBe(
            schema.safeParse(input).success,
          );
        }
      }
    });

    it("installs the acceptance predicate as the guard even when a default is substituted", () => {
      // The by-reference fast form only shortcuts present-and-valid input, so it
      // would be unsound here: a `false` does not imply rejection when the
      // default may rescue a missing key. A rebuilding schema's expression is
      // generated in acceptance mode instead (see FastGen.acceptance): its
      // `.default()` accepts `undefined` as the schema does, the predicate is
      // total, and the IIFE passes it as the is-arg. Runtime behaviour is
      // pinned end to end in tests/build-parse-and-is.test.ts.
      const schema = z.object({ page: z.number().default(1), name: z.string() });
      const iife = generateIIFE("Schema", makeInfoWithFallback("withDefault", schema));
      expect(iife).toMatch(/__zcMkv\(safeParse_withDefault,__zs,null,__fc_\d+\)/);
    });

    it("works for schemas with no fast path (mutating effect)", () => {
      const schema = z.object({ slug: z.string().transform((s) => s.toLowerCase()) });
      const validator = executeIIFE(makeInfo("withTransform", schema));
      expect(validator.is({ slug: "ABC" })).toBe(true);
      expect(validator.is({ slug: 123 })).toBe(false);
      expect(validator.is(null)).toBe(false);
    });

    it("is installed under zodCompat: false too", () => {
      const validator = executeIIFE(makeInfo("validateUser", simpleSchema), { zodCompat: false });
      expect(validator.is({ name: "Alice", age: 30 })).toBe(true);
      expect(validator.is({ name: "", age: -1 })).toBe(false);
    });
  });
});

describe("FAIL_CLASS_DECL — .error finalization", () => {
  it("copies each issue's own keys, in order, without input or continue", () => {
    const __zcFin = makeFinFn(zcMsg, ZodRealError);
    // An enumerable key on the issue's prototype stays out, as it does from the
    // spread zod finalizes its own issues with.
    const collected = Object.assign(Object.create({ inherited: true }) as object, {
      expected: "string",
      code: "invalid_type",
      input: 1,
      continue: false,
      path: ["a"],
    });
    const result = __zcFin([collected], undefined) as {
      error: { issues: Record<string, unknown>[] };
    };
    const [issue] = result.error.issues;
    expect(Object.keys(issue ?? {})).toEqual(["expected", "code", "path", "message"]);
    expect(issue).not.toHaveProperty("input");
    expect(issue).not.toHaveProperty("inherited");
    expect(result.error).toBe(result.error);
  });
});

describe("generateIIFE() — shared schema instance (CSE/dedup + identifier schemaExpr)", () => {
  // __rf entries and the __zcMkv schema arg are both spliced from schemaExpr.
  // In compile mode schemaExpr is the compile() argument (an identifier) and
  // in the CLI emitter it is (__src_X as any).schema — the SAME object __zcMkv
  // mutates. autoDiscover splices the expression text twice (two instances),
  // but any downstream CSE/dedup transform (babel-plugin-zod-hoist content-
  // hashed identical constructions in a field incident) collapses them back
  // into one. Binding Schema to the real instance reproduces all of these.
  function executeSharedIIFE(schema: z.ZodType, exportName: string) {
    const info = makeInfoWithFallback(exportName, schema);
    const iife = generateIIFE("Schema", info);
    const __zcFin = makeFinFn(zcMsg, ZodRealError);
    const fn = new Function(
      "Schema",
      "__zcMsg",
      "__zcZodError",
      "__zcMkv",
      "__zcFin",
      `${FAIL_CLASS_DECL}${FIN_DEFERRED_DECL}\nreturn ${iife};`,
    );
    return fn(schema, zcMsg, ZodRealError, __zcMkv, __zcFin) as {
      safeParse: (input: unknown) => {
        success: boolean;
        data?: unknown;
        error?: { issues: unknown[] };
      };
    };
  }

  it("root-fallback delegation must not recurse when __rf[0] === the __zcMkv target", () => {
    // superRefine → root fallback → safeParse_X delegates to __rf[0].safeParse.
    // __zcMkv installs safeParse_X as an own property on the same object: an
    // unpinned read recurses until RangeError on EVERY call.
    const schema = z.string().superRefine((val, ctx) => {
      if (val.length < 3) {
        ctx.addIssue({ code: "custom", message: "too short" });
      }
    });
    const validator = executeSharedIIFE(schema, "validateName");

    const ok = validator.safeParse("hello");
    expect(ok.success).toBe(true);
    expect(ok.data).toBe("hello");

    const fail = validator.safeParse("a");
    expect(fail.success).toBe(false);
    expect(fail.error?.issues).toHaveLength(1);
  });

  it("partial-fallback delegation is captured at evaluation, not re-read per parse", () => {
    const captured = "prefix_";
    const schema = z.object({
      name: z.string(),
      slug: z.string().transform((v) => captured + v),
    });
    const validator = executeSharedIIFE(schema, "validateUser");

    // Simulate a LATER validator's __zcMkv mutating the shared subtree object
    // (cross-file dedup can merge any two identical constructions): the
    // already-evaluated validator must keep using the delegate it captured.
    const slugSchema = (schema as unknown as { shape: { slug: { safeParse: unknown } } }).shape
      .slug;
    slugSchema.safeParse = () => {
      throw new Error("own-property override must not be read by the compiled validator");
    };

    const result = validator.safeParse({ name: "a", slug: "b" });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "a", slug: "prefix_b" });
  });
});

describe("__zcMkv — identity preservation (zod identity-keyed APIs)", () => {
  type MkvCompat = (
    fn: (input: unknown) => unknown,
    schema: object | null,
    fc: ((input: unknown) => boolean) | null,
  ) => object;
  const mkv = new Function(`${MK_VALIDATOR_DECL}; return __zcMkv;`)() as MkvCompat;

  it("returns the original schema object (zodCompat)", () => {
    const original = z.object({ a: z.string() });
    const wrapped = mkv((v) => original.safeParse(v), original, null);
    expect(wrapped).toBe(original);
  });

  it("toJSONSchema works when a compiled schema is composed into another schema", () => {
    // Regression: zod's toJSONSchema registers the object it is handed in
    // ctx.seen while processor closures capture the original inst — an
    // Object.create wrapper crashed optionalProcessor with
    // "Cannot set properties of undefined (setting 'ref')".
    const original = z.object({ a: z.string() }).optional();
    const wrapped = mkv((v) => original.safeParse(v), original, null) as z.ZodType;
    const js = z.toJSONSchema(z.object({ foo: wrapped }), { io: "input" });
    expect(js).toEqual(
      z.toJSONSchema(z.object({ foo: z.object({ a: z.string() }).optional() }), { io: "input" }),
    );
  });

  it(".meta() metadata survives wrapping (globalRegistry is identity-keyed)", () => {
    const original = z.string().meta({ title: "My String" });
    const wrapped = mkv((v) => original.safeParse(v), original, null) as z.ZodType;
    expect(z.globalRegistry.get(wrapped)).toEqual({ title: "My String" });
  });

  it("compiled methods shadow zod's on the same instance", () => {
    const original = z.object({ a: z.string() });
    let called = 0;
    const fn = (input: unknown) => {
      called++;
      return { success: true, data: input };
    };
    const wrapped = mkv(fn, original, null) as { safeParse: (v: unknown) => unknown };
    wrapped.safeParse({ a: "x" });
    expect(called).toBe(1);
    // derived schemas are fresh instances and fall back to plain zod
    const derived = original.extend({ b: z.number() });
    expect(derived.safeParse({ a: "x", b: 1 }).success).toBe(true);
    expect(called).toBe(1);
  });

  it("zodCompat: false still produces a plain method bag", () => {
    const bag = mkv((v) => ({ success: true, data: v }), null, null) as Record<string, unknown>;
    expect(typeof bag["safeParse"]).toBe("function");
    expect("_zod" in bag).toBe(false);
  });
});

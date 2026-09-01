/**
 * `output: "compact"` — compile only the fast path; delegate cold error
 * reporting to the retained Zod schema.
 *
 * Three layers of coverage:
 *  1. PARITY — the compact validator accepts/rejects, outputs, and reports the
 *     same first message as Zod (reuses the differential harness with the
 *     compact flag, so errors are validated to be byte-identical to Zod's).
 *  2. SHAPE — eligible schemas actually drop the slow walk and delegate
 *     (`__zcFinZ` + `__rfm_z`), while mutation schemas keep the compiled path.
 *  3. END-TO-END — the full IIFE (`__zs` binding + `__zcMkv` wiring) parses,
 *     guards (`.is`), and reports `.error` lazily, mutating nothing on the hot
 *     path.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { ZodRealError, z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import { extractSchema, type RefEntry } from "#src/core/extract/index.js";
import {
  FAILZ_CLASS_DECL,
  FAIL_CLASS_DECL,
  FINZ_DECL,
  FIN_DECL,
  FIN_DEFERRED_DECL,
  MK_VALIDATOR_DECL,
  ZOD_MSG_DECLARATION,
  generateIIFE,
} from "#src/core/iife.js";
import { compileSchemas } from "#src/core/pipeline.js";
import { expectParity } from "./parity-harness.js";

// ─── 1. Parity (errors are Zod's own, so they match by construction) ─────────

describe("compact mode — parity with Zod", () => {
  const compact = { compact: true };

  it("primitives", () => {
    expectParity(
      z.string().min(3).max(8),
      ["ok", "way too long string", "", 42, null],
      "s",
      undefined,
      compact,
    );
    expectParity(
      z.number().int().min(0).max(150),
      [10, -1, 200, 1.5, NaN, "x"],
      "n",
      undefined,
      compact,
    );
    expectParity(z.boolean(), [true, false, 0, "no"], "b", undefined, compact);
    expectParity(z.email(), ["a@b.co", "nope", 5], "e", undefined, compact);
  });

  it("objects, nesting, optional/nullable", () => {
    const uuid = "00000000-0000-4000-8000-000000000000";
    const schema = z.object({
      id: z.uuid(),
      name: z.string().min(1).max(100),
      age: z.number().int().min(0).optional(),
      bio: z.string().nullable(),
      address: z.object({ street: z.string(), zip: z.string().min(5) }),
    });
    expectParity(
      schema,
      [
        { id: uuid, name: "Jane", bio: null, address: { street: "x", zip: "12345" } },
        { id: "not-a-uuid", name: "", address: { street: 1, zip: "1" } },
        { id: uuid, name: "J", age: -2, bio: "hi", address: { street: "x", zip: "1" } },
        "not an object",
        null,
      ],
      "obj",
      undefined,
      compact,
    );
  });

  it("arrays, tuples, enums, literals", () => {
    expectParity(
      z.array(z.string()).max(3),
      [["a"], ["a", "b", "c", "d"], [1], "x"],
      "arr",
      undefined,
      compact,
    );
    expectParity(
      z.tuple([z.string(), z.number()]),
      [["a", 1], ["a"], [1, "a"]],
      "tup",
      undefined,
      compact,
    );
    expectParity(z.enum(["a", "b", "c"]), ["a", "z", 1], "en", undefined, compact);
    expectParity(z.literal("fixed"), ["fixed", "other"], "lit", undefined, compact);
  });

  it("unions, discriminated unions, records", () => {
    expectParity(z.union([z.string(), z.number()]), ["a", 1, true], "uni", undefined, compact);
    expectParity(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("a"), x: z.number() }),
        z.object({ type: z.literal("b"), y: z.string() }),
      ]),
      [{ type: "a", x: 1 }, { type: "b", y: "s" }, { type: "a", x: "no" }, { type: "c" }],
      "du",
      undefined,
      compact,
    );
    expectParity(
      z.record(z.string(), z.number()),
      [{ a: 1 }, { a: "x" }, "no"],
      "rec",
      undefined,
      compact,
    );
  });

  it("self-recursive schema (root recursion delegates to zod)", () => {
    type Tree = { v: number; children: Tree[] };
    const Tree: z.ZodType<Tree> = z.lazy(() =>
      z.object({ v: z.number(), children: z.array(Tree) }),
    );
    expectParity(
      Tree,
      [
        { v: 1, children: [] },
        { v: 1, children: [{ v: 2, children: [] }] },
        { v: 1, children: [{ v: "no", children: [] }] },
        { v: 1 },
      ],
      "tree",
      undefined,
      compact,
    );
  });

  it("mutation schemas (default/catch/transform/coerce) still match Zod", () => {
    expectParity(
      z.object({ n: z.number().default(5) }),
      [{}, { n: 1 }, { n: "x" }],
      "def",
      undefined,
      compact,
    );
    expectParity(z.number().catch(0), [1, "x"], "cat", undefined, compact);
    expectParity(z.coerce.number(), ["5", 5, "x"], "coe", undefined, compact);
    expectParity(
      z.string().transform((s) => s.length),
      ["abc", 5],
      "tr",
      undefined,
      compact,
    );
  });
});

// ─── 2. Shape: eligible schemas delegate; mutation schemas stay compiled ──────

function compactCodegen(schema: unknown, name = "x") {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const result = generateValidator(ir, name, { refCount: refEntries.length, compact: true });
  return { result, source: `${result.code}\n${result.functionDef}` };
}

describe("compact mode — codegen shape", () => {
  it("a total-fast-path schema drops the slow walk and delegates to zod", () => {
    const { result, source } = compactCodegen(
      z.object({ name: z.string().min(1), age: z.number().int() }),
    );
    expect(result.usesRetainedSchema).toBe(true);
    // A z.object() strips, so its payload comes from the build pass rather than
    // a by-reference `fc` — but the predicate is still exact and drives `.is()`.
    expect(result.fastFnName).toBeNull();
    expect(result.isFnName).not.toBeNull();
    expect(source).toMatch(/=__vb_\d+\(input\);/);
    expect(result.usedHelpers.has("__zcFinZ")).toBe(true);
    expect(source).toContain("__zcFinZ(");
    expect(source).toContain("__rfm_z=__zs.safeParse");
    expect(source).not.toContain(".bind(");
    // No compiled slow walk, no eager/deferred finalizers, no inline issues.
    expect(source).not.toContain("__sw_");
    expect(source).not.toContain("__zcFinD(");
    expect(source).not.toContain("_e.push");
  });

  it("a catch schema keeps the compiled path (no delegation)", () => {
    const schema = z.number().catch(0);
    const { result, source } = compactCodegen(schema);
    expect(result.usesRetainedSchema).toBeUndefined();
    expect(source).not.toContain("__zcFinZ(");
  });

  it.each([
    ["default", z.object({ n: z.number().default(1) }), true],
    ["coerce", z.coerce.number(), false],
    ["transform", z.string().transform((s) => s), false],
    ["overwrite", z.object({ q: z.string().trim() }), false],
  ])(
    "a %s schema keeps its build pass and delegates the cold path",
    (_label, schema, keepsOwnRefs) => {
      // These mutations are modelled by the build pass, so they get the same
      // bargain a stripping object does: the pass still runs (it produces the
      // payload), and only the compiled issue walk is handed to the retained zod
      // schema. Delegation reads `__zs` outright, so it claims no `__rf` slot;
      // `keepsOwnRefs` marks the one schema that still needs the array for a
      // reference of its own (the default's value).
      const { result, source } = compactCodegen(schema);
      expect(result.usesRetainedSchema).toBe(true);
      expect(source).toContain("__zcFinZ(__rfm_z,__zs,input)");
      expect(source.includes("__rf[")).toBe(keepsOwnRefs);
      expect(source).toMatch(/=__vb_\d+\(input\);/);
      expect(source).not.toContain("__sw_");
    },
  );

  it("hands `.is()` an acceptance predicate even when a default is substituted", () => {
    // A rebuilding schema's fast expression is generated in acceptance mode,
    // where a `.default()` accepts `undefined` as the schema does — so the
    // predicate is total and `.is()` stays zero-allocation. (The by-reference
    // form, which demands a present value, is never published for a schema
    // whose output is not its input.)
    const { result, source } = compactCodegen(z.object({ n: z.number().default(1) }));
    expect(result.isFnName).not.toBeNull();
    expect(result.fastFnName).toBeNull();
    expect(source).toMatch(/\(\(__w_\d+=input\["n"\]\)===undefined\|\|/);
    // Stripping alone reshapes the payload, never the verdict — predicate kept.
    expect(compactCodegen(z.object({ n: z.number() })).result.isFnName).not.toBeNull();
  });
});

// ─── 3. Size ─────────────────────────────────────────────────────────────────

describe("compact mode — output size", () => {
  it("is dramatically smaller than the default compiled output", () => {
    // Structurally DISTINCT schemas: slow-walk dedup can't collapse them, so the
    // per-schema slow walk (the bytes compact drops) is fully present in the
    // default output — the realistic large-app shape.
    const types = ["s", "n", "b", "arr", "obj"] as const;
    const schemas = Array.from({ length: 20 }, (_v, i) => {
      const shape: Record<string, z.ZodType> = {};
      for (let f = 0; f < 4 + (i % 4); f++) {
        const key = `field_${i}_${f}`;
        const t = types[(i + f) % types.length];
        shape[key] =
          t === "s"
            ? z
                .string()
                .min(i % 4)
                .max(40 + i)
            : t === "n"
              ? z
                  .number()
                  .int()
                  .min(0)
                  .max(900 + i)
              : t === "b"
                ? z.boolean()
                : t === "arr"
                  ? z.array(z.string()).max(3 + (i % 5))
                  : z.object({ [`x${i}`]: z.string(), [`y${f}`]: z.number().optional() });
      }
      return { exportName: `S${i}`, schema: z.object(shape) };
    });
    const sizeOf = (compact: boolean) => {
      const { schemas: results, shared } = compileSchemas(schemas, { mode: "lean", compact });
      const code = results
        .map((r) => `${r.codegenResult.code}\n${r.codegenResult.functionDef}`)
        .join("\n");
      return Buffer.byteLength(code + shared.code);
    };
    const def = sizeOf(false);
    const comp = sizeOf(true);
    // The slow walk is 64–77% of generated bytes — compact roughly halves the
    // output at minimum (well over -50% on diverse, dedup-resistant schemas).
    expect(comp).toBeLessThan(def * 0.5);
  });
});

// ─── 4. End-to-end: full IIFE, .is(), lazy .error, hot path unchanged ────────

interface CompiledLike {
  parse: (i: unknown) => unknown;
  safeParse: (i: unknown) => { success: boolean; data?: unknown; error?: ZodRealError };
  is: (i: unknown) => boolean;
}

function buildCompact(schema: unknown, name = "x"): CompiledLike {
  const { schemas: results } = compileSchemas([{ exportName: name, schema }], {
    mode: "inline",
    compact: true,
  });
  const info = results[0];
  if (info === undefined) throw new Error("expected a compiled schema");
  const iife = generateIIFE("__schema", info, { zodCompat: true });
  const factory = new Function(
    "__zodCompilerConfig",
    "__zcZodError",
    "__schema",
    `${ZOD_MSG_DECLARATION}\n` +
      `${FAIL_CLASS_DECL}${MK_VALIDATOR_DECL}${FIN_DECL}${FIN_DEFERRED_DECL}${FAILZ_CLASS_DECL}${FINZ_DECL}\n` +
      `return ${iife};`,
  );
  return factory(z.config, ZodRealError, schema) as CompiledLike;
}

describe("compact mode — runtime behavior", () => {
  it("parse / safeParse / .is behave like the compiled+zod combination", () => {
    const compiled = buildCompact(z.object({ name: z.string().min(2), age: z.number().int() }));
    const ok = { name: "Jane", age: 30 };
    // The object strips, so a valid parse returns the REBUILT payload, not the
    // caller's object — and unknown keys never ride through.
    expect(compiled.parse(ok)).toEqual(ok);
    expect(compiled.parse(ok)).not.toBe(ok);
    expect(compiled.parse({ ...ok, extra: 1 })).toEqual(ok);
    expect(compiled.safeParse(ok)).toEqual({ success: true, data: ok });
    expect(compiled.is(ok)).toBe(true);
    expect(compiled.is({ name: "x", age: 1.5 })).toBe(false);
    expect(() => compiled.parse({ name: "x", age: 1 })).toThrow(ZodRealError);
  });

  it("delegated .error is Zod's own error, produced lazily", () => {
    const schema = z.object({ name: z.string().min(2) });
    // The validator captures the PRISTINE safeParse method at IIFE evaluation
    // (before __zcMkv reinstalls a compiled safeParse on the schema), so this
    // spy on the original method is exactly what the cold delegate calls.
    const spy = vi.spyOn(schema, "safeParse");
    const compiled = buildCompact(schema, "lazy");
    spy.mockClear();

    const res = compiled.safeParse({ name: "x" });
    expect(res.success).toBe(false);
    // `success` is known from the fast check alone — zod is NOT consulted yet.
    expect(spy).not.toHaveBeenCalled();

    // Reading `.error` triggers the deferred zod parse exactly once.
    expect(res.error).toBeInstanceOf(ZodRealError);
    expect(spy).toHaveBeenCalledTimes(1);

    // The issues are zod's own (compare against a fresh, unmutated schema).
    const fresh = z.object({ name: z.string().min(2) });
    expect(res.error?.issues).toEqual(fresh.safeParse({ name: "x" }).error?.issues);
  });

  it("evaluates the retained schema once and preserves the pristine method receiver", () => {
    const schema = z.object({ name: z.string().min(2) });
    // oxlint-disable-next-line typescript/unbound-method -- the test verifies the explicit receiver
    const originalSafeParse = schema.safeParse;
    let schemaEvaluations = 0;
    let zodCalls = 0;
    schema.safeParse = function (input: unknown) {
      expect(this).toBe(schema);
      zodCalls++;
      return originalSafeParse.call(this, input);
    };

    const { schemas: results } = compileSchemas([{ exportName: "counted", schema }], {
      mode: "inline",
      compact: true,
    });
    const info = results[0];
    if (info === undefined) throw new Error("expected a compiled schema");
    const iife = generateIIFE("makeSchema()", info, { zodCompat: true });
    const factory = new Function(
      "__zodCompilerConfig",
      "__zcZodError",
      "makeSchema",
      `${ZOD_MSG_DECLARATION}\n` +
        `${FAIL_CLASS_DECL}${MK_VALIDATOR_DECL}${FIN_DECL}${FIN_DEFERRED_DECL}${FAILZ_CLASS_DECL}${FINZ_DECL}\n` +
        `return ${iife};`,
    );
    const compiled = factory(z.config, ZodRealError, () => {
      schemaEvaluations++;
      return schema;
    }) as CompiledLike;

    expect(schemaEvaluations).toBe(1);
    expect(zodCalls).toBe(0);
    expect(compiled.safeParse({ name: "valid" }).success).toBe(true);
    expect(zodCalls).toBe(0);

    const failed = compiled.safeParse({ name: "x" });
    expect(failed.success).toBe(false);
    expect(zodCalls).toBe(0);
    expect(failed.error).toBeInstanceOf(ZodRealError);
    expect(failed.error).toBe(failed.error);
    expect(zodCalls).toBe(1);
  });
});

// ─── 5. Interactions: mixed files and stripUnknownKeys ───────────────────────

describe("compact mode — interactions", () => {
  it("delegates eligible schemas and keeps each build pass in one file", () => {
    const { schemas: results } = compileSchemas(
      [
        { exportName: "Pure", schema: z.object({ name: z.string().min(1) }) },
        { exportName: "WithCoerce", schema: z.object({ n: z.coerce.number() }) },
      ],
      { mode: "lean", compact: true },
    );
    const [pure, withCoerce] = results;
    if (pure === undefined || withCoerce === undefined) throw new Error("expected two results");

    // Pure validator → delegates through `__zs`, slow walk dropped, and neither
    // schema has a reference of its own, so no `__rf` array is built at all.
    expect(pure.codegenResult.usesRetainedSchema).toBe(true);
    expect(pure.refEntries).toHaveLength(0);
    expect(pure.codegenResult.functionDef).toContain("__zcFinZ");

    // Coercion is modelled by the build pass: keep that hot path and delegate
    // only the cold issue walk.
    expect(withCoerce.codegenResult.usesRetainedSchema).toBe(true);
    expect(withCoerce.refEntries).toHaveLength(0);
    expect(withCoerce.codegenResult.functionDef).toContain("__zcFinZ");
    expect(withCoerce.codegenResult.functionDef).toMatch(/=__vb_\d+\(input\);/);
  });

  it("delegates a stripping object's cold path while keeping its build pass", () => {
    const { schemas: results } = compileSchemas(
      [{ exportName: "Obj", schema: z.object({ a: z.string() }) }],
      { mode: "lean", compact: true },
    );
    const [obj] = results;
    if (obj === undefined) throw new Error("expected a result");
    // The build pass has to stay — it produces the stripped payload, which zod
    // would only reproduce by parsing again. What compact drops is the compiled
    // issue walk, handing that to the retained zod schema.
    expect(obj.codegenResult.usesRetainedSchema).toBe(true);
    expect(obj.codegenResult.functionDef).toContain("__zcFinZ");
    expect(obj.codegenResult.functionDef).toMatch(/=__vb_\d+\(input\);/);
    expect(obj.codegenResult.functionDef).not.toContain("__sw_");
  });
});

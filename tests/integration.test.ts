import { describe, expect, it } from "vitest";
import { ZodRealError, z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { FIN_DECL, FIN_DEFERRED_DECL } from "#src/core/iife.js";
import type { SafeParseResult, SchemaIR } from "#src/core/types.js";
import { zodAtLeast } from "./zod-version.js";

const __zcFin = new Function("__zcZodError", `${FIN_DECL}; return __zcFin;`)(ZodRealError);

/**
 * End-to-end helper: Zod schema → extract IR → generate code → compile → safeParse.
 * Returns a safeParse function from the generated code.
 */
function compileZodSchema(schema: z.ZodType, name = "test") {
  const ir = extractSchema(schema);
  const result = generateValidator(ir, name);
  const fn = new Function(
    "__zcZodError",
    "__zcFin",
    `${FIN_DEFERRED_DECL}\n${result.code}\nreturn ${result.functionDef};`,
  );
  return fn(ZodRealError, __zcFin) as (input: unknown) => {
    success: boolean;
    data?: unknown;
    error?: { issues: unknown[] };
  };
}

/**
 * Property-based comparison: same input should produce the same success/failure
 * result in both Zod and the generated validator.
 */
function assertSameResult(schema: z.ZodType, input: unknown, name = "test") {
  const zodResult = schema.safeParse(input);
  const safeParse = compileZodSchema(schema, name);
  const aotResult = safeParse(input);

  expect(aotResult.success).toBe(zodResult.success);
  if (zodResult.success) {
    expect(aotResult.data).toEqual(zodResult.data);
  }
}

/**
 * Strip fields from Zod issues that AOT does not generate:
 * - `message`: AOT does not produce user-facing messages
 * - `input`: AOT does not include the original input value
 * - `origin`: AOT does not include the origin type (e.g. "string" for format checks)
 */
function stripMessage(issue: Record<string, unknown>): Record<string, unknown> {
  const { message: _, input: _input, origin: _origin, ...rest } = issue;
  return rest;
}

function stripInput(issue: Record<string, unknown>): Record<string, unknown> {
  const { input: _, ...rest } = issue;
  return rest;
}

/**
 * Assert that error issues from AOT match Zod structurally (same fields except `message`).
 */
function assertSameIssues(schema: z.ZodType, input: unknown, name = "test") {
  const zodResult = schema.safeParse(input);
  const safeParse = compileZodSchema(schema, name);
  const aotResult = safeParse(input);

  expect(aotResult.success).toBe(zodResult.success);
  if (!zodResult.success && !aotResult.success) {
    const zodIssues = zodResult.error.issues.map((i) =>
      stripMessage(i as unknown as Record<string, unknown>),
    );
    const aotIssues = aotResult.error?.issues.map((i) => stripInput(i as Record<string, unknown>));
    expect(aotIssues).toMatchObject(zodIssues);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Primitive Types
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — primitive schemas match Zod", () => {
  const primitiveTests: [string, z.ZodType, unknown[]][] = [
    ["string", z.string(), ["hello", "", "日本語", 42, null, undefined, true, {}, []]],
    ["number", z.number(), [0, 42, -1, 3.14, NaN, Infinity, "42", null, undefined, true]],
    ["boolean", z.boolean(), [true, false, 0, 1, "true", null, undefined]],
    ["null", z.null(), [null, undefined, 0, "", false]],
    ["undefined", z.undefined(), [undefined, null, 0, "", false]],
    ["void", z.void(), [undefined, null, 0, "", false]],
    ["nan", z.nan(), [NaN, 0, 42, Infinity, "NaN", null, undefined]],
    ["never", z.never(), [undefined, null, 0, "", true, {}, []]],
    ["symbol", z.symbol(), [Symbol("test"), Symbol.for("x"), "symbol", 42, null, undefined]],
  ];

  for (const [label, schema, inputs] of primitiveTests) {
    describe(label, () => {
      for (const input of inputs) {
        const inputStr = JSON.stringify(input) ?? String(input);
        it(`${inputStr} → same result as Zod`, () => {
          assertSameResult(schema, input, label);
        });
      }
    });
  }
});

describe("integration — any/unknown match Zod", () => {
  it("any accepts everything", () => {
    const schema = z.any();
    for (const input of ["hello", 42, null, undefined, {}, [], true]) {
      assertSameResult(schema, input, "anySchema");
    }
  });

  it("unknown accepts everything", () => {
    const schema = z.unknown();
    for (const input of ["hello", 42, null, undefined, {}, [], true]) {
      assertSameResult(schema, input, "unknownSchema");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Type Checks
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — string check schemas match Zod", () => {
  it("min(3) boundary values", () => {
    const schema = z.string().min(3);
    for (const input of ["", "ab", "abc", "abcd", 42, null]) {
      assertSameResult(schema, input, "strMin");
    }
  });

  it("max(5) boundary values", () => {
    const schema = z.string().max(5);
    for (const input of ["", "abcde", "abcdef", 42]) {
      assertSameResult(schema, input, "strMax");
    }
  });

  it("length(3) exact", () => {
    const schema = z.string().length(3);
    for (const input of ["abc", "ab", "abcd", ""]) {
      assertSameResult(schema, input, "strLen");
    }
  });

  it("regex pattern", () => {
    const schema = z.string().regex(/^[A-Z]{3}$/);
    for (const input of ["ABC", "abc", "AB", "ABCD", ""]) {
      assertSameResult(schema, input, "strRegex");
    }
  });

  it("email format", () => {
    const schema = z.email();
    for (const input of [
      "user@example.com",
      "a@b.co",
      "test.name+tag@domain.org",
      "not-an-email",
      "@missing-local.com",
      "missing-domain@",
      "",
      42,
    ]) {
      assertSameResult(schema, input, "strEmail");
    }
  });
});

describe("integration — number check schemas match Zod", () => {
  it("int() boundary values", () => {
    const schema = z.number().int();
    for (const input of [0, 1, -1, 42, 3.14, -0.5, NaN, Infinity, "1"]) {
      assertSameResult(schema, input, "numInt");
    }
  });

  it("positive() boundary values", () => {
    const schema = z.number().positive();
    for (const input of [1, 0.001, 0, -1, -0.001, NaN]) {
      assertSameResult(schema, input, "numPos");
    }
  });

  it("min(0).max(100) range", () => {
    const schema = z.number().min(0).max(100);
    for (const input of [-1, -0.001, 0, 50, 100, 100.001, 101, NaN]) {
      assertSameResult(schema, input, "numRange");
    }
  });

  it("multipleOf(3)", () => {
    const schema = z.number().multipleOf(3);
    for (const input of [0, 3, 6, 9, -3, 1, 2, 4, 3.5]) {
      assertSameResult(schema, input, "numMul");
    }
  });

  it("int().positive()", () => {
    const schema = z.number().int().positive();
    for (const input of [1, 42, 0, -1, 3.14, NaN]) {
      assertSameResult(schema, input, "numIntPos");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Modifiers
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — literal schemas match Zod", () => {
  it("string literal", () => {
    const schema = z.literal("hello");
    for (const input of ["hello", "world", "", 42, null, undefined]) {
      assertSameResult(schema, input, "strLit");
    }
  });

  it("number literal", () => {
    const schema = z.literal(42);
    for (const input of [42, 43, 0, "42", null]) {
      assertSameResult(schema, input, "numLit");
    }
  });

  it("boolean literal", () => {
    const schema = z.literal(true);
    for (const input of [true, false, 1, "true", null]) {
      assertSameResult(schema, input, "boolLit");
    }
  });
});

describe("integration — enum schemas match Zod", () => {
  it("string enum", () => {
    const schema = z.enum(["admin", "user", "guest"]);
    const inputs = ["admin", "user", "guest", "superadmin", "", 42, null, undefined];
    for (const input of inputs) {
      assertSameResult(schema, input, "strEnum");
    }
  });
});

describe("integration — optional/nullable match Zod", () => {
  it("optional string", () => {
    const schema = z.string().optional();
    for (const input of ["hello", "", undefined, null, 42]) {
      assertSameResult(schema, input, "optStr");
    }
  });

  it("nullable string", () => {
    const schema = z.string().nullable();
    for (const input of ["hello", "", null, undefined, 42]) {
      assertSameResult(schema, input, "nullStr");
    }
  });

  it("optional nullable string", () => {
    const schema = z.string().nullable().optional();
    for (const input of ["hello", "", null, undefined, 42]) {
      assertSameResult(schema, input, "optNullStr");
    }
  });
});

describe("integration — readonly match Zod", () => {
  // readonly falls back to Zod (Zod freezes its output; compiled validators
  // must not freeze the caller's input) — needs the refs-aware harness.
  it("readonly string", () => {
    const schema = z.string().readonly();
    const safeParse = compileWithRefs(schema, "roStr");
    for (const input of ["hello", "", 42, null, undefined]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (zodResult.success && aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("readonly object parses and freezes output like Zod", () => {
    const schema = z.object({ name: z.string() }).readonly();
    const safeParse = compileWithRefs(schema, "roObj");
    for (const input of [{ name: "Alice" }, {}, null, "not object"]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (zodResult.success && aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
        expect(Object.isFrozen(aotResult.data)).toBe(Object.isFrozen(zodResult.data));
      }
    }
  });

  it("readonly does not freeze the caller's input object", () => {
    const schema = z.object({ name: z.string() }).readonly();
    const safeParse = compileWithRefs(schema, "roNoFreeze");
    const input = { name: "Alice" };
    safeParse(input);
    expect(Object.isFrozen(input)).toBe(false);
  });
});

describe("integration — default match Zod", () => {
  it("standalone default", () => {
    const schema = z.string().default("fallback");
    const safeParse = compileWithRefs(schema, "defaultStr");
    for (const input of [undefined, "hello", ""]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (zodResult.success && aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("default in object property", () => {
    const schema = z.object({
      name: z.string(),
      role: z.string().default("user"),
    });
    const safeParse = compileWithRefs(schema, "defaultObj");
    for (const input of [
      { name: "Alice", role: "admin" },
      { name: "Bob" },
      { name: "Carol", role: undefined },
    ]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (zodResult.success && aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("factory default (string)", () => {
    const schema = z.string().default(() => "generated");
    const safeParse = compileWithRefs(schema, "defaultFactory");
    for (const input of [undefined, "hello"]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (zodResult.success && aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("factory default (Date)", () => {
    const schema = z.date().default(() => new Date("2024-01-01T00:00:00.000Z"));
    const safeParse = compileWithRefs(schema, "defaultDateFactory");
    const zodResult = schema.safeParse(undefined);
    const aotResult = safeParse(undefined);
    expect(aotResult.success).toBe(zodResult.success);
    if (zodResult.success && aotResult.success) {
      expect(aotResult.data).toEqual(zodResult.data);
    }
    // Non-undefined Date input
    const dateInput = new Date("2025-06-01");
    const zodResult2 = schema.safeParse(dateInput);
    const aotResult2 = safeParse(dateInput);
    expect(aotResult2.success).toBe(zodResult2.success);
  });

  it("number default", () => {
    const schema = z.number().default(42);
    const safeParse = compileWithRefs(schema, "defaultNum");
    for (const input of [undefined, 0, 99, -1]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (zodResult.success && aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("boolean default", () => {
    const schema = z.boolean().default(false);
    const safeParse = compileWithRefs(schema, "defaultBool");
    for (const input of [undefined, true, false]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (zodResult.success && aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("object default", () => {
    const schema = z
      .object({ name: z.string(), age: z.number() })
      .default({ name: "anon", age: 0 });
    const safeParse = compileWithRefs(schema, "defaultObjVal");
    for (const input of [undefined, { name: "Alice", age: 30 }]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (zodResult.success && aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("nested default in object", () => {
    const schema = z.object({
      config: z.object({
        host: z.string().default("localhost"),
        port: z.number().default(3000),
      }),
    });
    const safeParse = compileWithRefs(schema, "defaultNested");
    for (const input of [
      { config: {} },
      { config: { host: "example.com" } },
      { config: { port: 8080 } },
      { config: { host: "example.com", port: 8080 } },
    ]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (zodResult.success && aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("default + refine", () => {
    const schema = z
      .string()
      .default("hello")
      .refine((v) => v.length >= 3);
    const safeParse = compileWithRefs(schema, "defaultRefine");
    for (const input of [undefined, "abc", "abcdef"]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (zodResult.success && aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("default with invalid type produces same error as Zod", () => {
    const schema = z.string().default("fallback");
    const safeParse = compileWithRefs(schema, "defaultInvalid");
    for (const input of [42, true, null, { key: "val" }, [1, 2]]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      expect(aotResult.success).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Composite Types
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — object schemas match Zod", () => {
  it("simple object", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const inputs = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
      { name: "", age: 0 },
      { name: "Alice" },
      { age: 30 },
      {},
      { name: 42, age: "thirty" },
      null,
      "not an object",
      42,
    ];
    for (const input of inputs) {
      assertSameResult(schema, input, "simpleObj");
    }
  });

  it("object with optional properties", () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const inputs = [
      { required: "yes" },
      { required: "yes", optional: "also yes" },
      { required: "yes", optional: undefined },
      {},
      { optional: "only optional" },
    ];
    for (const input of inputs) {
      assertSameResult(schema, input, "optObj");
    }
  });

  it("object with nullable properties", () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().nullable(),
    });
    const inputs = [
      { name: "Alice", nickname: "Ali" },
      { name: "Alice", nickname: null },
      { name: "Alice" },
      { name: "Alice", nickname: 42 },
    ];
    for (const input of inputs) {
      assertSameResult(schema, input, "nullObj");
    }
  });

  it("nested objects", () => {
    const schema = z.object({
      user: z.object({
        profile: z.object({
          name: z.string().min(1),
          age: z.number().int(),
        }),
      }),
    });
    const inputs = [
      { user: { profile: { name: "Alice", age: 30 } } },
      { user: { profile: { name: "", age: 30 } } },
      { user: { profile: { name: "Alice", age: 30.5 } } },
      { user: { profile: {} } },
      { user: {} },
      {},
    ];
    for (const input of inputs) {
      assertSameResult(schema, input, "nestedObj");
    }
  });
});

describe("integration — array schemas match Zod", () => {
  it("basic array", () => {
    const schema = z.array(z.string());
    const inputs = [[], ["a"], ["a", "b", "c"], [1, 2, 3], ["a", 1, "b"], "not array", null, {}];
    for (const input of inputs) {
      assertSameResult(schema, input, "basicArr");
    }
  });

  it("array with min/max", () => {
    const schema = z.array(z.number()).min(1).max(3);
    const inputs = [[], [1], [1, 2], [1, 2, 3], [1, 2, 3, 4], ["a"]];
    for (const input of inputs) {
      assertSameResult(schema, input, "arrMinMax");
    }
  });

  it("array of objects", () => {
    const schema = z.array(z.object({ id: z.number(), name: z.string() }));
    const inputs = [
      [],
      [{ id: 1, name: "a" }],
      [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
      [{ id: "not number", name: "a" }],
      [{ id: 1 }],
    ];
    for (const input of inputs) {
      assertSameResult(schema, input, "arrObj");
    }
  });
});

describe("integration — tuple match Zod", () => {
  it("basic tuple", () => {
    const schema = z.tuple([z.string(), z.number()]);
    for (const input of [["hello", 42], ["a", 1], [42, "hello"], ["a"], "not array", null]) {
      assertSameResult(schema, input, "tupleBasic");
    }
  });

  it("tuple with rest", () => {
    const schema = z.tuple([z.string()]).rest(z.number());
    for (const input of [["a"], ["a", 1], ["a", 1, 2, 3], ["a", "b"]]) {
      assertSameResult(schema, input, "tupleRest");
    }
  });
});

describe("integration — record match Zod", () => {
  it("string key record", () => {
    const schema = z.record(z.string(), z.number());
    for (const input of [{}, { a: 1 }, { a: 1, b: 2 }, { a: "not number" }, null, "not object"]) {
      assertSameResult(schema, input, "recordStr");
    }
  });

  it("key constraint record produces invalid_key like Zod", () => {
    const schema = z.record(z.string().min(3), z.number());
    const safeParse = compileZodSchema(schema, "recordKeyMin");

    // Invalid key
    const aotResult = safeParse({ ab: 1 });
    const zodResult = schema.safeParse({ ab: 1 });
    expect(aotResult.success).toBe(zodResult.success);
    expect(aotResult.error?.issues.length).toBe(zodResult.error?.issues.length);
    expect((aotResult.error?.issues[0] as Record<string, unknown>)?.["code"]).toBe("invalid_key");

    // Invalid key + invalid value: Zod short-circuits (only key error)
    const aotResult2 = safeParse({ ab: "not-number" });
    const zodResult2 = schema.safeParse({ ab: "not-number" });
    expect(aotResult2.success).toBe(zodResult2.success);
    expect(aotResult2.error?.issues.length).toBe(zodResult2.error?.issues.length);
  });
});

describe("integration — set match Zod", () => {
  it("plain set of strings", () => {
    const schema = z.set(z.string());
    for (const input of [
      new Set(["a", "b"]),
      new Set(),
      new Set([1, 2]),
      ["a", "b"],
      null,
      "not a set",
    ]) {
      assertSameResult(schema, input, "setStr");
    }
  });

  it("set with min/max size", () => {
    const schema = z.set(z.number()).min(1).max(3);
    for (const input of [
      new Set([1]),
      new Set([1, 2, 3]),
      new Set<number>(),
      new Set([1, 2, 3, 4]),
    ]) {
      assertSameResult(schema, input, "setMinMax");
    }
  });

  it("set of objects", () => {
    const schema = z.set(z.object({ id: z.number() }));
    for (const input of [new Set([{ id: 1 }]), new Set([{ id: "bad" }])]) {
      assertSameResult(schema, input, "setObj");
    }
  });
});

describe("integration — map match Zod", () => {
  it("plain map string→number", () => {
    const schema = z.map(z.string(), z.number());
    for (const input of [
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
      new Map(),
      new Map([["a", "bad"]]) as unknown,
      { a: 1 },
      null,
      "not a map",
    ]) {
      assertSameResult(schema, input, "mapStrNum");
    }
  });

  it("map with number keys", () => {
    const schema = z.map(z.number(), z.string());
    for (const input of [
      new Map([
        [1, "a"],
        [2, "b"],
      ]),
      new Map([["bad", "a"]]) as unknown,
    ]) {
      assertSameResult(schema, input, "mapNumStr");
    }
  });

  it("map with object values", () => {
    const schema = z.map(z.string(), z.object({ id: z.number() }));
    for (const input of [new Map([["x", { id: 1 }]]), new Map([["x", { id: "bad" }]]) as unknown]) {
      assertSameResult(schema, input, "mapObj");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Combinators
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — union schemas match Zod", () => {
  it("string | number union", () => {
    const schema = z.union([z.string(), z.number()]);
    for (const input of ["hello", 42, true, null, undefined, {}, []]) {
      assertSameResult(schema, input, "strNumUnion");
    }
  });

  it("union with checks", () => {
    const schema = z.union([z.string().min(3), z.number().positive()]);
    for (const input of ["abc", "ab", 1, 0, -1, true, null]) {
      assertSameResult(schema, input, "checkedUnion");
    }
  });
});

describe("integration — discriminatedUnion match Zod", () => {
  it("basic discriminated union", () => {
    const schema = z.discriminatedUnion("type", [
      z.object({ type: z.literal("a"), value: z.string() }),
      z.object({ type: z.literal("b"), count: z.number() }),
    ]);
    for (const input of [
      { type: "a", value: "hello" },
      { type: "b", count: 42 },
      { type: "a", value: 42 },
      { type: "c" },
      { value: "no type" },
      null,
      "not object",
    ]) {
      assertSameResult(schema, input, "discUnion");
    }
  });

  it("discriminated union with 3 options", () => {
    const schema = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("circle"), radius: z.number() }),
      z.object({ kind: z.literal("square"), size: z.number() }),
      z.object({ kind: z.literal("rect"), w: z.number(), h: z.number() }),
    ]);
    for (const input of [
      { kind: "circle", radius: 5 },
      { kind: "square", size: 10 },
      { kind: "rect", w: 3, h: 4 },
      { kind: "triangle" },
      { kind: "circle", radius: "not number" },
    ]) {
      assertSameResult(schema, input, "discUnion3");
    }
  });
});

describe("integration — intersection match Zod", () => {
  it("object intersection", () => {
    const schema = z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }));
    for (const input of [{ a: "hello", b: 42 }, { a: "hello" }, { b: 42 }, {}, null]) {
      assertSameResult(schema, input, "intersect");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Other Types
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — date match Zod", () => {
  it("plain date", () => {
    const schema = z.date();
    for (const input of [new Date(), new Date("2024-01-01"), "2024-01-01", 123, null]) {
      assertSameResult(schema, input, "dateSchema");
    }
  });

  it("date with min/max", () => {
    const schema = z.date().min(new Date("2020-01-01")).max(new Date("2030-01-01"));
    for (const input of [
      new Date("2025-01-01"),
      new Date("2020-01-01"),
      new Date("2030-01-01"),
      new Date("2019-12-31"),
      new Date("2030-01-02"),
    ]) {
      assertSameResult(schema, input, "dateMinMax");
    }
  });

  it("rejects invalid date", () => {
    const schema = z.date();
    assertSameResult(schema, new Date("invalid"), "dateInvalid");
  });
});

describe("integration — bigint match Zod", () => {
  it("plain bigint", () => {
    const schema = z.bigint();
    for (const input of [0n, 42n, -1n, 42, "42", null, undefined, true]) {
      assertSameResult(schema, input, "bigintSchema");
    }
  });

  it("bigint with min/max", () => {
    const schema = z.bigint().min(10n).max(100n);
    for (const input of [10n, 50n, 100n, 9n, 101n, 0n]) {
      assertSameResult(schema, input, "bigintMinMax");
    }
  });

  it("bigint positive", () => {
    const schema = z.bigint().positive();
    for (const input of [1n, 100n, 0n, -1n]) {
      assertSameResult(schema, input, "bigintPos");
    }
  });

  it("bigint negative", () => {
    const schema = z.bigint().negative();
    for (const input of [-1n, -100n, 0n, 1n]) {
      assertSameResult(schema, input, "bigintNeg");
    }
  });

  it("bigint nonnegative", () => {
    const schema = z.bigint().nonnegative();
    for (const input of [0n, 1n, -1n]) {
      assertSameResult(schema, input, "bigintNonneg");
    }
  });

  it("bigint multipleOf", () => {
    const schema = z.bigint().multipleOf(3n);
    for (const input of [0n, 3n, 6n, 9n, 1n, 2n, 7n]) {
      assertSameResult(schema, input, "bigintMul");
    }
  });
});

describe("integration — pipe (non-transform) match Zod", () => {
  it("string pipe to string with min length", () => {
    const schema = z.string().pipe(z.string().min(3));
    for (const input of ["hello", "ab", "", 42, null]) {
      assertSameResult(schema, input, "pipeStrMin");
    }
  });

  it("number pipe to number with range", () => {
    const schema = z.number().pipe(z.number().min(0).max(100));
    for (const input of [50, 0, 100, -1, 101, "not number"]) {
      assertSameResult(schema, input, "pipeNumRange");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Error Issue Comparison
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — bigint error issues match Zod", () => {
  it("too_small issue for min()", () => {
    assertSameIssues(z.bigint().min(10n), 5n, "bigintMin");
  });

  it("too_big issue for max()", () => {
    assertSameIssues(z.bigint().max(100n), 200n, "bigintMax");
  });

  it("too_small issue for positive()", () => {
    assertSameIssues(z.bigint().positive(), 0n, "bigintPos");
  });

  it("too_big issue for negative()", () => {
    assertSameIssues(z.bigint().negative(), 0n, "bigintNeg");
  });

  it("not_multiple_of issue for multipleOf()", () => {
    assertSameIssues(z.bigint().multipleOf(3n), 7n, "bigintMul");
  });

  it("invalid_type issue for non-bigint input", () => {
    assertSameIssues(z.bigint(), 42, "bigintType");
  });

  it("multiple issues for combined checks", () => {
    assertSameIssues(z.bigint().min(10n).max(100n), 5n, "bigintRange");
  });
});

describe("integration — set error issues match Zod", () => {
  it("too_small issue for min()", () => {
    assertSameIssues(z.set(z.number()).min(2), new Set([1]), "setMin");
  });

  it("too_big issue for max()", () => {
    assertSameIssues(z.set(z.number()).max(2), new Set([1, 2, 3]), "setMax");
  });

  it("invalid_type issue for non-Set input", () => {
    assertSameIssues(z.set(z.string()), ["a", "b"], "setType");
  });

  it("element validation issues have same code as Zod", () => {
    const schema = z.set(z.number());
    const input = new Set([1, "bad", 3]);
    const zodResult = schema.safeParse(input);
    const safeParse = compileZodSchema(schema, "setElem");
    const aotResult = safeParse(input);
    expect(aotResult.success).toBe(false);
    expect(zodResult.success).toBe(false);
    if (!aotResult.success && !zodResult.success) {
      // Both report invalid_type for element; AOT includes element index in path
      expect(aotResult.error?.issues[0]).toMatchObject({
        code: zodResult.error.issues[0]?.code,
        expected: (zodResult.error.issues[0] as unknown as Record<string, unknown>)?.["expected"],
      });
    }
  });
});

describe("integration — pipe error issues match Zod", () => {
  it("too_small issue from output schema check", () => {
    assertSameIssues(z.string().pipe(z.string().min(3)), "ab", "pipeMin");
  });

  it("invalid_type issue from input schema has same code as Zod", () => {
    const schema = z.string().pipe(z.string().min(3));
    const zodResult = schema.safeParse(42);
    const safeParse = compileZodSchema(schema, "pipeType");
    const aotResult = safeParse(42);
    expect(aotResult.success).toBe(false);
    expect(zodResult.success).toBe(false);
    if (!aotResult.success && !zodResult.success) {
      // Zod short-circuits on input failure (1 issue); AOT validates both in+out (2 issues)
      // First issue should match
      expect(stripInput(aotResult.error?.issues[0] as Record<string, unknown>)).toEqual(
        stripMessage(zodResult.error.issues[0] as unknown as Record<string, unknown>),
      );
    }
  });

  it("too_big issue from output number range", () => {
    assertSameIssues(z.number().pipe(z.number().max(100)), 200, "pipeMax");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Real-World & Infrastructure
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — real-world schemas match Zod", () => {
  it("user registration form", () => {
    const schema = z.object({
      username: z.string().min(3).max(20),
      email: z.email(),
      password: z.string().min(8),
      age: z.number().int().positive(),
      role: z.enum(["user", "admin"]),
      newsletter: z.boolean(),
      referral: z.string().optional(),
    });

    const validInputs = [
      {
        username: "alice",
        email: "alice@test.com",
        password: "securepassword",
        age: 25,
        role: "user",
        newsletter: true,
      },
      {
        username: "bob_admin",
        email: "bob@company.org",
        password: "12345678",
        age: 30,
        role: "admin",
        newsletter: false,
        referral: "alice",
      },
    ];

    const invalidInputs = [
      // Missing fields
      { username: "alice" },
      // Bad types
      {
        username: 42,
        email: "alice@test.com",
        password: "securepassword",
        age: 25,
        role: "user",
        newsletter: true,
      },
      // Failed checks
      {
        username: "ab",
        email: "not-email",
        password: "short",
        age: -1,
        role: "superadmin",
        newsletter: "yes",
      },
      // null
      null,
      // not an object
      "string input",
    ];

    for (const input of [...validInputs, ...invalidInputs]) {
      assertSameResult(schema, input, "userReg");
    }
  });

  it("API response schema", () => {
    const schema = z.object({
      status: z.enum(["success", "error"]),
      data: z
        .object({
          items: z.array(
            z.object({
              id: z.number().int().positive(),
              title: z.string().min(1).max(200),
              tags: z.array(z.string()),
              published: z.boolean(),
            }),
          ),
          total: z.number().int().nonnegative(),
          page: z.number().int().positive(),
        })
        .optional(),
      error: z
        .object({
          code: z.string(),
          message: z.string(),
        })
        .optional(),
    });

    const inputs = [
      // Valid success response
      {
        status: "success",
        data: {
          items: [{ id: 1, title: "Hello", tags: ["a"], published: true }],
          total: 1,
          page: 1,
        },
      },
      // Valid error response
      {
        status: "error",
        error: { code: "NOT_FOUND", message: "Resource not found" },
      },
      // Valid with empty items
      {
        status: "success",
        data: { items: [], total: 0, page: 1 },
      },
      // Invalid: bad status
      { status: "pending" },
      // Invalid: bad item
      {
        status: "success",
        data: {
          items: [{ id: "not-number", title: "", tags: 42, published: "yes" }],
          total: -1,
          page: 0,
        },
      },
    ];

    for (const input of inputs) {
      assertSameResult(schema, input, "apiResp");
    }
  });
});

describe("integration — SchemaIR is JSON-serializable", () => {
  it("extracted IR survives JSON roundtrip", () => {
    const schema = z.object({
      name: z.string().min(1).max(100),
      age: z.number().int().positive(),
      role: z.enum(["admin", "user"]),
      tags: z.array(z.string()),
      active: z.boolean(),
      extra: z.string().optional(),
    });

    const ir = extractSchema(schema);
    const serialized = JSON.stringify(ir);
    const deserialized = JSON.parse(serialized) as SchemaIR;
    expect(deserialized).toEqual(ir);

    // The deserialized IR should produce the same validator
    const result1 = generateValidator(ir, "original");
    const result2 = generateValidator(deserialized, "roundtrip");
    expect(result1.code).toBe(result2.code);
  });
});

describe("integration — effect compilation and fallback for non-compilable schemas", () => {
  it("zero-capture transform schema produces EffectIR", () => {
    const schema = z.string().transform((v) => parseInt(v, 10));
    const ir = extractSchema(schema);
    expect(ir.type).toBe("effect");
  });

  it("zero-capture refine schema produces StringIR with refine_effect check", () => {
    const schema = z.string().refine((v) => v.length > 0);
    const ir = extractSchema(schema);
    expect(ir.type).toBe("string");
  });

  it("captured-variable transform still produces fallback IR", () => {
    const prefix = "hello";
    const schema = z.string().transform((v) => prefix + v);
    const ir = extractSchema(schema);
    expect(ir.type).toBe("fallback");
  });

  it("lazy wrapping non-recursive schema is fully compiled", () => {
    const schema = z.lazy(() => z.string());
    const ir = extractSchema(schema);
    expect(ir.type).toBe("string");
  });

  it("recursive lazy falls back only at the recursion point", () => {
    const TreeNode: z.ZodType = z.object({
      value: z.string(),
      children: z.array(z.lazy(() => TreeNode)),
    });
    const ir = extractSchema(TreeNode);
    expect(ir.type).toBe("object");
  });
});

function compileWithRefs(schema: z.ZodType, name = "test") {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const result = generateValidator(ir, name, { refCount: refEntries.length });
  const refSchemas = refEntries.map((e) => e.schema);
  return refSchemas.length > 0
    ? (new Function(
        "__zcZodError",
        "__zcFin",
        "__rf",
        `${FIN_DEFERRED_DECL}\n${result.code}\nreturn ${result.functionDef};`,
      )(ZodRealError, __zcFin, refSchemas) as (input: unknown) => SafeParseResult<unknown>)
    : (new Function(
        "__zcZodError",
        "__zcFin",
        `${FIN_DEFERRED_DECL}\n${result.code}\nreturn ${result.functionDef};`,
      )(ZodRealError, __zcFin) as (input: unknown) => SafeParseResult<unknown>);
}

describe("integration — partial fallback (mixed compilable + non-compilable)", () => {
  it("object with transform property matches Zod success/failure", () => {
    const schema = z.object({
      name: z.string().min(3),
      slug: z.string().transform((v) => v.toLowerCase()),
      age: z.number().int().positive(),
    });

    const safeParse = compileWithRefs(schema, "partial");
    const inputs = [
      { name: "Alice", slug: "Hello-World", age: 25 },
      { name: "Al", slug: "hello", age: 25 },
      { name: "Alice", slug: 42, age: 25 },
      { name: "Alice", slug: "hello", age: -1 },
      null,
      "not an object",
    ];

    for (const input of inputs) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("transform data is written back on success", () => {
    const schema = z.object({
      name: z.string(),
      slug: z.string().transform((v) => v.toLowerCase()),
    });

    const safeParse = compileWithRefs(schema, "transform");
    const result = safeParse({ name: "Alice", slug: "HELLO" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "Alice", slug: "hello" });
    }
  });

  it("object with refine property matches Zod behavior", () => {
    const schema = z.object({
      email: z.email(),
      password: z
        .string()
        .min(8)
        .refine((v) => /[A-Z]/.test(v), {
          message: "Must contain uppercase",
        }),
    });

    const safeParse = compileWithRefs(schema, "refine");
    const inputs = [
      { email: "a@b.com", password: "SecurePass1" },
      { email: "a@b.com", password: "nouppercase" },
      { email: "invalid", password: "SecurePass1" },
    ];

    for (const input of inputs) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("array of objects with partial fallback", () => {
    const itemSchema = z.object({
      id: z.number(),
      label: z.string().transform((v) => v.trim()),
    });
    const schema = z.array(itemSchema);

    const safeParse = compileWithRefs(schema, "arrPartial");
    const inputs = [
      [{ id: 1, label: " hello " }],
      [{ id: "not a number", label: "ok" }],
      [{ id: 1, label: 42 }],
      "not an array",
      [],
    ];

    for (const input of inputs) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("nullable with transform inner matches Zod", () => {
    const schema = z.object({
      name: z.string(),
      label: z.nullable(z.string().transform((v) => v.trim())),
    });

    const safeParse = compileWithRefs(schema, "nullableTransform");
    const inputs = [
      { name: "Alice", label: " hello " },
      { name: "Alice", label: null },
      { name: "Alice", label: 42 },
      null,
    ];

    for (const input of inputs) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("tuple with transform item matches Zod", () => {
    const schema = z.tuple([z.string(), z.number().transform((v) => String(v))]);

    const safeParse = compileWithRefs(schema, "tupleTransform");
    const inputs = [["hello", 42], ["hello", "not a number"], [42, 42], "not array"];

    for (const input of inputs) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("record with transform value matches Zod", () => {
    const schema = z.record(
      z.string(),
      z.string().transform((v) => v.trim()),
    );

    const safeParse = compileWithRefs(schema, "recordTransform");
    const inputs = [{ a: " hello " }, { a: "hello", b: "world" }, { a: 42 }, {}, null];

    for (const input of inputs) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("intersection with transform side matches Zod", () => {
    const schema = z.intersection(
      z.object({ a: z.string() }),
      z.object({ b: z.string().transform((v) => v.toLowerCase()) }),
    );

    const safeParse = compileWithRefs(schema, "intersectTransform");
    const inputs = [{ a: "hello", b: "WORLD" }, { a: "hello" }, { b: "world" }, null];

    for (const input of inputs) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("deep nested partial fallback matches Zod", () => {
    const schema = z.object({
      items: z.array(
        z.object({
          name: z.string().min(1),
          score: z.number().transform((v) => Math.round(v)),
        }),
      ),
    });

    const safeParse = compileWithRefs(schema, "deepNested");
    const inputs = [
      { items: [{ name: "Alice", score: 95.7 }] },
      { items: [{ name: "", score: 80 }] },
      { items: [{ name: "Bob", score: "not a number" }] },
      { items: [] },
      null,
    ];

    for (const input of inputs) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("nullable transform writes back data on success", () => {
    const schema = z.object({
      label: z.nullable(z.string().transform((v) => v.trim())),
    });

    const safeParse = compileWithRefs(schema, "nullableWriteback");
    const result = safeParse({ label: "  hello  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ label: "hello" });
    }
  });

  it("recursive lazy tree node matches Zod success/failure", () => {
    const TreeNode: z.ZodType = z.object({
      value: z.string(),
      children: z.array(z.lazy(() => TreeNode)),
    });

    const safeParse = compileWithRefs(TreeNode, "tree");
    const inputs = [
      { value: "root", children: [] },
      { value: "root", children: [{ value: "child", children: [] }] },
      {
        value: "root",
        children: [{ value: "child", children: [{ value: "grandchild", children: [] }] }],
      },
      { value: 42, children: [] },
      { value: "root", children: "not array" },
      null,
    ];

    for (const input of inputs) {
      const zodResult = TreeNode.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("recursive tree with string checks matches Zod", () => {
    const TreeNode: z.ZodType = z.object({
      value: z.string().min(1),
      children: z.array(z.lazy(() => TreeNode)),
    });

    const safeParse = compileWithRefs(TreeNode, "treeChecks");
    const inputs = [
      { value: "root", children: [] },
      { value: "root", children: [{ value: "a", children: [] }] },
      // Invalid: empty string violates min(1)
      { value: "", children: [] },
      // Invalid: nested child violates min(1)
      { value: "root", children: [{ value: "", children: [] }] },
    ];

    for (const input of inputs) {
      const zodResult = TreeNode.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("linked list (nullable self-reference) matches Zod", () => {
    const ListNode: z.ZodType = z.object({
      value: z.number(),
      next: z.lazy(() => ListNode).nullable(),
    });

    const safeParse = compileWithRefs(ListNode, "list");
    const inputs = [
      { value: 1, next: null },
      { value: 1, next: { value: 2, next: null } },
      { value: 1, next: { value: 2, next: { value: 3, next: null } } },
      // Invalid: bad value
      { value: "bad", next: null },
      // Invalid: nested bad value
      { value: 1, next: { value: "bad", next: null } },
      // Invalid: next is not null or object
      { value: 1, next: "not object" },
      null,
    ];

    for (const input of inputs) {
      const zodResult = ListNode.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("binary tree (multiple nullable self-references) matches Zod", () => {
    const BinaryTree: z.ZodType = z.object({
      value: z.number(),
      left: z.lazy(() => BinaryTree).nullable(),
      right: z.lazy(() => BinaryTree).nullable(),
    });

    const safeParse = compileWithRefs(BinaryTree, "btree");
    const inputs = [
      { value: 1, left: null, right: null },
      {
        value: 1,
        left: { value: 2, left: null, right: null },
        right: { value: 3, left: null, right: null },
      },
      {
        value: 1,
        left: {
          value: 2,
          left: { value: 4, left: null, right: null },
          right: null,
        },
        right: null,
      },
      // Invalid: bad value in left subtree
      { value: 1, left: { value: "bad", left: null, right: null }, right: null },
      // Invalid: missing right
      { value: 1, left: null },
    ];

    for (const input of inputs) {
      const zodResult = BinaryTree.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("optional recursive self-reference matches Zod", () => {
    const Category: z.ZodType = z.object({
      name: z.string(),
      parent: z.lazy(() => Category).optional(),
    });

    const safeParse = compileWithRefs(Category, "category");
    const inputs = [
      { name: "root" },
      { name: "child", parent: { name: "root" } },
      { name: "grandchild", parent: { name: "child", parent: { name: "root" } } },
      // Invalid: bad name
      { name: 42 },
      // Invalid: bad nested name
      { name: "child", parent: { name: 123 } },
      null,
    ];

    for (const input of inputs) {
      const zodResult = Category.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("recursive record (directory tree) matches Zod", () => {
    const DirNode: z.ZodType = z.object({
      name: z.string(),
      children: z.record(
        z.string(),
        z.lazy(() => DirNode),
      ),
    });

    const safeParse = compileWithRefs(DirNode, "dir");
    const inputs = [
      { name: "root", children: {} },
      {
        name: "root",
        children: {
          src: { name: "src", children: {} },
          lib: { name: "lib", children: {} },
        },
      },
      {
        name: "root",
        children: {
          src: {
            name: "src",
            children: {
              core: { name: "core", children: {} },
            },
          },
        },
      },
      // Invalid: child has bad name
      { name: "root", children: { bad: { name: 42, children: {} } } },
      null,
    ];

    for (const input of inputs) {
      const zodResult = DirNode.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("deep recursive tree (4 levels) matches Zod results", () => {
    const TreeNode: z.ZodType = z.object({
      value: z.string(),
      children: z.array(z.lazy(() => TreeNode)),
    });

    const safeParse = compileWithRefs(TreeNode, "deepTree");
    const deepTree = {
      value: "L0",
      children: [
        {
          value: "L1",
          children: [
            {
              value: "L2",
              children: [{ value: "L3", children: [{ value: "L4", children: [] }] }],
            },
          ],
        },
      ],
    };

    const zodResult = TreeNode.safeParse(deepTree);
    const aotResult = safeParse(deepTree);
    expect(aotResult.success).toBe(zodResult.success);
    if (aotResult.success && zodResult.success) {
      expect(aotResult.data).toEqual(zodResult.data);
    }
  });

  it("recursive schema error paths match Zod", () => {
    const TreeNode: z.ZodType = z.object({
      value: z.string(),
      children: z.array(z.lazy(() => TreeNode)),
    });

    const safeParse = compileWithRefs(TreeNode, "treePaths");
    const input = {
      value: "root",
      children: [
        { value: "ok", children: [] },
        { value: 42, children: [] },
      ],
    };

    const zodResult = TreeNode.safeParse(input);
    const aotResult = safeParse(input);
    expect(aotResult.success).toBe(false);
    expect(zodResult.success).toBe(false);
    if (!aotResult.success && !zodResult.success) {
      expect(aotResult.error.issues[0]?.path).toEqual(zodResult.error.issues[0]?.path);
    }
  });

  it("non-recursive lazy compiles fully without fallback", () => {
    const schema = z.object({
      name: z.lazy(() => z.string().min(1)),
      age: z.number(),
    });

    const safeParse = compileWithRefs(schema, "lazySimple");
    const inputs = [{ name: "Alice", age: 30 }, { name: "", age: 30 }, { name: 42, age: 30 }, null];

    for (const input of inputs) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("schemas without fallbacks still work normally", () => {
    const schema = z.object({
      name: z.string().min(1),
      age: z.number().int().positive(),
    });

    const safeParse = compileWithRefs(schema, "noFallback");
    const inputs = [
      { name: "Alice", age: 30 },
      { name: "", age: 30 },
      { name: "Bob", age: -1 },
      null,
    ];

    for (const input of inputs) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Coerce Types
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — coerce schemas match Zod", () => {
  it("z.coerce.string()", () => {
    const schema = z.coerce.string();
    for (const input of [42, true, null, undefined, "hello", 0, "", 3.14]) {
      assertSameResult(schema, input, "coerceString");
    }
  });

  it("z.coerce.number()", () => {
    const schema = z.coerce.number();
    for (const input of ["42", "3.14", "0", "", "abc", true, false, null, undefined, 42]) {
      assertSameResult(schema, input, "coerceNumber");
    }
  });

  it("z.coerce.number() with checks", () => {
    const schema = z.coerce.number().int().positive();
    for (const input of ["42", "3.14", "-1", "0", "abc", 42]) {
      assertSameResult(schema, input, "coerceNumberChecks");
    }
  });

  it("z.coerce.boolean()", () => {
    const schema = z.coerce.boolean();
    for (const input of [1, 0, "true", "", null, undefined, true, false, "hello"]) {
      assertSameResult(schema, input, "coerceBoolean");
    }
  });

  it("z.coerce.bigint()", () => {
    const schema = z.coerce.bigint();
    for (const input of ["42", 42, "0", 0, true, false]) {
      assertSameResult(schema, input, "coerceBigint");
    }
  });

  it("z.coerce.bigint() with invalid input", () => {
    const schema = z.coerce.bigint();
    for (const input of ["abc", 3.14, null, undefined, ""]) {
      assertSameResult(schema, input, "coerceBigintInvalid");
    }
  });

  it("z.coerce.date()", () => {
    const schema = z.coerce.date();
    for (const input of ["2024-01-01", 0, 1704067200000, "invalid", null, undefined]) {
      assertSameResult(schema, input, "coerceDate");
    }
  });

  it("coerce in nested object", () => {
    const schema = z.object({
      name: z.coerce.string(),
      age: z.coerce.number(),
    });
    for (const input of [
      { name: 42, age: "25" },
      { name: "Alice", age: 30 },
      { name: null, age: "abc" },
    ]) {
      assertSameResult(schema, input, "coerceNested");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// StringBool Type
// ═══════════════════════════════════════════════════════════════════════════════

// stringBool codec pattern (reverseTransform) requires Zod >= 4.1
describe.skipIf(!zodAtLeast("4.1"))("integration — stringBool schema matches Zod", () => {
  it("z.stringbool() with default truthy values", () => {
    const schema = z.stringbool();
    for (const input of ["true", "1", "yes", "on", "y", "enabled"]) {
      assertSameResult(schema, input, "stringBool");
    }
  });

  it("z.stringbool() with default falsy values", () => {
    const schema = z.stringbool();
    for (const input of ["false", "0", "no", "off", "n", "disabled"]) {
      assertSameResult(schema, input, "stringBoolFalsy");
    }
  });

  it("z.stringbool() case-insensitive", () => {
    const schema = z.stringbool();
    for (const input of ["TRUE", "True", "FALSE", "Yes", "NO"]) {
      assertSameResult(schema, input, "stringBoolCase");
    }
  });

  it("z.stringbool() rejects invalid values", () => {
    const schema = z.stringbool();
    for (const input of ["maybe", "", "2", 42, true, null, undefined]) {
      assertSameResult(schema, input, "stringBoolInvalid");
    }
  });

  it("z.stringbool() with case-sensitive mode", () => {
    const schema = z.stringbool({ case: "sensitive" });
    for (const input of ["true", "TRUE", "false", "FALSE", "yes", "YES"]) {
      assertSameResult(schema, input, "stringBoolSensitive");
    }
  });

  it("z.stringbool() with custom truthy/falsy", () => {
    const schema = z.stringbool({ truthy: ["1", "yes"], falsy: ["0", "no"] });
    for (const input of ["1", "yes", "0", "no", "true", "false", "on"]) {
      assertSameResult(schema, input, "stringBoolCustom");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// File Type
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — file schema matches Zod", () => {
  it("z.file() accepts File instances", () => {
    const schema = z.file();
    const file = new File(["hello"], "test.txt", { type: "text/plain" });
    assertSameResult(schema, file, "file");
  });

  it("z.file() rejects non-File values", () => {
    const schema = z.file();
    for (const input of ["hello", 42, null, undefined, {}, []]) {
      assertSameResult(schema, input, "fileReject");
    }
  });

  it("z.file().min() validates minimum size", () => {
    const schema = z.file().min(10);
    const small = new File(["hi"], "small.txt");
    const large = new File(["a".repeat(20)], "large.txt");
    assertSameResult(schema, small, "fileMin");
    assertSameResult(schema, large, "fileMin");
  });

  it("z.file().max() validates maximum size", () => {
    const schema = z.file().max(5);
    const small = new File(["hi"], "small.txt");
    const large = new File(["a".repeat(20)], "large.txt");
    assertSameResult(schema, small, "fileMax");
    assertSameResult(schema, large, "fileMax");
  });

  it("z.file().mime() validates MIME type", () => {
    const schema = z.file().mime(["image/png", "image/jpeg"]);
    const png = new File(["data"], "img.png", { type: "image/png" });
    const txt = new File(["data"], "doc.txt", { type: "text/plain" });
    assertSameResult(schema, png, "fileMime");
    assertSameResult(schema, txt, "fileMime");
  });

  it("z.file() with combined checks", () => {
    const schema = z.file().min(1).max(10000).mime("text/plain");
    const valid = new File(["hello"], "test.txt", { type: "text/plain" });
    const wrongType = new File(["hello"], "img.png", { type: "image/png" });
    assertSameResult(schema, valid, "fileCombined");
    assertSameResult(schema, wrongType, "fileCombined");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TemplateLiteral Type
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — templateLiteral schema matches Zod", () => {
  it("simple template literal", () => {
    const schema = z.templateLiteral([z.literal("user-"), z.number().int()]);
    for (const input of ["user-42", "user-0", "user-abc", "admin-42", "", 42, null]) {
      assertSameResult(schema, input, "templateLiteral");
    }
  });

  it("template literal with string and number", () => {
    const schema = z.templateLiteral([z.string(), z.literal("-v"), z.number().int()]);
    for (const input of ["hello-v1", "test-v42", "x-v0", "-v1", "hello-v", 42]) {
      assertSameResult(schema, input, "templateLiteralComplex");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Catch Type
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — catch schema matches Zod", () => {
  // catchValue is referenced at runtime through __rf — needs the refs harness.
  function assertCatchParity(schema: z.ZodType, inputs: unknown[], name: string) {
    const safeParse = compileWithRefs(schema, name);
    for (const input of inputs) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (zodResult.success && aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  }

  it("z.string().catch('default')", () => {
    assertCatchParity(
      z.string().catch("default"),
      ["hello", 42, null, undefined, true, {}, []],
      "catchString",
    );
  });

  it("z.number().catch(0)", () => {
    assertCatchParity(z.number().catch(0), [42, "abc", null, undefined, true], "catchNumber");
  });

  it("catch in nested object", () => {
    assertCatchParity(
      z.object({
        name: z.string().catch("anonymous"),
        age: z.number().catch(0),
      }),
      [
        { name: "Alice", age: 30 },
        { name: 42, age: "abc" },
        { name: null, age: null },
      ],
      "catchNested",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Branded Type (passthrough verification)
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — branded schema matches Zod", () => {
  it("z.string().brand<'Email'>()", () => {
    const schema = z.string().brand<"Email">();
    for (const input of ["hello@example.com", "", 42, null, undefined]) {
      assertSameResult(schema, input, "branded");
    }
  });

  it("branded with checks", () => {
    const schema = z.string().min(3).brand<"Username">();
    for (const input of ["Alice", "Al", "", 42, null]) {
      assertSameResult(schema, input, "brandedChecks");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// String Formats (url, uuid)
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — string format schemas match Zod", () => {
  it("z.url()", () => {
    const schema = z.url();
    for (const input of [
      "https://example.com",
      "http://localhost:3000",
      "ftp://files.example.com",
      "https://example.com/path?query=1#hash",
      "not-a-url",
      "",
      "http://",
      42,
      null,
      undefined,
    ]) {
      assertSameResult(schema, input, "url");
    }
  });

  it("z.uuid()", () => {
    const schema = z.uuid();
    for (const input of [
      "550e8400-e29b-41d4-a716-446655440000",
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "not-a-uuid",
      "",
      "550e8400-e29b-41d4-a716",
      "550e8400e29b41d4a716446655440000",
      42,
      null,
    ]) {
      assertSameResult(schema, input, "uuid");
    }
  });

  it("z.email() with more edge cases", () => {
    const schema = z.email();
    for (const input of [
      "user@example.com",
      "user+tag@example.com",
      "user@sub.domain.com",
      "a@b.co",
      "@example.com",
      "user@",
      "user@.com",
      "",
      42,
      null,
    ]) {
      assertSameResult(schema, input, "emailEdge");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// String Checks (includes, startsWith, endsWith)
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — string check schemas match Zod", () => {
  it("includes(substring)", () => {
    const schema = z.string().includes("foo");
    for (const input of ["foobar", "barfoo", "barfoobaz", "bar", "", "FOO", 42, null]) {
      assertSameResult(schema, input, "includes");
    }
  });

  it("includes(substring, { position })", () => {
    const schema = z.string().includes("foo", { position: 3 });
    for (const input of ["barfoo", "foobar", "bazfoo", "bar", "abcfoo", 42]) {
      assertSameResult(schema, input, "includesPos");
    }
  });

  it("startsWith(prefix)", () => {
    const schema = z.string().startsWith("pre-");
    for (const input of ["pre-fix", "pre-", "prefix", "PRE-fix", "", "notpre", 42, null]) {
      assertSameResult(schema, input, "startsWith");
    }
  });

  it("endsWith(suffix)", () => {
    const schema = z.string().endsWith(".ts");
    for (const input of ["file.ts", "file.tsx", ".ts", "file.TS", "", "ts", 42, null]) {
      assertSameResult(schema, input, "endsWith");
    }
  });

  it("combined string checks", () => {
    const schema = z.string().min(3).max(20).startsWith("id-");
    for (const input of ["id-abc", "id-", "id-a", "abc", `id-${"x".repeat(20)}`, 42]) {
      assertSameResult(schema, input, "combinedStr");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Number Formats (int32, uint32, float32, float64, safeint)
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — number format schemas match Zod", () => {
  it("z.int() (safeint)", () => {
    const schema = z.int();
    for (const input of [
      0,
      42,
      -42,
      3.14,
      9007199254740991,
      -9007199254740991,
      9007199254740992,
      -9007199254740992,
      NaN,
      Infinity,
      "42",
      null,
    ]) {
      assertSameResult(schema, input, "int");
    }
  });

  it("z.int32()", () => {
    const schema = z.int32();
    for (const input of [
      0,
      42,
      -42,
      2147483647,
      -2147483648,
      2147483648,
      -2147483649,
      3.14,
      NaN,
      Infinity,
      "42",
      null,
    ]) {
      assertSameResult(schema, input, "int32");
    }
  });

  it("z.uint32()", () => {
    const schema = z.uint32();
    for (const input of [0, 42, 4294967295, 4294967296, -1, 3.14, NaN, Infinity, "42", null]) {
      assertSameResult(schema, input, "uint32");
    }
  });

  it("z.float32()", () => {
    const schema = z.float32();
    for (const input of [
      0,
      3.14,
      -3.14,
      3.4028234663852886e38,
      -3.4028234663852886e38,
      3.5e38,
      -3.5e38,
      NaN,
      Infinity,
      "3.14",
      null,
    ]) {
      assertSameResult(schema, input, "float32");
    }
  });

  it("z.float64()", () => {
    const schema = z.float64();
    for (const input of [
      0,
      3.14,
      -3.14,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
      NaN,
      Infinity,
      -Infinity,
      "3.14",
      null,
    ]) {
      assertSameResult(schema, input, "float64");
    }
  });

  it("z.number().int().positive()", () => {
    const schema = z.number().int().positive();
    for (const input of [1, 42, 0, -1, 3.14, NaN, "42"]) {
      assertSameResult(schema, input, "intPositive");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Error Issue Comparison — String
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — string error issues match Zod", () => {
  it("too_small issue for min()", () => {
    assertSameIssues(z.string().min(3), "ab", "strMin");
  });

  it("too_big issue for max()", () => {
    assertSameIssues(z.string().max(5), "abcdef", "strMax");
  });

  it("invalid_string issue for email format", () => {
    assertSameIssues(z.email(), "not-email", "emailIssue");
  });

  it("invalid_string issue for url format", () => {
    assertSameIssues(z.url(), "not-a-url", "urlIssue");
  });

  it("invalid_string issue for uuid format", () => {
    assertSameIssues(z.uuid(), "not-a-uuid", "uuidIssue");
  });

  it("invalid_string issue for includes", () => {
    assertSameIssues(z.string().includes("foo"), "bar", "inclIssue");
  });

  it("invalid_string issue for startsWith", () => {
    assertSameIssues(z.string().startsWith("pre-"), "hello", "swIssue");
  });

  it("invalid_string issue for endsWith", () => {
    assertSameIssues(z.string().endsWith(".ts"), "file.js", "ewIssue");
  });

  it("invalid_type issue for non-string input", () => {
    assertSameIssues(z.string(), 42, "strType");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Error Issue Comparison — Number
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — number error issues match Zod", () => {
  it("too_small issue for min()", () => {
    assertSameIssues(z.number().min(10), 5, "numMin");
  });

  it("too_big issue for max()", () => {
    assertSameIssues(z.number().max(100), 200, "numMax");
  });

  it("not_multiple_of issue for multipleOf()", () => {
    assertSameIssues(z.number().multipleOf(3), 7, "numMul");
  });

  it("invalid_type issue for non-number input", () => {
    assertSameIssues(z.number(), "hello", "numType");
  });

  it("invalid_type issue for NaN", () => {
    assertSameIssues(z.number(), NaN, "numNaN");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Error Issue Comparison — Object
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — object error issues match Zod", () => {
  it("missing required property", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    assertSameIssues(schema, { name: "Alice" }, "objMissing");
  });

  it("wrong property type", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    assertSameIssues(schema, { name: 42, age: "not number" }, "objWrongType");
  });

  it("invalid_type for non-object", () => {
    const schema = z.object({ name: z.string() });
    assertSameIssues(schema, "not an object", "objNotObj");
  });

  it("nested object error paths", () => {
    const schema = z.object({
      user: z.object({
        name: z.string().min(3),
        email: z.email(),
      }),
    });
    const input = { user: { name: "ab", email: "bad" } };
    const zodResult = schema.safeParse(input);
    const safeParse = compileZodSchema(schema, "objNested");
    const aotResult = safeParse(input);
    expect(aotResult.success).toBe(false);
    expect(zodResult.success).toBe(false);
    if (!aotResult.success && !zodResult.success) {
      // Verify paths are correct
      for (let i = 0; i < zodResult.error.issues.length; i++) {
        expect((aotResult.error?.issues[i] as Record<string, unknown>)?.["path"]).toEqual(
          zodResult.error.issues[i]?.path,
        );
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Error Issue Comparison — Array
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — array error issues match Zod", () => {
  it("invalid element type", () => {
    const schema = z.array(z.number());
    assertSameIssues(schema, [1, "two", 3], "arrElem");
  });

  it("too_small for min length", () => {
    assertSameIssues(z.array(z.string()).min(2), ["one"], "arrMin");
  });

  it("too_big for max length", () => {
    assertSameIssues(z.array(z.string()).max(2), ["a", "b", "c"], "arrMax");
  });

  it("invalid_type for non-array", () => {
    assertSameIssues(z.array(z.string()), "not array", "arrNotArr");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Error Issue Comparison — Date
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — date error issues match Zod", () => {
  it("invalid_type for non-date input", () => {
    assertSameIssues(z.date(), "not a date", "dateType");
  });

  it("invalid_date for new Date('invalid')", () => {
    assertSameIssues(z.date(), new Date("invalid"), "dateInvalid");
  });

  it("too_small for min date", () => {
    const minDate = new Date("2024-01-01");
    const schema = z.date().min(minDate);
    // Use assertSameResult (not assertSameIssues) because date range issue
    // structure varies across Zod versions (tested in zod-compat matrix).
    assertSameResult(schema, new Date("2023-12-31"), "dateMin");
  });

  it("too_big for max date", () => {
    const maxDate = new Date("2024-12-31");
    const schema = z.date().max(maxDate);
    assertSameResult(schema, new Date("2025-01-01"), "dateMax");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Composite Patterns
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — composite schema patterns match Zod", () => {
  it("array of unions", () => {
    const schema = z.array(z.union([z.string(), z.number()]));
    for (const input of [
      ["hello", 42, "world"],
      [],
      [true],
      ["only strings"],
      [1, 2, 3],
      [1, "two", true],
      "not array",
    ]) {
      assertSameResult(schema, input, "arrUnion");
    }
  });

  it("union of objects", () => {
    const schema = z.union([
      z.object({ type: z.literal("text"), content: z.string() }),
      z.object({ type: z.literal("image"), url: z.url() }),
    ]);
    for (const input of [
      { type: "text", content: "hello" },
      { type: "image", url: "https://example.com/img.png" },
      { type: "video" },
      { type: "text", content: 42 },
      null,
    ]) {
      assertSameResult(schema, input, "unionObj");
    }
  });

  it("record with union values", () => {
    const schema = z.record(z.string(), z.union([z.string(), z.number()]));
    for (const input of [{ a: "hello", b: 42 }, { a: true }, {}, null]) {
      assertSameResult(schema, input, "recUnion");
    }
  });

  it("nested discriminatedUnion", () => {
    const innerUnion = z.discriminatedUnion("action", [
      z.object({ action: z.literal("create"), name: z.string() }),
      z.object({ action: z.literal("delete"), id: z.number() }),
    ]);
    const schema = z.object({
      request: innerUnion,
      timestamp: z.number(),
    });
    for (const input of [
      { request: { action: "create", name: "test" }, timestamp: 123 },
      { request: { action: "delete", id: 1 }, timestamp: 123 },
      { request: { action: "update" }, timestamp: 123 },
      { request: { action: "create", name: 42 }, timestamp: 123 },
      null,
    ]) {
      assertSameResult(schema, input, "nestedDiscUnion");
    }
  });

  it("tuple with union elements", () => {
    const schema = z.tuple([z.union([z.string(), z.number()]), z.boolean()]);
    for (const input of [["hello", true], [42, false], [true, true], ["hello"], [], "not array"]) {
      assertSameResult(schema, input, "tupleUnion");
    }
  });

  it("optional union in object", () => {
    const schema = z.object({
      id: z.number(),
      metadata: z.union([z.string(), z.number()]).optional(),
    });
    for (const input of [
      { id: 1 },
      { id: 1, metadata: "hello" },
      { id: 1, metadata: 42 },
      { id: 1, metadata: true },
      { id: "bad" },
    ]) {
      assertSameResult(schema, input, "optUnion");
    }
  });

  it("array of discriminatedUnion", () => {
    const schema = z.array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("a"), value: z.string() }),
        z.object({ kind: z.literal("b"), value: z.number() }),
      ]),
    );
    for (const input of [
      [{ kind: "a", value: "hello" }],
      [{ kind: "b", value: 42 }],
      [
        { kind: "a", value: "hello" },
        { kind: "b", value: 42 },
      ],
      [{ kind: "c" }],
      [],
      "not array",
    ]) {
      assertSameResult(schema, input, "arrDiscUnion");
    }
  });

  it("intersection with checks", () => {
    const schema = z.intersection(
      z.object({ name: z.string().min(3) }),
      z.object({ age: z.number().int().positive() }),
    );
    for (const input of [
      { name: "Alice", age: 25 },
      { name: "Al", age: 25 },
      { name: "Alice", age: -1 },
      { name: "Al", age: -1 },
      null,
    ]) {
      assertSameResult(schema, input, "intersectChecks");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — edge cases match Zod", () => {
  it("empty object z.object({})", () => {
    const schema = z.object({});
    // Note: Zod strips unknown keys, AOT passes through — compare success only
    const safeParse = compileZodSchema(schema, "emptyObj");
    for (const input of [{}, { extra: "ignored" }, null, "string", 42, undefined]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("deeply nested objects (5 levels)", () => {
    const schema = z.object({
      a: z.object({
        b: z.object({
          c: z.object({
            d: z.object({
              e: z.string(),
            }),
          }),
        }),
      }),
    });
    for (const input of [
      { a: { b: { c: { d: { e: "deep" } } } } },
      { a: { b: { c: { d: { e: 42 } } } } },
      { a: { b: { c: { d: {} } } } },
      { a: {} },
      null,
    ]) {
      assertSameResult(schema, input, "deepNest");
    }
  });

  it("object with many properties", () => {
    const schema = z.object({
      a: z.string(),
      b: z.number(),
      c: z.boolean(),
      d: z.string().optional(),
      e: z.number().nullable(),
      f: z.array(z.string()),
      g: z.enum(["x", "y", "z"]),
      h: z.literal(true),
      i: z.string().min(1).max(50),
      j: z.number().int().positive(),
    });

    const valid = {
      a: "hello",
      b: 42,
      c: true,
      d: "opt",
      e: null,
      f: ["a", "b"],
      g: "x",
      h: true,
      i: "valid",
      j: 1,
    };
    const minimal = {
      a: "hello",
      b: 42,
      c: true,
      e: 1,
      f: [],
      g: "y",
      h: true,
      i: "v",
      j: 1,
    };
    const invalid = {
      a: 42,
      b: "str",
      c: "bool",
      d: 0,
      e: "str",
      f: "not arr",
      g: "w",
      h: false,
      i: "",
      j: -1,
    };

    for (const input of [valid, minimal, invalid, null]) {
      assertSameResult(schema, input, "manyProps");
    }
  });

  it("nullable array of nullable strings", () => {
    const schema = z.array(z.string().nullable()).nullable();
    for (const input of [null, [], ["hello", null, "world"], ["hello", 42], "not array"]) {
      assertSameResult(schema, input, "nullableArr");
    }
  });

  it("optional nullable with default", () => {
    const schema = z.object({
      value: z.string().nullable().optional().default("fallback"),
    });
    const safeParse = compileWithRefs(schema, "optNullDef");
    for (const input of [
      {},
      { value: undefined },
      { value: null },
      { value: "hello" },
      { value: 42 },
    ]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (zodResult.success && aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("record with enum keys requires exhaustive keys (full Zod parity via fallback)", () => {
    const schema = z.record(z.enum(["a", "b", "c"]), z.number());
    const safeParse = compileWithRefs(schema, "recEnum");
    for (const input of [
      { a: 1, b: 2, c: 3 }, // valid: all keys present
      { a: 1, b: 2, c: "str" }, // invalid: wrong value type
      { a: 1, d: 4 }, // invalid: missing b,c (Zod requires every enum key)
      { a: 1, b: 2, c: 3, d: 4 }, // invalid: unrecognized key
      null, // invalid: non-object
    ]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("partialRecord with enum keys allows missing keys and compiles", () => {
    const schema = z.partialRecord(z.enum(["a", "b", "c"]), z.number());
    const safeParse = compileWithRefs(schema, "recPartial");
    for (const input of [{ a: 1 }, {}, { a: 1, b: 2, c: 3 }, { a: "bad" }, null]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("array with length_equals check", () => {
    const schema = z.array(z.string()).length(3);
    for (const input of [["a", "b", "c"], ["a", "b"], ["a", "b", "c", "d"], [], "not array"]) {
      assertSameResult(schema, input, "arrLen");
    }
  });

  it("map with complex key and value types", () => {
    const schema = z.map(z.string(), z.object({ score: z.number() }));
    const inputs = [
      new Map([["alice", { score: 95 }]]),
      new Map([
        ["alice", { score: 95 }],
        ["bob", { score: 80 }],
      ]),
      new Map([["alice", { score: "bad" }]]),
      new Map([[42, { score: 95 }]]),
      new Map(),
      "not a map",
      null,
    ];
    for (const input of inputs) {
      assertSameResult(schema, input, "mapComplex");
    }
  });

  it("set with element checks", () => {
    const schema = z.set(z.string().min(2));
    const inputs = [
      new Set(["ab", "cd"]),
      new Set(["a"]),
      new Set(["ab", "c"]),
      new Set(),
      "not a set",
    ];
    for (const input of inputs) {
      assertSameResult(schema, input, "setChecks");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Real-World Schemas (additional)
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration — additional real-world schemas match Zod", () => {
  it("config file schema", () => {
    const schema = z.object({
      name: z.string().min(1),
      version: z.string().regex(/^\d+\.\d+\.\d+$/),
      dependencies: z.record(z.string(), z.string()),
      scripts: z.record(z.string(), z.string()).optional(),
      private: z.boolean().optional(),
    });

    for (const input of [
      { name: "my-pkg", version: "1.0.0", dependencies: {} },
      {
        name: "my-pkg",
        version: "1.0.0",
        dependencies: { zod: "^4.0.0" },
        scripts: { test: "vitest" },
        private: true,
      },
      { name: "", version: "1.0.0", dependencies: {} },
      { name: "pkg", version: "invalid", dependencies: {} },
      { name: "pkg", version: "1.0.0", dependencies: { zod: 42 } },
      null,
    ]) {
      assertSameResult(schema, input, "configFile");
    }
  });

  it("event log schema", () => {
    const schema = z.object({
      id: z.uuid(),
      timestamp: z.number().int().positive(),
      event: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("click"),
          target: z.string(),
          x: z.number(),
          y: z.number(),
        }),
        z.object({
          type: z.literal("navigate"),
          url: z.url(),
          referrer: z.url().optional(),
        }),
        z.object({
          type: z.literal("error"),
          message: z.string().min(1),
          stack: z.string().optional(),
        }),
      ]),
      tags: z.array(z.string()).optional(),
    });

    for (const input of [
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        timestamp: 1704067200000,
        event: { type: "click", target: "#btn", x: 100, y: 200 },
      },
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        timestamp: 1704067200000,
        event: { type: "navigate", url: "https://example.com" },
        tags: ["user", "session"],
      },
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        timestamp: 1704067200000,
        event: { type: "error", message: "Something went wrong" },
      },
      // Invalid: bad uuid
      {
        id: "not-uuid",
        timestamp: 1704067200000,
        event: { type: "click", target: "#btn", x: 100, y: 200 },
      },
      // Invalid: unknown event type
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        timestamp: 1704067200000,
        event: { type: "scroll", offset: 100 },
      },
      // Invalid: bad url in navigate event
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        timestamp: 1704067200000,
        event: { type: "navigate", url: "not-a-url" },
      },
      null,
    ]) {
      assertSameResult(schema, input, "eventLog");
    }
  });

  it("database row schema", () => {
    const schema = z.object({
      id: z.int32(),
      email: z.email(),
      name: z.string().min(1).max(255),
      age: z.uint32().optional(),
      score: z.float64(),
      active: z.boolean(),
      tags: z.set(z.string()),
      metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      created: z.date(),
    });

    for (const input of [
      {
        id: 1,
        email: "alice@example.com",
        name: "Alice",
        age: 25,
        score: 98.5,
        active: true,
        tags: new Set(["admin"]),
        metadata: { role: "admin", level: 5 },
        created: new Date("2024-01-01"),
      },
      {
        id: 2,
        email: "bob@example.com",
        name: "Bob",
        score: 72.3,
        active: false,
        tags: new Set(),
        metadata: {},
        created: new Date("2024-06-15"),
      },
      // Invalid: bad email
      {
        id: 3,
        email: "bad-email",
        name: "X",
        score: 0,
        active: true,
        tags: new Set(),
        metadata: {},
        created: new Date(),
      },
      // Invalid: id out of int32 range
      {
        id: 2147483648,
        email: "a@b.com",
        name: "Y",
        score: 0,
        active: true,
        tags: new Set(),
        metadata: {},
        created: new Date(),
      },
      null,
    ]) {
      assertSameResult(schema, input, "dbRow");
    }
  });
});

// ─── Effect Compilation (end-to-end) ────────────────────────────────────────

describe("integration — zero-capture transform (effect compilation)", () => {
  it("string.transform(v => v.toUpperCase()) matches Zod", () => {
    const schema = z.string().transform((v) => v.toUpperCase());
    const safeParse = compileWithRefs(schema, "strUpper");

    for (const input of ["hello", "WORLD", "", 42, null]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("string.transform(v => parseInt(v, 10)) matches Zod", () => {
    const schema = z.string().transform((v) => parseInt(v, 10));
    const safeParse = compileWithRefs(schema, "strParse");

    for (const input of ["42", "0", "abc", "", 123, null]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("number.transform(v => Math.round(v)) matches Zod", () => {
    const schema = z.number().transform((v) => Math.round(v));
    const safeParse = compileWithRefs(schema, "numRound");

    for (const input of [3.7, 3.2, 0, -1.5, "not a number", null]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("string.min(3).transform(v => v.toLowerCase()) validates then transforms", () => {
    const schema = z
      .string()
      .min(3)
      .transform((v) => v.toLowerCase());
    const safeParse = compileWithRefs(schema, "minThenLower");

    for (const input of ["HELLO", "Hi", "ABC", "", 42]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("object with transform property compiles without fallback", () => {
    const schema = z.object({
      name: z.string().min(1),
      slug: z.string().transform((v) => v.toLowerCase()),
      score: z.number().transform((v) => Math.round(v)),
    });

    const safeParse = compileWithRefs(schema, "objTransform");

    for (const input of [
      { name: "Alice", slug: "HELLO-WORLD", score: 95.7 },
      { name: "Bob", slug: "test", score: 0 },
      { name: "", slug: "test", score: 1 },
      { name: "Alice", slug: 42, score: 1 },
      null,
    ]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("array of transform elements matches Zod", () => {
    const schema = z.array(z.string().transform((v) => v.trim()));
    const safeParse = compileWithRefs(schema, "arrTrim");

    for (const input of [[" hello ", " world "], [], ["no-trim"], [42], "not array"]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("optional transform matches Zod", () => {
    const schema = z.object({
      label: z.optional(z.string().transform((v) => v.toUpperCase())),
    });
    const safeParse = compileWithRefs(schema, "optTransform");

    for (const input of [{ label: "hello" }, { label: undefined }, {}, { label: 42 }, null]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("nullable transform matches Zod", () => {
    const schema = z.object({
      value: z.nullable(z.string().transform((v) => v.trim())),
    });
    const safeParse = compileWithRefs(schema, "nullableTransformE2E");

    for (const input of [{ value: " hello " }, { value: null }, { value: 42 }, null]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });
});

describe("integration — zero-capture refine (effect compilation)", () => {
  it("string.refine(v => v.includes('@')) matches Zod success/failure", () => {
    const schema = z.string().refine((v) => v.includes("@"));
    const safeParse = compileWithRefs(schema, "strRefine");

    for (const input of ["a@b.com", "no-at", "", 42, null]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("number.refine(v => v % 2 === 0) matches Zod", () => {
    const schema = z.number().refine((v) => v % 2 === 0);
    const safeParse = compileWithRefs(schema, "numEven");

    for (const input of [2, 4, 0, 3, 5, -2, "two", null]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("string.min(3).refine(v => v.startsWith('a')) validates checks then refine", () => {
    const schema = z
      .string()
      .min(3)
      .refine((v) => v.startsWith("a"));
    const safeParse = compileWithRefs(schema, "minThenRefine");

    for (const input of ["abc", "ab", "bcd", "abcdef", "", 42]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("object with refine property matches Zod", () => {
    const schema = z.object({
      email: z.string().refine((v) => v.includes("@")),
      age: z.number().refine((v) => v >= 18),
    });
    const safeParse = compileWithRefs(schema, "objRefine");

    for (const input of [
      { email: "a@b.com", age: 25 },
      { email: "invalid", age: 25 },
      { email: "a@b.com", age: 10 },
      { email: "invalid", age: 10 },
      null,
    ]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("object-level refine z.object({...}).refine(fn) matches Zod", () => {
    const schema = z
      .object({
        password: z.string().min(1),
        confirm: z.string().min(1),
      })
      .refine((v) => v.password === v.confirm);
    const safeParse = compileWithRefs(schema, "objLevelRefine");

    for (const input of [
      { password: "abc", confirm: "abc" },
      { password: "abc", confirm: "xyz" },
      { password: "", confirm: "" },
      null,
    ]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });
});

describe("integration — mixed effect + standard compilation", () => {
  it("object with transform, refine, and plain fields matches Zod", () => {
    const schema = z.object({
      name: z.string().min(1),
      slug: z.string().transform((v) => v.toLowerCase()),
      active: z.boolean(),
      score: z.number().refine((v) => v >= 0),
    });
    const safeParse = compileWithRefs(schema, "mixed");

    for (const input of [
      { name: "Alice", slug: "HELLO", active: true, score: 95 },
      { name: "Alice", slug: "HELLO", active: true, score: -1 },
      { name: "", slug: "test", active: true, score: 0 },
      { name: "Alice", slug: 42, active: true, score: 0 },
      null,
    ]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("deep nested object with transforms matches Zod", () => {
    const schema = z.object({
      users: z.array(
        z.object({
          name: z.string().transform((v) => v.trim()),
          age: z.number().transform((v) => Math.floor(v)),
          tags: z.array(z.string().transform((v) => v.toLowerCase())),
        }),
      ),
    });
    const safeParse = compileWithRefs(schema, "deepTransform");

    for (const input of [
      {
        users: [
          { name: " Alice ", age: 25.7, tags: ["ADMIN", " User "] },
          { name: "Bob", age: 30, tags: [] },
        ],
      },
      { users: [] },
      { users: [{ name: "A", age: "bad", tags: [] }] },
      null,
    ]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });

  it("union with transform option matches Zod", () => {
    const schema = z.union([
      z.string().transform((v) => v.toUpperCase()),
      z.number().transform((v) => String(v)),
    ]);
    const safeParse = compileWithRefs(schema, "unionTransform");

    for (const input of ["hello", 42, true, null]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (aotResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });
});

describe("integration — refine custom message", () => {
  it("refine with string message preserves message in error", () => {
    const schema = z.string().refine((v) => v.includes("@"), "must contain @");
    const safeParse = compileWithRefs(schema, "refineMsg");

    const result = safeParse("no-at");
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0] as { message: string; code: string };
      expect(issue.code).toBe("custom");
      expect(issue.message).toBe("must contain @");
    }
  });

  it("refine with object message preserves message in error", () => {
    const schema = z.string().refine((v) => v.length > 0, { message: "cannot be empty" });
    const safeParse = compileWithRefs(schema, "refineObjMsg");

    const result = safeParse("");
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0] as { message: string };
      expect(issue.message).toBe("cannot be empty");
    }
  });

  it("refine without message matches Zod's locale default through __zcFin", () => {
    const schema = z.string().refine((v) => v.length > 0);
    // Wire __zcMsg exactly like production output (ZOD_MSG_DECLARATION) so the
    // locale default lands on the message — must equal Zod's own message.
    const refEntries: RefEntry[] = [];
    const ir = extractSchema(schema, refEntries);
    const generated = generateValidator(ir, "refineNoMsg", { refCount: refEntries.length });
    const localizedFin = new Function("__zcMsg", "__zcZodError", `${FIN_DECL}; return __zcFin;`)(
      z.config().localeError,
      ZodRealError,
    );
    const safeParse = new Function(
      "__zcMsg",
      "__zcZodError",
      "__zcFin",
      `${FIN_DEFERRED_DECL}\n${generated.code}\nreturn ${generated.functionDef};`,
    )(z.config().localeError, ZodRealError, localizedFin) as (
      input: unknown,
    ) => SafeParseResult<unknown>;

    const result = safeParse("");
    const zodResult = schema.safeParse("");
    expect(result.success).toBe(false);
    expect(zodResult.success).toBe(false);
    if (!result.success && !zodResult.success) {
      const issue = result.error.issues[0] as { message: string };
      expect(issue.message).toBe(zodResult.error.issues[0]?.message);
    }
  });
});

describe("integration — check ordering with refine_effect", () => {
  it("refine before min: issue code order matches Zod", () => {
    const schema = z
      .string()
      .refine((v) => v.startsWith("x"), "must start with x")
      .min(10);
    const safeParse = compileWithRefs(schema, "refineOrder");

    // Input fails both: refine (doesn't start with x) and min (len 2 < 10)
    const zodResult = schema.safeParse("ab");
    const aotResult = safeParse("ab");
    expect(aotResult.success).toBe(false);
    expect(zodResult.success).toBe(false);

    // Compare issue code order (not messages — standard check messages are not compiled)
    if (!zodResult.success && !aotResult.success) {
      const zodCodes = zodResult.error.issues.map((i) => i.code);
      const aotCodes = (aotResult.error.issues as { code: string }[]).map((i) => i.code);
      expect(aotCodes).toEqual(zodCodes);
    }
  });
});

describe("integration — catch + transform combo", () => {
  it("catch value is transformed", () => {
    const schema = z
      .number()
      .catch(0)
      .transform((v) => v * 2);
    const safeParse = compileWithRefs(schema, "catchTransform");

    // Valid number: transformed
    const r1 = schema.safeParse(5);
    const a1 = safeParse(5);
    expect(a1.success).toBe(r1.success);
    if (a1.success) expect(a1.data).toBe(r1.data);

    // Invalid (catch kicks in, then transform): catch=0, transform=0*2=0
    const r2 = schema.safeParse("bad");
    const a2 = safeParse("bad");
    expect(a2.success).toBe(r2.success);
    if (a2.success) expect(a2.data).toBe(r2.data);
  });
});

describe("integration — default + transform combo", () => {
  it("default value is transformed", () => {
    const schema = z
      .string()
      .default("hello")
      .transform((v) => v.toUpperCase());
    const safeParse = compileWithRefs(schema, "defaultTransform");

    // Provided value: transformed
    const r1 = schema.safeParse("world");
    const a1 = safeParse("world");
    expect(a1.success).toBe(r1.success);
    if (a1.success) expect(a1.data).toBe(r1.data);

    // Undefined (default kicks in): "hello" → "HELLO"
    const r2 = schema.safeParse(undefined);
    const a2 = safeParse(undefined);
    expect(a2.success).toBe(r2.success);
    if (a2.success) expect(a2.data).toBe(r2.data);
  });
});

describe("integration — ctx-aware effects fall back to Zod", () => {
  it("superRefine with ctx falls back to Zod and matches behavior", () => {
    const schema = z.string().superRefine((val, ctx) => {
      if (val.length < 3) {
        ctx.addIssue({ code: "custom", message: "too short" });
      }
    });
    const safeParse = compileWithRefs(schema, "superRefineCtx");

    for (const input of ["hello", "ab", "", 42, null]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
    }
  });

  it("transform with ctx falls back to Zod and matches behavior", () => {
    const schema = z.string().transform((val, ctx) => {
      if (val.length === 0) {
        ctx.addIssue({ code: "custom", message: "empty" });
        return z.NEVER;
      }
      return val.toUpperCase();
    });
    const safeParse = compileWithRefs(schema, "transformCtx");

    for (const input of ["hello", "", 42]) {
      const zodResult = schema.safeParse(input);
      const aotResult = safeParse(input);
      expect(aotResult.success).toBe(zodResult.success);
      if (aotResult.success && zodResult.success) {
        expect(aotResult.data).toEqual(zodResult.data);
      }
    }
  });
});

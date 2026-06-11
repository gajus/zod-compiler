import { describe, expect, it } from "vitest";
import { ZodError, ZodRealError, z } from "zod";
import { generateValidator } from "#src/core/codegen/index.js";
import type { RefEntry } from "#src/core/extract/index.js";
import { extractSchema } from "#src/core/extract/index.js";
import { FIN_DECL, FIN_DEFERRED_DECL } from "#src/core/iife.js";
import { zodAtLeast } from "./zod-version.js";

/**
 * Compile a Zod schema through zod-compiler pipeline and return a safeParse function
 * that uses Zod's locale error map for message generation.
 */
function compileForErrorTest(schema: z.ZodType, name = "test") {
  const refEntries: RefEntry[] = [];
  const ir = extractSchema(schema, refEntries);
  const result = generateValidator(ir, name, { refCount: refEntries.length });
  // oxlint-disable-next-line typescript/no-non-null-assertion -- localeError is always set in Zod v4
  const __zcMsg = z.config().localeError!;
  const __zcFin = new Function("__zcMsg", "__zcZodError", `${FIN_DECL}; return __zcFin;`)(
    __zcMsg,
    ZodRealError,
  );
  const refSchemas = refEntries.map((e) => e.schema);
  const fn =
    refSchemas.length > 0
      ? new Function(
          "__zcMsg",
          "__zcZodError",
          "__zcFin",
          "__rf",
          `${FIN_DEFERRED_DECL}\n${result.code}\nreturn ${result.functionDef};`,
        )
      : new Function(
          "__zcMsg",
          "__zcZodError",
          "__zcFin",
          `${FIN_DEFERRED_DECL}\n${result.code}\nreturn ${result.functionDef};`,
        );
  return (
    refSchemas.length > 0
      ? fn(__zcMsg, ZodRealError, __zcFin, refSchemas)
      : fn(__zcMsg, ZodRealError, __zcFin)
  ) as (input: unknown) => {
    success: boolean;
    data?: unknown;
    error?: ZodError;
  };
}

/**
 * Strip Zod-internal fields that zod-compiler cannot reproduce (e.g. `input` when reportInput is false).
 * Zod v4 deletes `input` by default via finalizeIssue.
 */
function normalizeIssues(issues: Record<string, unknown>[]): Record<string, unknown>[] {
  return issues.map((issue) => {
    const normalized = { ...issue };
    // Remove fields that are Zod-internal or non-deterministic
    delete normalized["input"];
    delete normalized["inst"];
    delete normalized["continue"];
    delete normalized["options"];
    return normalized;
  });
}

function assertSameErrors(schema: z.ZodType, input: unknown, name = "test") {
  const zodResult = schema.safeParse(input);
  const safeParse = compileForErrorTest(schema, name);
  const aotResult = safeParse(input);

  expect(aotResult.success).toBe(zodResult.success);

  if (!zodResult.success && !aotResult.success) {
    const zodIssues = normalizeIssues(
      zodResult.error.issues as unknown as Record<string, unknown>[],
    );
    const aotIssues = normalizeIssues(
      (aotResult.error?.issues ?? []) as unknown as Record<string, unknown>[],
    );
    expect(aotIssues).toEqual(zodIssues);
  }
}

// ─── Type Check Errors ──────────────────────────────────────────────────────

describe("error compat — invalid_type", () => {
  it("string receives number", () => {
    assertSameErrors(z.string(), 42, "str");
  });

  it("string receives null", () => {
    assertSameErrors(z.string(), null, "str");
  });

  it("string receives boolean", () => {
    assertSameErrors(z.string(), true, "str");
  });

  it("string receives undefined", () => {
    assertSameErrors(z.string(), undefined, "str");
  });

  it("number receives string", () => {
    assertSameErrors(z.number(), "hello", "num");
  });

  it("number receives NaN", () => {
    assertSameErrors(z.number(), NaN, "num");
  });

  it("number receives Infinity", () => {
    assertSameErrors(z.number(), Infinity, "num");
  });

  it("boolean receives number", () => {
    assertSameErrors(z.boolean(), 42, "bool");
  });

  it("null receives string", () => {
    assertSameErrors(z.null(), "hello", "nullSchema");
  });

  it("undefined receives string", () => {
    assertSameErrors(z.undefined(), "hello", "undefSchema");
  });

  it("object receives string", () => {
    assertSameErrors(z.object({ a: z.string() }), "not object", "obj");
  });

  it("object receives null", () => {
    assertSameErrors(z.object({ a: z.string() }), null, "obj");
  });

  it("object receives array", () => {
    assertSameErrors(z.object({ a: z.string() }), [1, 2], "obj");
  });

  it("array receives string", () => {
    assertSameErrors(z.array(z.string()), "not array", "arr");
  });

  it("bigint receives number", () => {
    assertSameErrors(z.bigint(), 42, "bi");
  });

  it("date receives string", () => {
    assertSameErrors(z.date(), "not a date", "dt");
  });

  it("number.int() receives float", () => {
    assertSameErrors(z.number().int(), 3.14, "numInt");
  });
});

// ─── String Check Errors ────────────────────────────────────────────────────

describe("error compat — string checks", () => {
  it("min_length", () => {
    assertSameErrors(z.string().min(3), "ab", "strMin");
  });

  it("max_length", () => {
    assertSameErrors(z.string().max(5), "abcdef", "strMax");
  });

  it("length (too short)", () => {
    assertSameErrors(z.string().length(3), "ab", "strLen");
  });

  it("length (too long)", () => {
    assertSameErrors(z.string().length(3), "abcd", "strLen");
  });

  it("email format", () => {
    assertSameErrors(z.email(), "not-an-email", "email");
  });

  it("uuid format", () => {
    assertSameErrors(z.uuid(), "not-a-uuid", "uuid");
  });

  it("url format", () => {
    assertSameErrors(z.url(), "not-a-url", "url");
  });

  it("regex pattern", () => {
    assertSameErrors(z.string().regex(/^[A-Z]+$/), "abc", "regex");
  });
});

// ─── Number Check Errors ────────────────────────────────────────────────────

describe("error compat — number checks", () => {
  it("greater_than inclusive (min)", () => {
    assertSameErrors(z.number().min(5), 4, "numMin");
  });

  it("greater_than exclusive (positive / gt(0))", () => {
    assertSameErrors(z.number().positive(), 0, "numPos");
  });

  it("less_than inclusive (max)", () => {
    assertSameErrors(z.number().max(10), 11, "numMax");
  });

  it("less_than exclusive (negative / lt(0))", () => {
    assertSameErrors(z.number().negative(), 0, "numNeg");
  });

  it("multiple_of", () => {
    assertSameErrors(z.number().multipleOf(3), 7, "numMul");
  });
});

// ─── BigInt Check Errors ────────────────────────────────────────────────────

describe("error compat — bigint checks", () => {
  it("greater_than inclusive", () => {
    assertSameErrors(z.bigint().min(10n), 9n, "biMin");
  });

  it("greater_than exclusive", () => {
    assertSameErrors(z.bigint().positive(), 0n, "biPos");
  });

  it("less_than inclusive", () => {
    assertSameErrors(z.bigint().max(100n), 101n, "biMax");
  });

  it("less_than exclusive", () => {
    assertSameErrors(z.bigint().negative(), 0n, "biNeg");
  });

  it("multiple_of", () => {
    assertSameErrors(z.bigint().multipleOf(3n), 7n, "biMul");
  });
});

// ─── Date Check Errors ──────────────────────────────────────────────────────

describe("error compat — date checks", () => {
  // Zod v4.0-4.2 emits minimum/maximum as Date objects; v4.3+ emits numbers.
  // zod-compiler emits numbers (matching v4.3+), so skip these tests on older versions.
  it.skipIf(!zodAtLeast("4.3"))("min date", () => {
    assertSameErrors(z.date().min(new Date("2024-01-01")), new Date("2023-12-31"), "dtMin");
  });

  it.skipIf(!zodAtLeast("4.3"))("max date", () => {
    assertSameErrors(z.date().max(new Date("2024-12-31")), new Date("2025-01-01"), "dtMax");
  });

  it("invalid date", () => {
    assertSameErrors(z.date(), new Date("invalid"), "dtInvalid");
  });
});

// ─── Enum / Literal / Union Errors ──────────────────────────────────────────

describe("error compat — enum", () => {
  it("invalid enum value (string)", () => {
    assertSameErrors(z.enum(["a", "b", "c"]), "d", "enumStr");
  });

  it("invalid enum value (number input)", () => {
    assertSameErrors(z.enum(["a", "b"]), 42, "enumNum");
  });
});

describe("error compat — literal", () => {
  it("invalid literal (string)", () => {
    assertSameErrors(z.literal("hello"), "world", "litStr");
  });

  it("invalid literal (number)", () => {
    assertSameErrors(z.literal(42), 43, "litNum");
  });

  it("invalid literal (boolean)", () => {
    assertSameErrors(z.literal(true), false, "litBool");
  });
});

describe("error compat — union", () => {
  it("invalid union", () => {
    assertSameErrors(z.union([z.string(), z.number()]), true, "union");
  });
});

// ─── Array Check Errors ─────────────────────────────────────────────────────

describe("error compat — array checks", () => {
  it("min length", () => {
    assertSameErrors(z.array(z.string()).min(2), ["a"], "arrMin");
  });

  it("max length", () => {
    assertSameErrors(z.array(z.string()).max(2), ["a", "b", "c"], "arrMax");
  });

  it("exact length (too short)", () => {
    assertSameErrors(z.array(z.string()).length(3), ["a", "b"], "arrLen");
  });

  it("exact length (too long)", () => {
    assertSameErrors(z.array(z.string()).length(3), ["a", "b", "c", "d"], "arrLen");
  });

  it("invalid element type", () => {
    assertSameErrors(z.array(z.number()), [1, "two", 3], "arrElem");
  });
});

// ─── Set Check Errors ───────────────────────────────────────────────────────

describe("error compat — set checks", () => {
  it("type error", () => {
    assertSameErrors(z.set(z.string()), "not a set", "setType");
  });

  // Zod v4.0 omits `inclusive` on set size checks; v4.1+ includes it.
  it.skipIf(!zodAtLeast("4.1"))("min size", () => {
    assertSameErrors(z.set(z.string()).min(2), new Set(["a"]), "setMin");
  });

  it.skipIf(!zodAtLeast("4.1"))("max size", () => {
    assertSameErrors(z.set(z.string()).max(2), new Set(["a", "b", "c"]), "setMax");
  });
});

// ─── Map Check Errors ───────────────────────────────────────────────────────

describe("error compat — map checks", () => {
  it("type error", () => {
    assertSameErrors(z.map(z.string(), z.number()), "not a map", "mapType");
  });
});

// ─── Object Nested Errors ───────────────────────────────────────────────────

describe("error compat — nested object errors", () => {
  it("missing required field", () => {
    assertSameErrors(
      z.object({ name: z.string(), age: z.number() }),
      { name: "Alice" },
      "objMissing",
    );
  });

  it("wrong field type", () => {
    assertSameErrors(
      z.object({ name: z.string(), age: z.number() }),
      { name: 42, age: "not number" },
      "objWrongType",
    );
  });

  it("deep nested error", () => {
    assertSameErrors(
      z.object({ user: z.object({ name: z.string().min(3) }) }),
      { user: { name: "ab" } },
      "objDeep",
    );
  });
});

// ─── Tuple Errors ───────────────────────────────────────────────────────────

describe("error compat — tuple errors", () => {
  it("type error", () => {
    assertSameErrors(z.tuple([z.string(), z.number()]), "not array", "tuple");
  });

  it("wrong element type", () => {
    assertSameErrors(z.tuple([z.string(), z.number()]), [42, "hello"], "tuple");
  });

  // Zod 4.4 changed too-short tuple errors from invalid_type to too_small.
  // zod-compiler matches the 4.4+ behavior; skip on older versions.
  it.skipIf(!zodAtLeast("4.4"))("too few elements", () => {
    assertSameErrors(z.tuple([z.string(), z.number()]), ["hello"], "tuple");
  });
});

// ─── Record Errors ──────────────────────────────────────────────────────────

describe("error compat — record errors", () => {
  it("type error", () => {
    assertSameErrors(z.record(z.string(), z.number()), "not object", "rec");
  });

  it("invalid value type", () => {
    assertSameErrors(z.record(z.string(), z.number()), { a: "not number" }, "rec");
  });
});

// ─── Discriminated Union Errors ─────────────────────────────────────────────

describe("error compat — discriminated union errors", () => {
  const schema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("a"), value: z.string() }),
    z.object({ type: z.literal("b"), count: z.number() }),
  ]);

  it("type error (not object)", () => {
    assertSameErrors(schema, "not object", "du");
  });

  // Zod v4.0 omits `discriminator` field; v4.1+ includes it.
  it.skipIf(!zodAtLeast("4.1"))("invalid discriminator value", () => {
    assertSameErrors(schema, { type: "c" }, "du");
  });

  it("valid discriminator, wrong field type", () => {
    assertSameErrors(schema, { type: "a", value: 42 }, "du");
  });
});

// ─── Intersection Errors ────────────────────────────────────────────────────

describe("error compat — intersection errors", () => {
  it("missing fields from both sides", () => {
    assertSameErrors(
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
      {},
      "inter",
    );
  });
});

// ─── Lazy Schema Errors ──────────────────────────────────────────────────────

describe("error compat — lazy (non-recursive)", () => {
  it("lazy string receives number", () => {
    assertSameErrors(
      z.lazy(() => z.string()),
      42,
      "lazyStr",
    );
  });

  it("lazy string.min() too short", () => {
    assertSameErrors(
      z.lazy(() => z.string().min(3)),
      "ab",
      "lazyStrMin",
    );
  });

  it("lazy number receives string", () => {
    assertSameErrors(
      z.lazy(() => z.number()),
      "hello",
      "lazyNum",
    );
  });

  it("lazy object missing field", () => {
    assertSameErrors(
      z.lazy(() => z.object({ name: z.string(), age: z.number() })),
      { name: "Alice" },
      "lazyObj",
    );
  });

  it("lazy inside object property", () => {
    const schema = z.object({
      label: z.lazy(() => z.string().min(1)),
      count: z.number(),
    });
    assertSameErrors(schema, { label: "", count: 5 }, "lazyProp");
  });

  it("lazy inside array element", () => {
    const schema = z.array(z.lazy(() => z.number()));
    assertSameErrors(schema, [1, "two", 3], "lazyArr");
  });
});

describe("error compat — lazy (recursive with fallback)", () => {
  const TreeNode: z.ZodType = z.object({
    value: z.string(),
    children: z.array(z.lazy(() => TreeNode)),
  });

  it("invalid root type", () => {
    assertSameErrors(TreeNode, "not object", "tree");
  });

  it("invalid root value type", () => {
    assertSameErrors(TreeNode, { value: 42, children: [] }, "tree");
  });

  it("invalid children type", () => {
    assertSameErrors(TreeNode, { value: "root", children: "not array" }, "tree");
  });
});

// ─── Combined Schema Errors ─────────────────────────────────────────────────

describe("error compat — combined real-world schemas", () => {
  it("user registration with multiple errors", () => {
    const schema = z.object({
      username: z.string().min(3).max(20),
      email: z.email(),
      age: z.number().int().positive(),
      role: z.enum(["user", "admin"]),
    });

    assertSameErrors(
      schema,
      { username: "ab", email: "not-email", age: -1, role: "superadmin" },
      "userReg",
    );
  });
});

// ─── ZodError Parity ──────────────────────────────────────────────────────────

describe("ZodError parity — basics", () => {
  it("safeParse error is instanceof ZodError and ZodRealError", () => {
    const safeParse = compileForErrorTest(z.string(), "str");
    const result = safeParse(42);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
      expect(result.error).toBeInstanceOf(ZodRealError);
    }
  });

  it("error instanceof Error (ZodRealError extends Error)", () => {
    const safeParse = compileForErrorTest(z.string(), "str");
    const result = safeParse(42);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("success result has no error", () => {
    const safeParse = compileForErrorTest(z.string(), "str");
    const result = safeParse("hello");
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("error.issues is accessible and non-empty", () => {
    const safeParse = compileForErrorTest(z.string(), "str");
    const result = safeParse(42);
    if (!result.success) {
      expect(Array.isArray(result.error?.issues)).toBe(true);
      expect(result.error?.issues.length).toBeGreaterThan(0);
    }
  });

  it("error.message is a non-empty string", () => {
    const safeParse = compileForErrorTest(z.string(), "str");
    const result = safeParse(42);
    if (!result.success) {
      expect(typeof result.error?.message).toBe("string");
      expect((result.error?.message as string | undefined)?.length).toBeGreaterThan(0);
    }
  });

  it("error.message is JSON of issues (same as Zod)", () => {
    const schema = z.string();
    const zodResult = schema.safeParse(42);
    const safeParse = compileForErrorTest(schema, "str");
    const aotResult = safeParse(42);
    if (!zodResult.success && !aotResult.success) {
      // Both should be parseable JSON
      const zodParsed = JSON.parse(zodResult.error.message);
      const aotParsed = JSON.parse(aotResult.error?.message ?? "[]");
      // Same number of issues
      expect(aotParsed.length).toBe(zodParsed.length);
    }
  });

  it("error.name matches Zod", () => {
    const zodResult = z.string().safeParse(42);
    const safeParse = compileForErrorTest(z.string(), "str");
    const aotResult = safeParse(42);
    if (!zodResult.success && !aotResult.success) {
      expect(aotResult.error?.name).toBe(zodResult.error.name);
    }
  });

  it("error.toString() returns message", () => {
    const safeParse = compileForErrorTest(z.string(), "str");
    const result = safeParse(42);
    if (!result.success) {
      expect(result.error?.toString()).toBe(result.error?.message);
    }
  });
});

describe("ZodError parity — format()", () => {
  it("simple schema type error", () => {
    const schema = z.string().min(3);
    const zodResult = schema.safeParse(42);
    const safeParse = compileForErrorTest(schema, "str");
    const aotResult = safeParse(42);
    if (!zodResult.success && !aotResult.success) {
      const zodFormatted = zodResult.error.format();
      const aotFormatted = (aotResult.error as ZodError).format();
      expect(aotFormatted._errors.length).toBeGreaterThan(0);
      expect(aotFormatted._errors.length).toBe(zodFormatted._errors.length);
    }
  });

  it("object with multiple wrong fields", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const zodResult = schema.safeParse({ name: 42, age: "hello" });
    const safeParse = compileForErrorTest(schema, "obj");
    const aotResult = safeParse({ name: 42, age: "hello" });
    if (!zodResult.success && !aotResult.success) {
      const zodFmt = zodResult.error.format();
      const aotFmt = (aotResult.error as ZodError).format();
      expect("name" in aotFmt).toBe("name" in zodFmt);
      expect("age" in aotFmt).toBe("age" in zodFmt);
    }
  });

  it("deeply nested object (3 levels)", () => {
    const schema = z.object({
      level1: z.object({
        level2: z.object({
          value: z.number(),
        }),
      }),
    });
    const zodResult = schema.safeParse({ level1: { level2: { value: "bad" } } });
    const safeParse = compileForErrorTest(schema, "deep");
    const aotResult = safeParse({ level1: { level2: { value: "bad" } } });
    if (!zodResult.success && !aotResult.success) {
      const zodFmt = zodResult.error.format();
      const aotFmt = (aotResult.error as ZodError).format();
      expect("level1" in aotFmt).toBe("level1" in zodFmt);
    }
  });

  it("array element errors appear in format()", () => {
    const schema = z.array(z.number());
    const zodResult = schema.safeParse([1, "bad", 3]);
    const safeParse = compileForErrorTest(schema, "arr");
    const aotResult = safeParse([1, "bad", 3]);
    if (!zodResult.success && !aotResult.success) {
      const zodFmt = zodResult.error.format();
      const aotFmt = (aotResult.error as ZodError).format();
      // Both should have error at index 1
      expect("1" in aotFmt || 1 in aotFmt).toBe("1" in zodFmt || 1 in zodFmt);
    }
  });

  it("object with missing and wrong-type fields", () => {
    const schema = z.object({ name: z.string(), age: z.number(), active: z.boolean() });
    const zodResult = schema.safeParse({ name: 42 });
    const safeParse = compileForErrorTest(schema, "multi");
    const aotResult = safeParse({ name: 42 });
    if (!zodResult.success && !aotResult.success) {
      const zodFmt = zodResult.error.format();
      const aotFmt = (aotResult.error as ZodError).format();
      expect("name" in aotFmt).toBe("name" in zodFmt);
      expect("age" in aotFmt).toBe("age" in zodFmt);
      expect("active" in aotFmt).toBe("active" in zodFmt);
    }
  });
});

describe("ZodError parity — flatten()", () => {
  it("simple type error goes to formErrors", () => {
    const schema = z.string();
    const zodResult = schema.safeParse(42);
    const safeParse = compileForErrorTest(schema, "str");
    const aotResult = safeParse(42);
    if (!zodResult.success && !aotResult.success) {
      const zodFlat = zodResult.error.flatten();
      const aotFlat = (aotResult.error as ZodError).flatten();
      expect(aotFlat.formErrors.length).toBe(zodFlat.formErrors.length);
      expect(Object.keys(aotFlat.fieldErrors).length).toBe(Object.keys(zodFlat.fieldErrors).length);
    }
  });

  it("object field errors go to fieldErrors", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const zodResult = schema.safeParse({ name: 42, age: "hello" });
    const safeParse = compileForErrorTest(schema, "obj");
    const aotResult = safeParse({ name: 42, age: "hello" });
    if (!zodResult.success && !aotResult.success) {
      const zodFlat = zodResult.error.flatten();
      const aotFlat = (aotResult.error as ZodError).flatten();
      expect(Object.keys(aotFlat.fieldErrors).sort()).toEqual(
        Object.keys(zodFlat.fieldErrors).sort(),
      );
      expect(aotFlat.formErrors.length).toBe(zodFlat.formErrors.length);
    }
  });

  it("flatten with custom mapper", () => {
    const schema = z.object({ name: z.string() });
    const safeParse = compileForErrorTest(schema, "obj");
    const result = safeParse({ name: 42 });
    if (!result.success) {
      const flat = (result.error as ZodError).flatten((issue) => issue.code);
      const fieldErrors = flat.fieldErrors as Record<string, string[]>;
      expect(fieldErrors["name"]).toBeDefined();
      expect(fieldErrors["name"]?.[0]).toBe("invalid_type");
    }
  });
});

describe("ZodError parity — schema types", () => {
  it("number check errors produce ZodError", () => {
    const safeParse = compileForErrorTest(z.number().min(5), "num");
    const result = safeParse(2);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
      expect(result.error?.issues[0]?.code).toBe("too_small");
    }
  });

  it("enum errors produce ZodError", () => {
    const safeParse = compileForErrorTest(z.enum(["a", "b"]), "en");
    const result = safeParse("c");
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });

  it("literal errors produce ZodError", () => {
    const safeParse = compileForErrorTest(z.literal("hello"), "lit");
    const result = safeParse("world");
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });

  it("boolean type error produces ZodError", () => {
    const safeParse = compileForErrorTest(z.boolean(), "bool");
    const result = safeParse("not bool");
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });

  it("bigint type error produces ZodError", () => {
    const safeParse = compileForErrorTest(z.bigint(), "bi");
    const result = safeParse(42);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });

  it("date type error produces ZodError", () => {
    const safeParse = compileForErrorTest(z.date(), "dt");
    const result = safeParse("not a date");
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });

  it("nullable inner error produces ZodError", () => {
    const safeParse = compileForErrorTest(z.string().nullable(), "nul");
    const result = safeParse(42);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });

  it("optional inner error produces ZodError", () => {
    const safeParse = compileForErrorTest(z.string().optional(), "opt");
    const result = safeParse(42);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });

  it("tuple errors produce ZodError", () => {
    const safeParse = compileForErrorTest(z.tuple([z.string(), z.number()]), "tup");
    const result = safeParse([42, "wrong"]);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
      expect(result.error?.issues.length).toBe(2);
    }
  });

  it("record value error produces ZodError", () => {
    const safeParse = compileForErrorTest(z.record(z.string(), z.number()), "rec");
    const result = safeParse({ key: "not number" });
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });

  it("intersection errors produce ZodError", () => {
    const schema = z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }));
    const safeParse = compileForErrorTest(schema, "inter");
    const result = safeParse({});
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
      expect(result.error?.issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("discriminatedUnion errors produce ZodError", () => {
    const schema = z.discriminatedUnion("type", [
      z.object({ type: z.literal("a"), v: z.string() }),
      z.object({ type: z.literal("b"), v: z.number() }),
    ]);
    const safeParse = compileForErrorTest(schema, "du");
    const result = safeParse({ type: "a", v: 42 });
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });

  it("set type error produces ZodError", () => {
    const safeParse = compileForErrorTest(z.set(z.string()), "setErr");
    const result = safeParse("not a set");
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });

  it("map type error produces ZodError", () => {
    const safeParse = compileForErrorTest(z.map(z.string(), z.number()), "mapErr");
    const result = safeParse("not a map");
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });

  it("never schema always produces ZodError", () => {
    const safeParse = compileForErrorTest(z.never(), "nev");
    const result = safeParse("anything");
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });

  it("coerce string failure produces ZodError", () => {
    const safeParse = compileForErrorTest(z.coerce.string().min(5), "coerceStr");
    const result = safeParse("ab");
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });
});

describe("ZodError parity — union", () => {
  it("union error has issues", () => {
    const schema = z.union([z.string(), z.number()]);
    const safeParse = compileForErrorTest(schema, "union");
    const result = safeParse(true);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
      expect(result.error?.issues.length).toBeGreaterThan(0);
    }
  });

  it("union error issue count matches Zod", () => {
    const schema = z.union([z.string(), z.number()]);
    const zodResult = schema.safeParse(true);
    const safeParse = compileForErrorTest(schema, "union");
    const aotResult = safeParse(true);
    if (!zodResult.success && !aotResult.success) {
      expect(aotResult.error?.issues.length).toBe(zodResult.error.issues.length);
    }
  });

  it("three-way union error", () => {
    const schema = z.union([z.string(), z.number(), z.boolean()]);
    const safeParse = compileForErrorTest(schema, "tri");
    const result = safeParse(null);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
    }
  });
});

describe("ZodError parity — real-world combined", () => {
  it("user form with all fields invalid", () => {
    const schema = z.object({
      username: z.string().min(3).max(20),
      email: z.email(),
      age: z.number().int().positive(),
      role: z.enum(["user", "admin"]),
    });
    const safeParse = compileForErrorTest(schema, "form");
    const result = safeParse({
      username: "ab",
      email: "not-email",
      age: -1.5,
      role: "superadmin",
    });
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
      // format() should group errors by field
      const formatted = (result.error as ZodError).format();
      expect("username" in formatted).toBe(true);
      expect("email" in formatted).toBe(true);
      expect("age" in formatted).toBe(true);
      expect("role" in formatted).toBe(true);
      // flatten() should have all fields
      const flat = (result.error as ZodError).flatten();
      expect(Object.keys(flat.fieldErrors).sort()).toEqual(["age", "email", "role", "username"]);
    }
  });

  it("nested API response schema", () => {
    const schema = z.object({
      status: z.number(),
      data: z.object({
        users: z.array(
          z.object({
            id: z.number(),
            name: z.string().min(1),
          }),
        ),
      }),
    });
    const safeParse = compileForErrorTest(schema, "api");
    const result = safeParse({
      status: "ok",
      data: { users: [{ id: "bad", name: "" }] },
    });
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
      // Should have errors for status, data.users[0].id, data.users[0].name
      expect(result.error?.issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("completely wrong type still produces valid ZodError", () => {
    const schema = z.object({ a: z.string() });
    const safeParse = compileForErrorTest(schema, "wrongType");
    for (const input of [42, "string", true, null, undefined, []]) {
      const result = safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(ZodError);
        expect(result.error?.issues.length).toBeGreaterThan(0);
        expect(typeof result.error?.message).toBe("string");
      }
    }
  });
});
